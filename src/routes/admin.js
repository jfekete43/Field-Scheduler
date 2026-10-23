'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { db, getSettings, setSetting, logAction, UPLOAD_DIR } = require('../db');
const schedule = require('../schedule');
const auth = require('../auth');
const { locationsWithFields } = require('./public');

const router = express.Router();

/* ---------------------------------------------------------------- *
 * Uploads: images only, 6 MB cap, random filenames
 * ---------------------------------------------------------------- */

const ALLOWED_IMAGE = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/svg+xml', '.svg'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = ALLOWED_IMAGE.get(file.mimetype) || '.bin';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.has(file.mimetype)) {
      return cb(Object.assign(new Error('Upload a PNG, JPG, WEBP, GIF or SVG image.'), { status: 400 }));
    }
    return cb(null, true);
  },
});

function removeUpload(storedPath) {
  if (!storedPath) return;
  const name = path.basename(storedPath);
  const target = path.join(UPLOAD_DIR, name);
  if (target.startsWith(UPLOAD_DIR)) {
    fs.promises.unlink(target).catch(() => {});
  }
}

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

function wrap(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

function intParam(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw Object.assign(new Error(`Invalid ${name}.`), { status: 400 });
  }
  return n;
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

/** Keeps the existing order when the box was left blank. */
function sortOrderOr(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * Account management is owner-only. Without this any admin could reset the
 * owner's password or delete every other account and take over the site.
 */
function requireOwner(req, _res, next) {
  if (req.user?.role !== 'owner') {
    return next(
      Object.assign(new Error('Only an owner can manage admin accounts.'), { status: 403 })
    );
  }
  return next();
}

function allowConflictFlag(req) {
  return truthy(req.body?.allowConflict ?? req.query?.allowConflict);
}

function eventLabel(event) {
  const vs = [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ');
  return `${event.locationName}/${event.fieldName} ${event.date} ${event.startTime} ${event.title || vs || event.eventType}`;
}

/* ---------------------------------------------------------------- *
 * Events
 * ---------------------------------------------------------------- */

router.post(
  '/events',
  wrap((req, res) => {
    const repeatCount = Number(req.body.repeatCount ?? 1);
    if (repeatCount > 1) {
      const result = schedule.createSeries(req.body, req.user, { allowConflict: allowConflictFlag(req) });
      logAction(
        req.user,
        'create_series',
        'events',
        result.seriesId || '',
        `${result.created.length} events, ${result.skipped.length} skipped`
      );
      return res.status(201).json({
        events: result.created,
        skipped: result.skipped,
        seriesId: result.seriesId,
      });
    }
    const event = schedule.createEvent(req.body, req.user, { allowConflict: allowConflictFlag(req) });
    logAction(req.user, 'create_event', 'events', event.id, eventLabel(event));
    return res.status(201).json({ event });
  })
);

router.put(
  '/events/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'event id');
    const event = schedule.updateEvent(id, req.body, req.user, {
      allowConflict: allowConflictFlag(req),
    });
    logAction(req.user, 'update_event', 'events', id, eventLabel(event));
    res.json({ event });
  })
);

router.delete(
  '/events/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'event id');
    const removed = schedule.deleteEvent(id);
    logAction(req.user, 'delete_event', 'events', id, eventLabel(removed));
    res.json({ ok: true, event: removed });
  })
);

/** Deletes a repeating series, optionally only the dates from `from` onward. */
router.delete(
  '/series/:seriesId',
  wrap((req, res) => {
    const seriesId = String(req.params.seriesId || '').slice(0, 64);
    if (!seriesId) throw Object.assign(new Error('Invalid series id.'), { status: 400 });
    // A malformed ?from used to fall back to null, which deletes the whole
    // series rather than the tail the admin asked for.
    if (req.query.from !== undefined && !schedule.isRealDate(req.query.from)) {
      throw Object.assign(new Error('That is not a valid date to delete from.'), { status: 400 });
    }
    const fromDate = req.query.from === undefined ? null : req.query.from;
    const count = schedule.deleteSeries(seriesId, { fromDate });
    logAction(req.user, 'delete_series', 'events', seriesId, `removed ${count}${fromDate ? ` from ${fromDate}` : ''}`);
    res.json({ ok: true, removed: count });
  })
);

