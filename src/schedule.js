'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const EVENT_TYPES = [
  { value: 'game', label: 'Game' },
  { value: 'practice', label: 'Practice' },
  { value: 'cage', label: 'Cage Session' },
  { value: 'tournament', label: 'Tournament' },
  { value: 'clinic', label: 'Clinic / Camp' },
  { value: 'maintenance', label: 'Field Maintenance' },
  { value: 'closed', label: 'Closed / Unavailable' },
  { value: 'other', label: 'Other' },
];

const STATUSES = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'postponed', label: 'Postponed' },
  { value: 'rain', label: 'Rained Out' },
];

const FIELD_KINDS = [
  { value: 'baseball', label: 'Baseball' },
  { value: 'softball', label: 'Softball' },
  { value: 'turf', label: 'Turf' },
  { value: 'cage', label: 'Batting Cage' },
  { value: 'other', label: 'Other' },
];

const EVENT_TYPE_VALUES = EVENT_TYPES.map((t) => t.value);
const STATUS_VALUES = STATUSES.map((s) => s.value);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function isRealDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function str(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Validates and normalises an event payload coming from the admin UI.
 */
function normalizeEvent(payload) {
  const fieldId = Number(payload.fieldId ?? payload.field_id);
  if (!Number.isInteger(fieldId) || fieldId <= 0) throw badRequest('Choose a field.');

  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId);
  if (!field) throw badRequest('That field no longer exists.');

  const eventDate = str(payload.eventDate ?? payload.event_date, 10);
  if (!isRealDate(eventDate)) throw badRequest('Enter a valid date.');

  const startTime = str(payload.startTime ?? payload.start_time, 5);
  const endTime = str(payload.endTime ?? payload.end_time, 5);
  if (!TIME_RE.test(startTime)) throw badRequest('Enter a valid start time.');
  if (!TIME_RE.test(endTime)) throw badRequest('Enter a valid end time.');
  if (minutesOf(endTime) <= minutesOf(startTime)) {
    throw badRequest('The end time must be after the start time.');
  }

  const eventType = str(payload.eventType ?? payload.event_type, 20) || 'game';
  if (!EVENT_TYPE_VALUES.includes(eventType)) throw badRequest('Choose a valid event type.');

  const status = str(payload.status, 20) || 'scheduled';
  if (!STATUS_VALUES.includes(status)) throw badRequest('Choose a valid status.');

  return {
    field_id: fieldId,
    event_type: eventType,
    title: str(payload.title, 120),
    division: str(payload.division, 60),
    home_team: str(payload.homeTeam ?? payload.home_team, 80),
    away_team: str(payload.awayTeam ?? payload.away_team, 80),
    event_date: eventDate,
    start_time: startTime,
    end_time: endTime,
    notes: str(payload.notes, 1000),
    status,
  };
}

/**
 * Returns events that overlap the given field/date/time window.
 * Canceled and rained-out events never count as conflicts.
 */
function findConflicts({ field_id, event_date, start_time, end_time }, excludeId = null) {
  const rows = db
    .prepare(
      `SELECT e.*, f.name AS field_name, l.name AS location_name
         FROM events e
         JOIN fields f    ON f.id = e.field_id
         JOIN locations l ON l.id = f.location_id
        WHERE e.field_id = ?
          AND e.event_date = ?
          AND e.status NOT IN ('canceled', 'rain')
          AND (? IS NULL OR e.id != ?)`
    )
    .all(field_id, event_date, excludeId, excludeId);

  const start = minutesOf(start_time);
  const end = minutesOf(end_time);
  return rows.filter((row) => {
    const rowStart = minutesOf(row.start_time);
    const rowEnd = minutesOf(row.end_time);
    return rowStart < end && rowEnd > start;
  });
}

const INSERT_EVENT = `
  INSERT INTO events (field_id, event_type, title, division, home_team, away_team,
                      event_date, start_time, end_time, notes, status, series_id, created_by)
  VALUES (@field_id, @event_type, @title, @division, @home_team, @away_team,
          @event_date, @start_time, @end_time, @notes, @status, @series_id, @created_by)`;

