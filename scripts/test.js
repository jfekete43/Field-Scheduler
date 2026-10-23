'use strict';

/**
 * Smoke tests for the scheduling rules.
 *
 *   npm test
 *
 * Runs against a throwaway database in a temp directory, so it never touches
 * the league's real schedule.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data layer at a scratch directory BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jhll-test-'));
process.env.DATA_DIR = TMP;

const { db } = require('../src/db');
const schedule = require('../src/schedule');
const auth = require('../src/auth');
const { buildCalendar, wallTimeToUtc } = require('../src/ics');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function throws(name, fn, expectedFragment) {
  try {
    fn();
    check(name, false, 'expected an error but none was thrown');
  } catch (err) {
    const matched = !expectedFragment || err.message.includes(expectedFragment);
    check(name, matched, matched ? '' : `message was "${err.message}"`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ---------------------------------------------------------------- */

section('Seed data');

// Minimal fixture mirroring the real league layout.
const locationId = db
  .prepare("INSERT INTO locations (slug, name, address, maps_query) VALUES ('holbrook','Holbrook','','') RETURNING id")
  .get().id;
const otherLocationId = db
  .prepare("INSERT INTO locations (slug, name, address, maps_query) VALUES ('527','527','','') RETURNING id")
  .get().id;

const mkField = (loc, slug, name, kind = 'baseball') =>
  db
    .prepare('INSERT INTO fields (location_id, slug, name, kind) VALUES (?, ?, ?, ?) RETURNING id')
    .get(loc, slug, name, kind).id;

const farm = mkField(locationId, 'farm', 'Farm');
const holbrookMajors = mkField(locationId, 'majors', 'Majors');
const cages = mkField(locationId, 'indoor-cages', 'Indoor Cages', 'cage');
const route527Majors = mkField(otherLocationId, 'majors', 'Majors');

check('two locations can each have a field named Majors', holbrookMajors !== route527Majors);

/* ---------------------------------------------------------------- */

section('Double-booking protection');

const base = {
  fieldId: farm,
  eventDate: '2026-05-02',
  startTime: '10:00',
  endTime: '12:00',
  eventType: 'game',
  homeTeam: 'Reds',
  awayTeam: 'Cubs',
};

const first = schedule.createEvent(base, null);
check('an event can be created', first && first.id > 0);

throws(
  'an overlapping event on the same field is refused',
  () => schedule.createEvent({ ...base, startTime: '11:00', endTime: '13:00' }, null),
  'already booked'
);

const touching = schedule.createEvent({ ...base, startTime: '12:00', endTime: '14:00' }, null);
check('an event starting exactly when another ends is allowed', !!touching);

const sameTimeOtherField = schedule.createEvent({ ...base, fieldId: route527Majors }, null);
check('the same time on a different field is allowed', !!sameTimeOtherField);

const forced = schedule.createEvent(
  { ...base, startTime: '11:00', endTime: '13:00' },
  null,
  { allowConflict: true }
);
check('an overlap can be forced deliberately', !!forced);

// A canceled event must not block the slot.
schedule.updateEvent(forced.id, { ...base, startTime: '11:00', endTime: '13:00', status: 'canceled' }, null, {
  allowConflict: true,
});
const afterCancel = schedule.findConflicts({
  field_id: farm,
  event_date: '2026-05-02',
  start_time: '11:00',
  end_time: '11:30',
});
check('a canceled event no longer blocks its slot', afterCancel.every((c) => c.id !== forced.id));

// Editing an event must not conflict with itself.
const edited = schedule.updateEvent(first.id, { ...base, startTime: '10:30' }, null);
check('an event can be edited without conflicting with itself', edited.startTime === '10:30');

/* ---------------------------------------------------------------- */

section('All-day blocks');

const blockField = mkField(locationId, 'block', 'Block Field');
const block = schedule.createEvent(
  { fieldId: blockField, eventDate: '2027-08-14', eventType: 'tournament', title: 'Fall Classic', allDay: true },
  null
);
check('an all-day block needs no times', block.allDay === true);
check('it covers the whole day', block.startTime === '00:00' && block.endTime === '23:59');