/**
 * Bulk status change, used for rain-outs.
 *
 * Takes the exact fields to act on, because a rain-out is rarely all-or-nothing:
 * the indoor cages play through anything, and turf drains when grass does not.
 * `locationId` is still accepted to mean "every field at this location".
 */
router.post(
  '/events/bulk-status',
  wrap((req, res) => {
    const status = String(req.body.status || '').trim();
    if (!schedule.STATUSES.some((s) => s.value === status)) {
      throw Object.assign(new Error('Choose a valid status.'), { status: 400 });
    }
    const date = req.body.date;
    if (!schedule.isRealDate(date)) throw Object.assign(new Error('Enter a valid date.'), { status: 400 });

    let fieldIds = null;

    if (req.body.fieldIds !== undefined) {
      if (!Array.isArray(req.body.fieldIds)) {
        throw Object.assign(new Error('Choose which fields are affected.'), { status: 400 });
      }
      fieldIds = [...new Set(req.body.fieldIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
      if (!fieldIds.length) {
        throw Object.assign(new Error('Pick at least one field.'), { status: 400 });
      }
    } else if (req.body.locationId) {
      const locationId = intParam(req.body.locationId, 'location id');
      fieldIds = db
        .prepare('SELECT id FROM fields WHERE location_id = ?')
        .all(locationId)
        .map((f) => f.id);
      if (!fieldIds.length) return res.json({ ok: true, updated: 0 });
    }

    let changes;
    if (fieldIds) {
      const holes = fieldIds.map(() => '?').join(',');
      changes = db
        .prepare(
          `UPDATE events SET status = ?, updated_at = datetime('now')
            WHERE event_date = ? AND field_id IN (${holes})`
        )
        .run(status, date, ...fieldIds).changes;
    } else {
      changes = db
        .prepare("UPDATE events SET status = ?, updated_at = datetime('now') WHERE event_date = ?")
        .run(status, date).changes;
    }

    logAction(
      req.user,
      'bulk_status',
      'events',
      date,
      `${status} x${changes}${fieldIds ? ` fields=${fieldIds.length}` : ' (all fields)'}`
    );
    res.json({ ok: true, updated: changes });
  })
);

/* ---------------------------------------------------------------- *
 * Locations
 * ---------------------------------------------------------------- */

router.post(
  '/locations',
  wrap((req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Enter a location name.'), { status: 400 });
    let slug = slugify(req.body.slug || name, 'location');
    if (db.prepare('SELECT 1 FROM locations WHERE slug = ?').get(slug)) {
      slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    }
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM locations').get().n;
    const info = db
      .prepare(
        `INSERT INTO locations (slug, name, address, maps_query, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        name,
        String(req.body.address || '').trim().slice(0, 240),
        String(req.body.mapsQuery || req.body.address || name).trim().slice(0, 240),
        String(req.body.notes || '').trim().slice(0, 500),
        maxOrder + 1
      );
    logAction(req.user, 'create_location', 'locations', info.lastInsertRowid, name);
    res.status(201).json({ locations: locationsWithFields({ includeInactive: true }) });
  })
);

router.put(
  '/locations/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'location id');
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('That location no longer exists.'), { status: 404 });

    const name = String(req.body.name ?? existing.name).trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Enter a location name.'), { status: 400 });

    const lat = req.body.latitude === '' || req.body.latitude == null ? null : Number(req.body.latitude);
    const lng = req.body.longitude === '' || req.body.longitude == null ? null : Number(req.body.longitude);
    if (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      throw Object.assign(new Error('Latitude must be between -90 and 90.'), { status: 400 });
    }
    if (lng != null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
      throw Object.assign(new Error('Longitude must be between -180 and 180.'), { status: 400 });
    }

    db.prepare(
      `UPDATE locations SET name = ?, address = ?, maps_query = ?, notes = ?,
              latitude = ?, longitude = ?, sort_order = ?
        WHERE id = ?`
    ).run(
      name,
      String(req.body.address ?? existing.address).trim().slice(0, 240),
      String(req.body.mapsQuery ?? existing.maps_query).trim().slice(0, 240),
      String(req.body.notes ?? existing.notes).trim().slice(0, 500),
      lat,
      lng,
      sortOrderOr(req.body.sortOrder, existing.sort_order),
      id
    );
    logAction(req.user, 'update_location', 'locations', id, name);
    res.json({ locations: locationsWithFields({ includeInactive: true }) });
  })
);

router.delete(
  '/locations/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'location id');
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    const eventCount = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE field_id IN (SELECT id FROM fields WHERE location_id = ?)')
      .get(id).n;
    if (eventCount && !truthy(req.query.force)) {
      throw Object.assign(
        new Error(`${existing.name} still has ${eventCount} scheduled event(s). Remove them first, or confirm deletion.`),
        { status: 409, eventCount }
      );
    }
    removeUpload(existing.map_image);
    db.prepare('DELETE FROM locations WHERE id = ?').run(id);
    logAction(req.user, 'delete_location', 'locations', id, `${existing.name} (+${eventCount} events)`);
    res.json({ ok: true, locations: locationsWithFields({ includeInactive: true }) });
  })
);

/** Field map image upload. */
router.post(
  '/locations/:id/map',
  upload.single('image'),
  wrap((req, res) => {
    // multer has already written the file by now, so every rejection path
    // below has to remove it or it is orphaned on disk forever.
    let id;
    try {
      id = intParam(req.params.id, 'location id');
    } catch (err) {
      removeUpload(req.file?.filename);
      throw err;
    }
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!existing) {
      removeUpload(req.file?.filename);
      throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    }
    if (!req.file) throw Object.assign(new Error('Choose an image to upload.'), { status: 400 });

    removeUpload(existing.map_image);
    const stored = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE locations SET map_image = ? WHERE id = ?').run(stored, id);
    logAction(req.user, 'upload_field_map', 'locations', id, stored);
    res.json({ mapImage: stored, locations: locationsWithFields({ includeInactive: true }) });
  })
);

router.delete(
  '/locations/:id/map',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'location id');
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    removeUpload(existing.map_image);
    db.prepare('UPDATE locations SET map_image = NULL WHERE id = ?').run(id);
    db.prepare('DELETE FROM field_map_pins WHERE location_id = ?').run(id);
    logAction(req.user, 'remove_field_map', 'locations', id, existing.name);
    res.json({ ok: true, locations: locationsWithFields({ includeInactive: true }) });
  })
);

/* ---------------------------------------------------------------- *
 * Field map pins (the labels placed on an uploaded map)
 * ---------------------------------------------------------------- */

router.put(
  '/locations/:id/pins',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'location id');
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) {
      throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    }
    // Required explicitly. Falling back to [] would wipe every label on this
    // map if the body ever arrived without the array.
    if (!Array.isArray(req.body.pins)) {
      throw Object.assign(new Error('No map labels were submitted.'), { status: 400 });
    }
    const pins = req.body.pins;
    if (pins.length > 60) throw Object.assign(new Error('A map can hold at most 60 labels.'), { status: 400 });

    const validFieldIds = new Set(
      db.prepare('SELECT id FROM fields WHERE location_id = ?').all(id).map((f) => f.id)
    );

    const clean = pins.map((pin) => {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
        throw Object.assign(new Error('That map label is not in a readable form.'), { status: 400 });
      }
      const label = String(pin.label || '').trim().slice(0, 60);
      if (!label) throw Object.assign(new Error('Every map label needs text.'), { status: 400 });
      const x = Number(pin.x);
      const y = Number(pin.y);
      if (!Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100) {
        throw Object.assign(new Error('Map labels must sit inside the image.'), { status: 400 });
      }
      const fieldId = pin.fieldId ? Number(pin.fieldId) : null;
      // A label may only point at a field that belongs to this location,
      // otherwise the insert fails the foreign key and returns a 500.
      const linkedFieldId =
        Number.isInteger(fieldId) && validFieldIds.has(fieldId) ? fieldId : null;
      const color = /^#[0-9a-fA-F]{6}$/.test(String(pin.color || '')) ? pin.color : '#1d4ed8';
      return { label, x, y, fieldId: linkedFieldId, color };
    });

    db.transaction(() => {
      db.prepare('DELETE FROM field_map_pins WHERE location_id = ?').run(id);
      const insert = db.prepare(
        `INSERT INTO field_map_pins (location_id, field_id, label, x_pct, y_pct, color)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const pin of clean) insert.run(id, pin.fieldId, pin.label, pin.x, pin.y, pin.color);
    })();

    logAction(req.user, 'update_field_map_pins', 'locations', id, `${clean.length} labels`);
    res.json({ locations: locationsWithFields({ includeInactive: true }) });
  })
);