function createEvent(payload, user, { allowConflict = false } = {}) {
  const event = normalizeEvent(payload);
  const conflicts = findConflicts(event);
  if (conflicts.length && !allowConflict) {
    throw Object.assign(new Error('That field is already booked for part of this time.'), {
      status: 409,
      conflicts: conflicts.map(describeConflict),
    });
  }
  const info = db.prepare(INSERT_EVENT).run({
    ...event,
    series_id: null,
    created_by: user?.id ?? null,
  });
  return getEvent(info.lastInsertRowid);
}

/**
 * Creates a weekly (or every-N-days) repeating series in one transaction.
 */
function createSeries(payload, user, { allowConflict = false } = {}) {
  const base = normalizeEvent(payload);
  const repeatCount = Number(payload.repeatCount ?? 1);
  const repeatEvery = Number(payload.repeatEveryDays ?? 7);

  if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 60) {
    throw badRequest('Repeat count must be between 1 and 60.');
  }
  if (!Number.isInteger(repeatEvery) || repeatEvery < 1 || repeatEvery > 90) {
    throw badRequest('Repeat interval must be between 1 and 90 days.');
  }
  if (repeatCount === 1) {
    return { created: [createEvent(payload, user, { allowConflict })], skipped: [] };
  }

  const seriesId = crypto.randomUUID();
  const planned = [];
  for (let i = 0; i < repeatCount; i += 1) {
    planned.push({ ...base, event_date: addDays(base.event_date, i * repeatEvery) });
  }

  const skipped = [];
  const keep = [];
  for (const occurrence of planned) {
    const conflicts = findConflicts(occurrence);
    if (conflicts.length && !allowConflict) {
      skipped.push({ date: occurrence.event_date, conflicts: conflicts.map(describeConflict) });
    } else {
      keep.push(occurrence);
    }
  }

  if (!keep.length) {
    throw Object.assign(new Error('Every date in that series is already booked.'), {
      status: 409,
      conflicts: skipped.flatMap((s) => s.conflicts),
    });
  }

  const insert = db.prepare(INSERT_EVENT);
  const ids = db.transaction(() =>
    keep.map(
      (occurrence) =>
        insert.run({ ...occurrence, series_id: seriesId, created_by: user?.id ?? null })
          .lastInsertRowid
    )
  )();

  return { created: ids.map(getEvent), skipped, seriesId };
}

function updateEvent(id, payload, user, { allowConflict = false } = {}) {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!existing) throw Object.assign(new Error('That event no longer exists.'), { status: 404 });

  const event = normalizeEvent(payload);
  const conflicts = findConflicts(event, id);
  if (conflicts.length && !allowConflict) {
    throw Object.assign(new Error('That field is already booked for part of this time.'), {
      status: 409,
      conflicts: conflicts.map(describeConflict),
    });
  }

  db.prepare(
    `UPDATE events SET field_id = @field_id, event_type = @event_type, title = @title,
            division = @division, home_team = @home_team, away_team = @away_team,
            event_date = @event_date, start_time = @start_time, end_time = @end_time,
            notes = @notes, status = @status, updated_at = datetime('now')
      WHERE id = @id`
  ).run({ ...event, id });

  return getEvent(id);
}

function deleteEvent(id) {
  const row = getEvent(id);
  if (!row) throw Object.assign(new Error('That event no longer exists.'), { status: 404 });
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  return row;
}

function deleteSeries(seriesId, { fromDate = null } = {}) {
  const params = fromDate ? [seriesId, fromDate] : [seriesId];
  const sql = fromDate
    ? 'DELETE FROM events WHERE series_id = ? AND event_date >= ?'
    : 'DELETE FROM events WHERE series_id = ?';
  return db.prepare(sql).run(...params).changes;
}