throws('nothing else fits that day', () =>
  schedule.createEvent({ fieldId: blockField, eventDate: '2027-08-14', startTime: '13:00', endTime: '15:00' }, null),
  'already booked');
throws('not even first thing in the morning', () =>
  schedule.createEvent({ fieldId: blockField, eventDate: '2027-08-14', startTime: '00:00', endTime: '00:30' }, null),
  'already booked');
throws('not even last thing at night', () =>
  schedule.createEvent({ fieldId: blockField, eventDate: '2027-08-14', startTime: '23:00', endTime: '23:59' }, null),
  'already booked');

const dayAfter = schedule.createEvent(
  { fieldId: blockField, eventDate: '2027-08-15', startTime: '13:00', endTime: '15:00' },
  null
);
check('the next day is unaffected', !!dayAfter);

const otherField = mkField(locationId, 'block-other', 'Other Block Field');
check('another field that day is unaffected',
  !!schedule.createEvent({ fieldId: otherField, eventDate: '2027-08-14', startTime: '13:00', endTime: '15:00' }, null));

// A multi-day tournament is one block per day.
const multiField = mkField(locationId, 'multi', 'Multi Field');
const weekend = schedule.createSeries(
  { fieldId: multiField, eventDate: '2027-08-13', eventType: 'tournament', title: 'Three-day',
    allDay: true, repeatEveryDays: 1, repeatUntil: '2027-08-15' },
  null
);
check('a three-day block creates three events', weekend.created.length === 3);
check('each one is all day', weekend.created.every((e) => e.allDay === true));
check('they cover consecutive days',
  weekend.created.map((e) => e.date).join(',') === '2027-08-13,2027-08-14,2027-08-15');

// An all-day block can be turned back into a timed event.
const relaxed = schedule.updateEvent(block.id,
  { fieldId: blockField, eventDate: '2027-08-14', startTime: '09:00', endTime: '17:00', eventType: 'tournament' },
  null);
check('a block can become a timed event again', relaxed.allDay === false && relaxed.startTime === '09:00');
check('which frees the rest of the day',
  !!schedule.createEvent({ fieldId: blockField, eventDate: '2027-08-14', startTime: '18:00', endTime: '19:00' }, null));

// The feed marks them as all-day rather than a midnight-to-23:59 span.
const blockIcs = buildCalendar(
  [schedule.getEvent(weekend.created[0].id)],
  { calendarName: 'x', timeZone: 'America/New_York' }
);
check('the calendar feed uses a DATE value', blockIcs.includes('DTSTART;VALUE=DATE:20270813'));
check('and ends on the following day, as the spec requires', blockIcs.includes('DTEND;VALUE=DATE:20270814'));

section('Input validation');