/* ---------------------------------------------------------------- *
 * Fields
 * ---------------------------------------------------------------- */

router.post(
  '/fields',
  wrap((req, res) => {
    const locationId = intParam(req.body.locationId, 'location id');
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) {
      throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    }
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Enter a field name.'), { status: 400 });

    let slug = slugify(name, 'field');
    if (db.prepare('SELECT 1 FROM fields WHERE location_id = ? AND slug = ?').get(locationId, slug)) {
      slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    }
    const kind = schedule.FIELD_KINDS.some((k) => k.value === req.body.kind) ? req.body.kind : 'baseball';
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM fields WHERE location_id = ?')
      .get(locationId).n;

    const info = db
      .prepare(
        `INSERT INTO fields (location_id, slug, name, kind, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(locationId, slug, name, kind, String(req.body.notes || '').trim().slice(0, 300), maxOrder + 1);

    logAction(req.user, 'create_field', 'fields', info.lastInsertRowid, name);
    res.status(201).json({ locations: locationsWithFields({ includeInactive: true }) });
  })
);

router.put(
  '/fields/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'field id');
    const existing = db.prepare('SELECT * FROM fields WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('That field no longer exists.'), { status: 404 });

    const name = String(req.body.name ?? existing.name).trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Enter a field name.'), { status: 400 });
    const kind = schedule.FIELD_KINDS.some((k) => k.value === req.body.kind) ? req.body.kind : existing.kind;

    db.prepare(
      'UPDATE fields SET name = ?, kind = ?, notes = ?, sort_order = ?, active = ? WHERE id = ?'
    ).run(
      name,
      kind,
      String(req.body.notes ?? existing.notes).trim().slice(0, 300),
      sortOrderOr(req.body.sortOrder, existing.sort_order),
      req.body.active === undefined ? existing.active : truthy(req.body.active) ? 1 : 0,
      id
    );
    logAction(req.user, 'update_field', 'fields', id, name);
    res.json({ locations: locationsWithFields({ includeInactive: true }) });
  })
);

router.delete(
  '/fields/:id',
  wrap((req, res) => {
    const id = intParam(req.params.id, 'field id');
    const existing = db.prepare('SELECT * FROM fields WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('That field no longer exists.'), { status: 404 });
    const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events WHERE field_id = ?').get(id).n;
    if (eventCount && !truthy(req.query.force)) {
      throw Object.assign(
        new Error(
          `${existing.name} still has ${eventCount} scheduled event(s). Mark it inactive to hide it, or confirm deletion.`
        ),
        { status: 409, eventCount }
      );
    }
    db.prepare('DELETE FROM fields WHERE id = ?').run(id);
    logAction(req.user, 'delete_field', 'fields', id, `${existing.name} (+${eventCount} events)`);
    res.json({ ok: true, locations: locationsWithFields({ includeInactive: true }) });
  })
);

/* ---------------------------------------------------------------- *
 * Settings and branding
 * ---------------------------------------------------------------- */

const EDITABLE_SETTINGS = [
  'league_name',
  'league_short',
  'timezone',
  'announcement',
  'announcement_level',
  'contact_email',
  'season_label',
];

router.put(
  '/settings',
  wrap((req, res) => {
    const incoming = req.body || {};
    const map = {
      leagueName: 'league_name',
      leagueShort: 'league_short',
      timezone: 'timezone',
      announcement: 'announcement',
      announcementLevel: 'announcement_level',
      contactEmail: 'contact_email',
      seasonLabel: 'season_label',
    };
    for (const [apiKey, dbKey] of Object.entries(map)) {
      if (incoming[apiKey] === undefined) continue;
      let value = String(incoming[apiKey]).slice(0, 500);
      if (dbKey === 'timezone') {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
        } catch {
          throw Object.assign(new Error(`"${value}" is not a valid timezone name.`), { status: 400 });
        }
      }
      if (dbKey === 'announcement_level' && !['info', 'warning', 'alert'].includes(value)) {
        value = 'info';
      }
      if (EDITABLE_SETTINGS.includes(dbKey)) setSetting(dbKey, value);
    }
    logAction(req.user, 'update_settings', 'settings', '', Object.keys(incoming).join(','));
    res.json({ settings: getSettings() });
  })
);

router.post(
  '/logo',
  upload.single('image'),
  wrap((req, res) => {
    if (!req.file) throw Object.assign(new Error('Choose an image to upload.'), { status: 400 });
    const current = getSettings().logo_path;
    removeUpload(current);
    const stored = `/uploads/${req.file.filename}`;
    setSetting('logo_path', stored);
    logAction(req.user, 'upload_logo', 'settings', '', stored);
    res.json({ logoPath: stored });
  })
);

router.delete(
  '/logo',
  wrap((req, res) => {
    removeUpload(getSettings().logo_path);
    setSetting('logo_path', '');
    logAction(req.user, 'remove_logo', 'settings', '', '');
    res.json({ ok: true, logoPath: '' });
  })
);

/* ---------------------------------------------------------------- *
 * Admin users
 * ---------------------------------------------------------------- */

router.get(
  '/users',
  wrap((_req, res) => {
    const users = db
      .prepare(
        `SELECT id, username, display_name, role, active, created_at, last_login_at
           FROM users ORDER BY username COLLATE NOCASE`
      )
      .all()
      .map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        active: !!u.active,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      }));
    res.json({ users });
  })
);

router.post(
  '/users',
  requireOwner,
  wrap((req, res) => {
    const created = auth.createUser({
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.displayName,
      role: req.body.role,
    });
    logAction(req.user, 'create_user', 'users', created.id, created.username);
    res.status(201).json({ user: auth.publicUser(created) });
  })
);

router.put(
  '/users/:id',
  requireOwner,
  wrap((req, res) => {
    const id = intParam(req.params.id, 'user id');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });

    const nextActive = req.body.active === undefined ? target.active : truthy(req.body.active) ? 1 : 0;
    if (!nextActive && target.id === req.user.id) {
      throw Object.assign(new Error('You cannot deactivate your own account.'), { status: 400 });
    }
    // Only a change that actually removes an active admin can strand the site.
    // Editing an account that is already inactive is always allowed.
    if (!nextActive && target.active && auth.countActiveAdmins() <= 1) {
      throw Object.assign(new Error('At least one active admin must remain.'), { status: 400 });
    }
    if (target.role === 'owner' && req.body.role === 'admin' && auth.countOwners() <= 1) {
      throw Object.assign(new Error('At least one owner must remain.'), { status: 400 });
    }

    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(
      String(req.body.displayName ?? target.display_name).trim().slice(0, 80),
      req.body.role === 'owner' ? 'owner' : req.body.role === 'admin' ? 'admin' : target.role,
      nextActive,
      id
    );
    logAction(req.user, 'update_user', 'users', id, target.username);
    res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  })
);

router.post(
  '/users/:id/password',
  requireOwner,
  wrap((req, res) => {
    const id = intParam(req.params.id, 'user id');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });
    auth.setPassword(id, req.body.password);
    // setPassword also signs that account out everywhere.
    logAction(req.user, 'reset_password', 'users', id, target.username);
    res.json({ ok: true });
  })
);

router.delete(
  '/users/:id',
  requireOwner,
  wrap((req, res) => {
    const id = intParam(req.params.id, 'user id');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });
    if (target.id === req.user.id) {
      throw Object.assign(new Error('You cannot delete your own account.'), { status: 400 });
    }
    // Deleting an already-inactive account never strands the site.
    if (target.active && auth.countActiveAdmins() <= 1) {
      throw Object.assign(new Error('At least one active admin must remain.'), { status: 400 });
    }
    if (target.role === 'owner' && auth.countOwners() <= 1) {
      throw Object.assign(new Error('At least one owner must remain.'), { status: 400 });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logAction(req.user, 'delete_user', 'users', id, target.username);
    res.json({ ok: true });
  })
);

/* ---------------------------------------------------------------- *
 * Activity log
 * ---------------------------------------------------------------- */

router.get(
  '/audit',
  wrap((req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${limit}`)
      .all()
      .map((r) => ({
        id: r.id,
        username: r.username,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        detail: r.detail,
        createdAt: r.created_at,
      }));
    res.json({ entries: rows });
  })
);

module.exports = router;
