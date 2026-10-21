'use strict';

const express = require('express');
const { db, getSettings } = require('../db');
const schedule = require('../schedule');
const { buildCalendar } = require('../ics');

const router = express.Router();

function locationsWithFields({ includeInactive = false } = {}) {
  const locations = db.prepare('SELECT * FROM locations ORDER BY sort_order, name').all();
  const fieldSql = includeInactive
    ? 'SELECT * FROM fields WHERE location_id = ? ORDER BY sort_order, name'
    : 'SELECT * FROM fields WHERE location_id = ? AND active = 1 ORDER BY sort_order, name';
  const fieldStmt = db.prepare(fieldSql);
  const pinStmt = db.prepare('SELECT * FROM field_map_pins WHERE location_id = ? ORDER BY id');

  return locations.map((loc) => ({
    id: loc.id,
    slug: loc.slug,
    name: loc.name,
    address: loc.address,
    mapsQuery: loc.maps_query || loc.address || loc.name,
    latitude: loc.latitude,
    longitude: loc.longitude,
    notes: loc.notes,
    mapImage: loc.map_image,
    sortOrder: loc.sort_order,
    fields: fieldStmt.all(loc.id).map((f) => ({
      id: f.id,
      slug: f.slug,
      name: f.name,
      kind: f.kind,
      notes: f.notes,
      sortOrder: f.sort_order,
      active: !!f.active,
    })),
    pins: pinStmt.all(loc.id).map((p) => ({
      id: p.id,
      fieldId: p.field_id,
      label: p.label,
      x: p.x_pct,
      y: p.y_pct,
      color: p.color,
    })),
  }));
}

/** Everything the front end needs to render in one request. */
router.get('/bootstrap', (req, res) => {
  const settings = getSettings();
  const signedIn = !!req.session?.user?.id;
  res.json({
    settings: {
      leagueName: settings.league_name,
      leagueShort: settings.league_short,
      timezone: settings.timezone,
      logoPath: settings.logo_path,
      announcement: settings.announcement,
      announcementLevel: settings.announcement_level,
      contactEmail: settings.contact_email,
      seasonLabel: settings.season_label,
    },
    locations: locationsWithFields({ includeInactive: signedIn }),
    eventTypes: schedule.EVENT_TYPES,
    statuses: schedule.STATUSES,
    fieldKinds: schedule.FIELD_KINDS,
    divisions: schedule.listDivisions(),
    teams: schedule.listTeams(),
    today: new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone }),
    signedIn,
  });
});

router.get('/events', (req, res) => {
  const events = schedule.listEvents({
    from: req.query.from,
    to: req.query.to,
    locationId: req.query.location,
    fieldId: req.query.field,
    eventType: req.query.type,
    division: req.query.division,
    search: req.query.q,
    limit: req.query.limit,
    // Admins keep seeing events on hidden fields so they can fix them.
    includeInactive: !!req.session?.user?.id,
  });
  res.json({ events, count: events.length });
});

router.get('/locations', (_req, res) => {
  res.json({ locations: locationsWithFields() });
});

module.exports = { router, locationsWithFields };

/* ---------------------------------------------------------------- *
 * Calendar feed (mounted at the app root, not under /api)
 * ---------------------------------------------------------------- */

module.exports.calendarHandler = function calendarHandler(req, res) {
  const settings = getSettings();
  const events = schedule.listEvents({
    from: req.query.from || schedule.addDays(new Date().toISOString().slice(0, 10), -30),
    to: req.query.to,
    locationId: req.query.location,
    fieldId: req.query.field,
    eventType: req.query.type,
    division: req.query.division,
    limit: 5000,
  });

  const scope = [];
  if (req.query.location) {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(Number(req.query.location));
    if (loc) scope.push(loc.name);
  }
  if (req.query.field) {
    const field = db.prepare('SELECT name FROM fields WHERE id = ?').get(Number(req.query.field));
    if (field) scope.push(field.name);
  }
  if (req.query.division) scope.push(String(req.query.division).slice(0, 40));

  const calendarName = [settings.league_short || 'JHLL', ...scope, 'Schedule'].join(' ');
  const body = buildCalendar(events, { calendarName, timeZone: settings.timezone });

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="jhll-schedule.ics"');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(body);
};