throws('an end time before the start is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, startTime: '14:00', endTime: '13:00' }, null), 'end time');

throws('a zero-length event is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, startTime: '14:00', endTime: '14:00' }, null), 'end time');

throws('a date that does not exist is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, eventDate: '2026-02-30' }, null), 'valid date');

throws('a malformed date is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, eventDate: 'tomorrow' }, null), 'valid date');

throws('an out-of-range time is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, startTime: '25:00', endTime: '26:00' }, null), 'start time');

throws('an unknown event type is refused', () =>
  schedule.createEvent({ ...base, fieldId: cages, eventType: 'whatever' }, null), 'event type');

throws('an unknown field is refused', () =>
  schedule.createEvent({ ...base, fieldId: 999999 }, null), 'no longer exists');

/* ---------------------------------------------------------------- */

section('Repeating series');

const series = schedule.createSeries(
  {
    fieldId: cages,
    eventDate: '2026-05-04',
    startTime: '18:00',
    endTime: '19:00',
    eventType: 'cage',
    division: 'AAA',
    repeatCount: 6,
    repeatEveryDays: 7,
  },
  null
);
check('six weekly sessions are created', series.created.length === 6);
check(
  'each falls a week apart',
  series.created.map((e) => e.date).join(',') ===
    '2026-05-04,2026-05-11,2026-05-18,2026-05-25,2026-06-01,2026-06-08'
);
check('they share one series id', new Set(series.created.map((e) => e.seriesId)).size === 1);

// A series crossing a month boundary and a leap day.
const leap = schedule.createSeries(
  { fieldId: holbrookMajors, eventDate: '2028-02-26', startTime: '09:00', endTime: '10:00', repeatCount: 3 },
  null
);
check(
  'a series spans a leap-year February correctly',
  leap.created.map((e) => e.date).join(',') === '2028-02-26,2028-03-04,2028-03-11'
);

throws('an absurd repeat count is refused', () =>
  schedule.createSeries({ ...base, fieldId: cages, repeatCount: 500 }, null), 'Repeat count');

// Repeating until a date, rather than counting the weeks by hand.
const untilField = mkField(locationId, 'until', 'Until Field');
const untilSeries = schedule.createSeries(
  { fieldId: untilField, eventDate: '2027-04-06', startTime: '17:30', endTime: '19:00', repeatUntil: '2027-06-15' },
  null
);
check('repeating until a date creates the right number', untilSeries.created.length === 11);
check('it starts on the event date', untilSeries.created[0].date === '2027-04-06');
check('it stops on the end date', untilSeries.created[10].date === '2027-06-15');
check('every date is the same weekday', untilSeries.created.every((e) => new Date(`${e.date}T00:00`).getDay() === 2));

const spanField = mkField(locationId, 'span', 'Span Field');
const fortnightly = schedule.createSeries(
  { fieldId: spanField, eventDate: '2027-04-06', startTime: '09:00', endTime: '10:00', repeatUntil: '2027-06-15', repeatEveryDays: 14 },
  null
);
check('the interval is respected when repeating until a date', fortnightly.created.length === 6);

const exactField = mkField(locationId, 'exact', 'Exact Field');
const sameDay = schedule.createSeries(
  { fieldId: exactField, eventDate: '2027-04-06', startTime: '09:00', endTime: '10:00', repeatUntil: '2027-04-06' },
  null
);
check('an end date equal to the start makes one event', sameDay.created.length === 1);

throws('an end date before the start is refused', () =>
  schedule.occurrenceCount({ repeatUntil: '2027-01-01' }, '2027-04-06', 7), 'before the first date');
throws('an impossible end date is refused', () =>
  schedule.occurrenceCount({ repeatUntil: '2027-02-30' }, '2027-04-06', 7), 'valid date');
throws('a range that would flood the schedule is refused', () =>
  schedule.occurrenceCount({ repeatUntil: '2030-01-01' }, '2027-04-06', 7), 'more than 60');
check('a date range wins over a count when both are sent',
  schedule.occurrenceCount({ repeatUntil: '2027-04-27', repeatCount: 99 }, '2027-04-06', 7) === 4);

// Deleting from a date onward keeps the earlier dates.
const removed = schedule.deleteSeries(series.seriesId, { fromDate: '2026-05-18' });
check('deleting a series from a date removes only later dates', removed === 4);
check(
  'the earlier dates survive',
  schedule.listEvents({ from: '2026-05-01', to: '2026-06-30' }).filter((e) => e.seriesId === series.seriesId).length === 2
);

/* ---------------------------------------------------------------- */

section('Calendar feed and daylight saving');

// New York is UTC-4 in summer (EDT) and UTC-5 in winter (EST).
check(
  'a summer time converts at EDT (-4)',
  wallTimeToUtc('2026-05-02', '10:00', 'America/New_York').toISOString() === '2026-05-02T14:00:00.000Z'
);
check(
  'a winter time converts at EST (-5)',
  wallTimeToUtc('2026-01-10', '10:00', 'America/New_York').toISOString() === '2026-01-10T15:00:00.000Z'
);
check(
  'the evening before the spring-forward change is still EST',
  wallTimeToUtc('2026-03-07', '20:00', 'America/New_York').toISOString() === '2026-03-08T01:00:00.000Z'
);
check(
  'the afternoon after the spring-forward change is EDT',
  wallTimeToUtc('2026-03-08', '14:00', 'America/New_York').toISOString() === '2026-03-08T18:00:00.000Z'
);

const ics = buildCalendar(schedule.listEvents({ from: '2026-01-01', to: '2026-12-31' }), {
  calendarName: 'JHLL Schedule',
  timeZone: 'America/New_York',
});
const lines = ics.split('\r\n');
check('the feed is wrapped in a VCALENDAR', lines[0] === 'BEGIN:VCALENDAR' && ics.trimEnd().endsWith('END:VCALENDAR'));
check('every line uses CRLF endings', ics.split('\n').every((l) => l === '' || l.endsWith('\r')));
check('no line exceeds the 75-octet limit', lines.every((l) => Buffer.byteLength(l, 'utf8') <= 75));

// Text with commas, semicolons and newlines must be escaped, not truncated.
const trickyField = mkField(locationId, 'tricky', 'Tricky; Field, One');
const tricky = schedule.createEvent(
  {
    fieldId: trickyField,
    eventDate: '2026-05-09',
    startTime: '09:00',
    endTime: '10:00',
    eventType: 'game',
    title: 'Semi; colon, comma\nand a newline',
  },
  null
);
const trickyIcs = buildCalendar([schedule.getEvent(tricky.id)], {
  calendarName: 'x',
  timeZone: 'America/New_York',
});
// Built from character codes rather than typed escapes: hand-writing the
// expected string here is exactly how the missing semicolon escape slipped
// through the first time.
const BS = String.fromCharCode(92); // a single backslash
check(
  'a semicolon is escaped in the feed',
  trickyIcs.includes(`Semi${BS};`),
  `got: ${JSON.stringify(trickyIcs.split('\r\n').find((l) => l.startsWith('SUMMARY')))}`
);
check('a comma is escaped in the feed', trickyIcs.includes(`colon${BS}, comma`));
check('a newline becomes a literal \\n', trickyIcs.includes(`${BS}nand a newline`));
check('escaping does not break line folding', trickyIcs.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75));

// A backslash in the source text must itself be doubled.
const slashy = schedule.createEvent(
  { fieldId: trickyField, eventDate: '2026-05-09', startTime: '11:00', endTime: '12:00', title: `back${BS}slash` },
  null
);
const slashIcs = buildCalendar([schedule.getEvent(slashy.id)], { calendarName: 'x', timeZone: 'America/New_York' });
check('a backslash is doubled', slashIcs.includes(`back${BS}${BS}slash`));

// A bare CR must not be able to start a new content line.
const crEvent = schedule.createEvent(
  {
    fieldId: trickyField,
    eventDate: '2026-05-09',
    startTime: '13:00',
    endTime: '14:00',
    title: `harmless${String.fromCharCode(13)}SUMMARY:injected`,
  },
  null
);
const crIcs = buildCalendar([schedule.getEvent(crEvent.id)], { calendarName: 'x', timeZone: 'America/New_York' });
check(
  'a carriage return cannot inject a calendar line',
  crIcs.split('\r\n').filter((l) => l.startsWith('SUMMARY')).length === 1
);

/* ---------------------------------------------------------------- */

section('Filtering');

check('filtering by field works', schedule.listEvents({ fieldId: cages }).every((e) => e.fieldId === cages));
check('filtering by location works', schedule.listEvents({ locationId: otherLocationId }).every((e) => e.locationId === otherLocationId));
check('filtering by type works', schedule.listEvents({ eventType: 'cage' }).every((e) => e.eventType === 'cage'));
check('searching by team name works', schedule.listEvents({ search: 'Reds' }).length > 0);
check('a date window excludes outside dates', schedule.listEvents({ from: '2026-05-01', to: '2026-05-31' }).every((e) => e.date >= '2026-05-01' && e.date <= '2026-05-31'));
check("a search for a quote character doesn't break the query", Array.isArray(schedule.listEvents({ search: "'; DROP TABLE events; --" })));
check('the events table survived that search', db.prepare('SELECT COUNT(*) AS n FROM events').get().n > 0);

/* ---------------------------------------------------------------- */

section('Accounts');

throws('a short password is refused', () => auth.createUser({ username: 'coach', password: 'short1' }), 'at least 10');
throws('a password with no digit is refused', () => auth.createUser({ username: 'coach', password: 'abcdefghijk' }), 'number');
throws('an invalid username is refused', () => auth.createUser({ username: 'a b', password: 'GoodPass123' }), 'Username');

const user = auth.createUser({ username: 'coach', password: 'GoodPass123', displayName: 'Coach' });
check('an account can be created', !!user);
check('the password is hashed, not stored', !user.password_hash.includes('GoodPass123'));
check('a correct password signs in', !!auth.verifyLogin('coach', 'GoodPass123'));
check('the username is case-insensitive', !!auth.verifyLogin('COACH', 'GoodPass123'));
check('a wrong password is rejected', auth.verifyLogin('coach', 'WrongPass123') === null);
check('an unknown user is rejected', auth.verifyLogin('nobody', 'GoodPass123') === null);

throws('a duplicate username is refused', () => auth.createUser({ username: 'Coach', password: 'GoodPass123' }), 'already taken');

db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
check('a disabled account cannot sign in', auth.verifyLogin('coach', 'GoodPass123') === null);

/* ---------------------------------------------------------------- */

section('Query guards');

check('a fractional limit does not throw', Array.isArray(schedule.listEvents({ limit: 1.5 })));
check('a non-numeric limit does not throw', Array.isArray(schedule.listEvents({ limit: 'lots' })));
throws('an impossible from date is rejected, not ignored', () =>
  schedule.listEvents({ from: '2026-02-30' }), 'not a valid date');
throws('a malformed to date is rejected, not ignored', () =>
  schedule.listEvents({ to: 'whenever' }), 'not a valid date');

section('Hiding a field');

const hidden = mkField(locationId, 'hideme', 'Hide Me');
schedule.createEvent(
  { fieldId: hidden, eventDate: '2026-06-06', startTime: '10:00', endTime: '11:00' },
  null
);
check('its event is visible while the field is shown', schedule.listEvents({ fieldId: hidden }).length === 1);
db.prepare('UPDATE fields SET active = 0 WHERE id = ?').run(hidden);
check('hiding the field hides its events publicly', schedule.listEvents({ fieldId: hidden }).length === 0);
check(
  'admins still see them, so the change is reversible',
  schedule.listEvents({ fieldId: hidden, includeInactive: true }).length === 1
);

section('Login throttling');

const THROTTLE_USER = 'throttled.user';
auth.createUser({ username: THROTTLE_USER, password: 'GoodPass123' });
check('a fresh account is not throttled', auth.checkThrottle(THROTTLE_USER, '10.0.0.1') === null);
for (let i = 0; i < 8; i += 1) auth.recordFailure(THROTTLE_USER, '10.0.0.1');
check('repeated failures from one address lock it out', auth.checkThrottle(THROTTLE_USER, '10.0.0.1') > 0);
check('another address is not locked out yet', auth.checkThrottle(THROTTLE_USER, '10.0.0.2') === null);
for (let i = 0; i < 24; i += 1) auth.recordFailure(THROTTLE_USER, `10.1.0.${i}`);
check(
  'spreading guesses across addresses still locks the account',
  auth.checkThrottle(THROTTLE_USER, '203.0.113.7') > 0
);
auth.clearFailures(THROTTLE_USER, '10.0.0.1');
check('a successful sign-in clears the lockout', auth.checkThrottle(THROTTLE_USER, '10.0.0.1') === null);

section('Password reset ends other sessions');

const sessionUser = auth.createUser({ username: 'session.user', password: 'GoodPass123' });
const putSession = (sid, userId) =>
  db
    .prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
    .run(sid, JSON.stringify({ user: { id: userId } }), Date.now() + 3600000);
putSession('sid-phone', sessionUser.id);
putSession('sid-laptop', sessionUser.id);
putSession('sid-someone-else', 999);
auth.setPassword(sessionUser.id, 'BrandNewPass456');
const left = db.prepare('SELECT sid FROM sessions').all().map((r) => r.sid);
check('their other sessions are signed out', !left.includes('sid-phone') && !left.includes('sid-laptop'));
check('other people stay signed in', left.includes('sid-someone-else'));

putSession('sid-keep', sessionUser.id);
putSession('sid-drop', sessionUser.id);
auth.setPassword(sessionUser.id, 'AnotherPass789', { keepSid: 'sid-keep' });
const after = db.prepare('SELECT sid FROM sessions').all().map((r) => r.sid);
check('changing your own password keeps you signed in here', after.includes('sid-keep'));
check('but ends it on your other devices', !after.includes('sid-drop'));

/* ---------------------------------------------------------------- */

section('Rain out (over HTTP)');

async function rainoutTests() {
  const app = require('../src/server');
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  auth.createUser({ username: 'rainadmin', password: 'RainPass1234', role: 'owner' });

  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cookie ? { cookie } : {},
        csrf ? { 'x-csrf-token': csrf } : {}
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  let csrf = '';
  const login = await call('POST', '/api/auth/login', { username: 'rainadmin', password: 'RainPass1234' });
  csrf = login.body.csrfToken;
  check('an admin can sign in over HTTP', login.status === 200 && !!csrf);

  // A Saturday with grass, turf and cage all booked.
  const DAY = '2026-11-07';
  const grassA = mkField(locationId, 'rain-grass-a', 'Rain Grass A');
  const grassB = mkField(locationId, 'rain-grass-b', 'Rain Grass B');
  const turf = mkField(locationId, 'rain-turf', 'Rain Turf', 'turf');
  const cage = mkField(locationId, 'rain-cage', 'Rain Cage', 'cage');
  const made = {};
  for (const [key, fieldId] of Object.entries({ grassA, grassB, turf, cage })) {
    made[key] = schedule.createEvent(
      { fieldId, eventDate: DAY, startTime: '09:00', endTime: '11:00', eventType: 'game' },
      null
    ).id;
  }
  const statusOf = (id) => schedule.getEvent(id).status;

  // Only the grass is called off.
  const res = await call('POST', '/api/admin/events/bulk-status', {
    date: DAY, status: 'rain', fieldIds: [grassA, grassB],
  });
  check('the call succeeds', res.status === 200, JSON.stringify(res.body));
  check('it reports the number it changed', res.body.updated === 2, `updated=${res.body.updated}`);
  check('grass is rained out', statusOf(made.grassA) === 'rain' && statusOf(made.grassB) === 'rain');
  check('turf keeps playing', statusOf(made.turf) === 'scheduled');
  check('the cages keep playing', statusOf(made.cage) === 'scheduled');

  // Later the weather turns and the turf goes too, without re-touching the grass.
  const second = await call('POST', '/api/admin/events/bulk-status', {
    date: DAY, status: 'rain', fieldIds: [turf],
  });
  check('a second pass can add the turf', second.body.updated === 1 && statusOf(made.turf) === 'rain');
  check('the cages are still on', statusOf(made.cage) === 'scheduled');

  // Putting one field back.
  await call('POST', '/api/admin/events/bulk-status', { date: DAY, status: 'scheduled', fieldIds: [turf] });
  check('a field can be put back', statusOf(made.turf) === 'scheduled');

  const empty = await call('POST', '/api/admin/events/bulk-status', { date: DAY, status: 'rain', fieldIds: [] });
  check('an empty field list is refused', empty.status === 400, `status=${empty.status}`);

  const notArray = await call('POST', '/api/admin/events/bulk-status', { date: DAY, status: 'rain', fieldIds: 'all' });
  check('a malformed field list is refused', notArray.status === 400);

  const badDate = await call('POST', '/api/admin/events/bulk-status', { date: '2026-02-30', status: 'rain', fieldIds: [grassA] });
  check('an impossible date is refused', badDate.status === 400);

  const badStatus = await call('POST', '/api/admin/events/bulk-status', { date: DAY, status: 'soggy', fieldIds: [grassA] });
  check('an unknown status is refused', badStatus.status === 400);

  // A whole location still works, for the washout that takes everything.
  const wholeSite = await call('POST', '/api/admin/events/bulk-status', {
    date: DAY, status: 'rain', locationId,
  });
  check('a whole location can still be called off at once', wholeSite.body.updated >= 4);
  check('that does reach the cages', statusOf(made.cage) === 'rain');

  await new Promise((resolve) => server.close(resolve));
}

rainoutTests()
  .catch((err) => {
    failed += 1;
    console.log(`  FAIL  rain-out tests threw — ${err.message}`);
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    finish();
  });

function finish() {
  try {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.exit(failed ? 1 : 0);
}