function describeConflict(row) {
  const who = [row.home_team, row.away_team].filter(Boolean).join(' vs ');
  const label = row.title || who || row.division || row.event_type;
  return {
    id: row.id,
    label,
    locationName: row.location_name,
    fieldName: row.field_name,
    date: row.event_date,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

const EVENT_SELECT = `
  SELECT e.id, e.event_type, e.title, e.division, e.home_team, e.away_team,
         e.event_date, e.start_time, e.end_time, e.notes, e.status, e.series_id,
         e.created_at, e.updated_at,
         f.id AS field_id, f.name AS field_name, f.slug AS field_slug, f.kind AS field_kind,
         l.id AS location_id, l.name AS location_name, l.slug AS location_slug,
         l.address AS location_address, l.maps_query AS location_maps_query
    FROM events e
    JOIN fields f    ON f.id = e.field_id
    JOIN locations l ON l.id = f.location_id`;

function shapeEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type,
    title: row.title,
    division: row.division,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    date: row.event_date,
    startTime: row.start_time,
    endTime: row.end_time,
    notes: row.notes,
    status: row.status,
    seriesId: row.series_id,
    fieldId: row.field_id,
    fieldName: row.field_name,
    fieldSlug: row.field_slug,
    fieldKind: row.field_kind,
    locationId: row.location_id,
    locationName: row.location_name,
    locationSlug: row.location_slug,
    locationAddress: row.location_address,
    locationMapsQuery: row.location_maps_query,
    updatedAt: row.updated_at,
  };
}

function getEvent(id) {
  return shapeEvent(db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id));
}

/**
 * Public schedule query. All filters are optional.
 */
function listEvents({ from, to, locationId, fieldId, eventType, division, search, limit } = {}) {
  const where = [];
  const params = {};

  if (from && isRealDate(from)) {
    where.push('e.event_date >= @from');
    params.from = from;
  }
  if (to && isRealDate(to)) {
    where.push('e.event_date <= @to');
    params.to = to;
  }
  if (locationId) {
    where.push('l.id = @locationId');
    params.locationId = Number(locationId);
  }
  if (fieldId) {
    where.push('f.id = @fieldId');
    params.fieldId = Number(fieldId);
  }
  if (eventType && EVENT_TYPE_VALUES.includes(eventType)) {
    where.push('e.event_type = @eventType');
    params.eventType = eventType;
  }
  if (division) {
    where.push('e.division = @division COLLATE NOCASE');
    params.division = String(division).trim();
  }
  if (search) {
    where.push(
      `(e.title LIKE @search OR e.home_team LIKE @search OR e.away_team LIKE @search
        OR e.division LIKE @search OR e.notes LIKE @search)`
    );
    params.search = `%${String(search).trim().slice(0, 60)}%`;
  }

  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const cap = Math.min(Math.max(Number(limit) || 2000, 1), 5000);

  return db
    .prepare(
      `${EVENT_SELECT}${clause}
        ORDER BY e.event_date, e.start_time, l.sort_order, f.sort_order
        LIMIT ${cap}`
    )
    .all(params)
    .map(shapeEvent);
}

function listDivisions() {
  return db
    .prepare(
      `SELECT DISTINCT division FROM events
        WHERE TRIM(division) != '' ORDER BY division COLLATE NOCASE`
    )
    .all()
    .map((r) => r.division);
}

function listTeams() {
  return db
    .prepare(
      `SELECT name FROM (
         SELECT home_team AS name FROM events WHERE TRIM(home_team) != ''
         UNION SELECT away_team AS name FROM events WHERE TRIM(away_team) != ''
       ) ORDER BY name COLLATE NOCASE`
    )
    .all()
    .map((r) => r.name);
}

module.exports = {
  EVENT_TYPES,
  STATUSES,
  FIELD_KINDS,
  normalizeEvent,
  findConflicts,
  describeConflict,
  createEvent,
  createSeries,
  updateEvent,
  deleteEvent,
  deleteSeries,
  getEvent,
  listEvents,
  listDivisions,
  listTeams,
  isRealDate,
  addDays,
  minutesOf,
};
