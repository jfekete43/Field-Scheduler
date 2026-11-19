/* ------------------------------------------------------------------
   Stand-in for the Node server, so the real front-end code runs here
   unchanged. Same endpoints, same shapes, same scheduling rules.
   ------------------------------------------------------------------ */

const DB = {
  settings: {
    league_name: 'Jackson Holbrook Little League',
    league_short: 'JHLL',
    timezone: 'America/New_York',
    logo_path: '',
    announcement: 'Fall ball runs through November 21. Check the cage schedule before dropping in.',
    announcement_level: 'info',
    contact_email: 'schedule@jhll.example.org',
    season_label: 'Fall Ball 2026',
  },
  locations: [],
  fields: [],
  pins: [],
  events: [],
  users: [],
  audit: [],
  nextId: { location: 1, field: 1, event: 1, user: 1, pin: 1 },
};

const EVENT_TYPES = [
  { value: 'game', label: 'Game' }, { value: 'practice', label: 'Practice' },
  { value: 'cage', label: 'Cage Session' }, { value: 'tournament', label: 'Tournament' },
  { value: 'clinic', label: 'Clinic / Camp' }, { value: 'maintenance', label: 'Field Maintenance' },
  { value: 'closed', label: 'Closed / Unavailable' }, { value: 'other', label: 'Other' },
];
const STATUSES = [
  { value: 'scheduled', label: 'Scheduled' }, { value: 'canceled', label: 'Canceled' },
  { value: 'postponed', label: 'Postponed' }, { value: 'rain', label: 'Rained Out' },
];
const FIELD_KINDS = [
  { value: 'baseball', label: 'Baseball' }, { value: 'softball', label: 'Softball' },
  { value: 'turf', label: 'Turf' }, { value: 'cage', label: 'Batting Cage' },
  { value: 'other', label: 'Other' },
];

/* ---------------- seed: the real locations and fields ---------------- */

const SEED = [
  { slug: 'holbrook', name: 'Holbrook', address: 'Holbrook Complex, Jackson Township, NJ',
    notes: 'Home of the indoor batting cages.',
    fields: [['farm','Farm'],['aa','AA'],['aaa','AAA'],['majors','Majors'],['60-90','60/90'],['indoor-cages','Indoor Cages','cage']] },
  { slug: 'justice', name: 'Justice', address: 'Justice Complex, Jackson Township, NJ', notes: '',
    fields: [['grass-a','Grass A'],['grass-b','Grass B'],['turf-1','Turf 1','turf'],['turf-2','Turf 2','turf'],['softball','Softball','softball']] },
  { slug: 'bartley', name: 'Bartley', address: 'Bartley Road, Jackson Township, NJ', notes: 'Parking is behind the first-base dugout.',
    fields: [['field-1','Field 1'],['field-2','Field 2']] },
  { slug: '527', name: '527', address: 'County Route 527, Jackson Township, NJ', notes: '',
    fields: [['minors','Minors'],['majors','Majors'],['60-90','60/90']] },
];

SEED.forEach((loc, li) => {
  const id = DB.nextId.location++;
  DB.locations.push({
    id, slug: loc.slug, name: loc.name, address: loc.address,
    maps_query: `${loc.name} Little League Fields, Jackson Township, NJ`,
    latitude: null, longitude: null, notes: loc.notes, map_image: null, sort_order: li + 1,
  });
  loc.fields.forEach((f, fi) => {
    DB.fields.push({
      id: DB.nextId.field++, location_id: id, slug: f[0], name: f[1],
      kind: f[2] || 'baseball', notes: '', sort_order: fi + 1, active: 1,
    });
  });
});

DB.users.push({
  id: DB.nextId.user++, username: 'jim', display_name: 'Jim Fekete', role: 'owner',
  active: 1, created_at: '2026-09-01 10:00:00', last_login_at: '2026-10-23 08:14:00',
});
DB.users.push({
  id: DB.nextId.user++, username: 'dmartin', display_name: 'Dana Martin', role: 'admin',
  active: 1, created_at: '2026-09-04 19:20:00', last_login_at: '2026-10-22 20:41:00',
});

/* ---------------- a labelled site map for Holbrook ---------------- */

const HOLBROOK_MAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600">
<rect width="900" height="600" fill="#dcead1"/>
<path d="M0 300h900v56H0z" fill="#c8a784"/><path d="M430 0v300h40V0z" fill="#c8a784"/>
<g fill="#a9c894" stroke="#8fb47c" stroke-width="3">
<path d="M60 70h330v200H60z"/><path d="M520 70h320v200H520z"/><path d="M60 380h300v170H60z"/></g>
<g fill="none" stroke="#f6f3ea" stroke-width="4">
<path d="M90 250 L225 120 L360 250"/><path d="M550 250 L680 120 L810 250"/><path d="M90 530 L210 420 L330 530"/></g>
<rect x="470" y="390" width="210" height="120" rx="6" fill="#7d8691" stroke="#5f6670" stroke-width="3"/>
<text x="575" y="458" font-family="Helvetica,Arial" font-size="19" fill="#fff" text-anchor="middle">CAGE BUILDING</text>
<rect x="720" y="400" width="150" height="150" rx="6" fill="#b9bcc2" stroke="#9aa0a7" stroke-width="3"/>
<text x="795" y="482" font-family="Helvetica,Arial" font-size="17" fill="#4a5158" text-anchor="middle">PARKING</text>
<text x="450" y="586" font-family="Helvetica,Arial" font-size="15" fill="#5c6b50" text-anchor="middle">Holbrook Complex — site plan</text>
</svg>`;

const holbrook = DB.locations[0];
holbrook.map_image = 'data:image/svg+xml;utf8,' + encodeURIComponent(HOLBROOK_MAP);
[['Farm', 24, 44, 1], ['AAA', 74, 44, 3], ['Majors', 22, 88, 4], ['Indoor Cages', 63, 68, 6], ['Parking', 88, 70, null]]
  .forEach(([label, x, y, fieldIdx]) => {
    DB.pins.push({
      id: DB.nextId.pin++, location_id: holbrook.id,
      field_id: fieldIdx ? DB.fields[fieldIdx - 1].id : null,
      label, x_pct: x, y_pct: y, color: label === 'Indoor Cages' ? '#6d28d9' : '#1d4ed8',
    });
  });

/* ---------------- sample season, built around today ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (base, days) => { const d = new Date(base); d.setDate(d.getDate() + days); return d; };

const TODAY = new Date();
const fieldBy = (locSlug, fieldSlug) => {
  const loc = DB.locations.find((l) => l.slug === locSlug);
  return DB.fields.find((f) => f.location_id === loc.id && f.slug === fieldSlug);
};

const TEAMS = {
  Farm: ['Mudcats', 'River Dogs', 'Sand Gnats', 'Bees'],
  AA: ['Pirates', 'Cardinals', 'Reds', 'Cubs'],
  AAA: ['Thunder', 'Rockies', 'Blue Jays', 'Tigers'],
  Majors: ['Yankees', 'Mets', 'Braves', 'Phillies'],
  Minors: ['Orioles', 'Nationals', 'Astros', 'Giants'],
  Softball: ['Comets', 'Storm', 'Lightning', 'Heat'],
};

let seq = 0;
const pick = (arr) => arr[seq++ % arr.length];

function add(fieldRef, dayOffset, start, end, extra) {
  const f = fieldRef;
  DB.events.push(Object.assign({
    id: DB.nextId.event++, field_id: f.id, event_type: 'game', title: '', division: '',
    home_team: '', away_team: '', event_date: iso(shift(TODAY, dayOffset)),
    start_time: start, end_time: end, notes: '', status: 'scheduled', series_id: null,
    updated_at: '2026-10-20 12:00:00',
  }, extra));
}

// Saturday games across every site, for the next few weekends and the last one.
const dow = TODAY.getDay();
const toSaturday = (6 - dow + 7) % 7;
[-7, 0, 7, 14].forEach((weekOffset, w) => {
  const sat = toSaturday + weekOffset;
  const slate = [
    [fieldBy('holbrook', 'farm'), '09:00', '10:30', 'Farm'],
    [fieldBy('holbrook', 'aa'), '09:00', '11:00', 'AA'],
    [fieldBy('holbrook', 'majors'), '11:30', '13:30', 'Majors'],
    [fieldBy('justice', 'grass-a'), '09:00', '11:00', 'AAA'],
    [fieldBy('justice', 'turf-1'), '11:30', '13:30', 'Majors'],
    [fieldBy('justice', 'softball'), '10:00', '12:00', 'Softball'],
    [fieldBy('bartley', 'field-1'), '09:30', '11:30', 'Minors'],
    [fieldBy('bartley', 'field-2'), '12:00', '14:00', 'AA'],
    [fieldBy('527', 'minors'), '09:00', '11:00', 'Minors'],
    [fieldBy('527', 'majors'), '11:30', '13:30', 'Majors'],
    [fieldBy('527', '60-90'), '14:00', '16:30', 'Majors'],
  ];
  slate.forEach(([f, s, e, div]) => {
    const pool = TEAMS[div] || TEAMS.Majors;
    add(f, sat, s, e, {
      division: div, home_team: pick(pool), away_team: pick(pool), event_type: 'game',
      notes: w === 2 && div === 'Majors' ? 'Snack bar open. Bring a chair.' : '',
    });
  });
});

// Weekday practices
[1, 3].forEach((d) => {
  for (let w = 0; w < 4; w += 1) {
    const base = toSaturday - 6 + d + w * 7 - 7;
    add(fieldBy('holbrook', 'aaa'), base, '17:30', '19:00', { event_type: 'practice', division: 'AAA', home_team: pick(TEAMS.AAA) });
    add(fieldBy('justice', 'turf-2'), base, '18:00', '19:30', { event_type: 'practice', division: 'AA', home_team: pick(TEAMS.AA) });
    add(fieldBy('bartley', 'field-1'), base, '17:00', '18:30', { event_type: 'practice', division: 'Minors', home_team: pick(TEAMS.Minors) });
  }
});

// Indoor cage sessions, most weeknights
const cages = fieldBy('holbrook', 'indoor-cages');
for (let w = -1; w < 3; w += 1) {
  [1, 2, 3, 4].forEach((d, i) => {
    const base = toSaturday - 6 + d + w * 7;
    const div = ['Farm', 'AA', 'AAA', 'Majors'][i];
    add(cages, base, `${17 + i}:00`.padStart(5, '0'), `${18 + i}:00`.padStart(5, '0'), {
      event_type: 'cage', division: div, title: `${div} cage time`,
      notes: i === 3 ? 'Two lanes. Helmets required.' : '',
    });
  });
}

// Whatever weekday the preview is opened on, that day has a slate. Without
// this the Day view can open empty, which shows nothing of what the page does.
function dayCount(offset) {
  const date = iso(shift(TODAY, offset));
  return DB.events.filter((e) => e.event_date === date).length;
}

// Whatever weekday someone opens this on, that day has a believable slate.
// Topping up to a minimum rather than only filling an empty day: the view
// that greets a visitor should show what the page is for.
const WEEKDAY_SLATE = [
  [['holbrook', 'aa'], '17:30', '19:00', 'practice', 'AA'],
  [['holbrook', 'indoor-cages'], '18:00', '19:00', 'cage', 'Majors'],
  [['justice', 'turf-1'], '17:45', '19:15', 'practice', 'Majors'],
  [['527', 'minors'], '17:00', '18:30', 'practice', 'Minors'],
  [['bartley', 'field-2'], '18:00', '20:00', 'game', 'AAA'],
  [['holbrook', 'aaa'], '17:00', '18:30', 'practice', 'AAA'],
  [['justice', 'grass-a'], '18:15', '20:00', 'game', 'Majors'],
];

[0, 1, 2].forEach((offset) => {
  const want = offset === 0 ? 6 : 4;
  let have = dayCount(offset);
  for (const [ref, st, en, type, div] of WEEKDAY_SLATE) {
    if (have >= want) break;
    const field = fieldBy(ref[0], ref[1]);
    const date = iso(shift(TODAY, offset));
    // A local helper: the shared one is declared further down the file and is
    // not initialised yet while this seed data is being built.
    const at = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const taken = DB.events.some((e) =>
      e.event_date === date && e.field_id === field.id
      && at(e.start_time) < at(en) && at(e.end_time) > at(st));
    if (taken) continue;
    const pool = TEAMS[div] || TEAMS.Majors;
    add(field, offset, st, en, {
      event_type: type, division: div,
      title: type === 'cage' ? `${div} cage time` : '',
      home_team: type === 'cage' ? '' : pick(pool),
      away_team: type === 'game' ? pick(pool) : '',
    });
    have += 1;
  }
});

// A rained-out day last week and some field maintenance
DB.events.filter((e) => e.event_date === iso(shift(TODAY, toSaturday - 7)) && e.field_id === fieldBy('justice', 'grass-a').id)
  .forEach((e) => { e.status = 'rain'; e.notes = 'Field unplayable after Friday storms.'; });
DB.events.filter((e) => e.event_date === iso(shift(TODAY, toSaturday + 7))
  && e.field_id === fieldBy('holbrook', 'farm').id)
  .forEach((e) => { e.status = 'postponed'; e.notes = 'Moved to the following Sunday.'; });

add(fieldBy('justice', 'grass-b'), toSaturday + 7, '07:00', '09:00', {
  event_type: 'maintenance', title: 'Infield regrading', notes: 'Field closed until noon.',
});
// A two-day tournament that takes the field completely.
[0, 1].forEach((d) => {
  add(fieldBy('holbrook', '60-90'), toSaturday + 14 + d, '00:00', '23:59', {
    event_type: 'tournament', title: 'Fall Classic', division: 'Majors', all_day: 1,
    notes: 'Field closed to all other use.',
  });
});

/* ------------------------------------------------------------------
   One deliberately busy Saturday: a field running games back to back,
   a tournament taking a whole site, and the cages running all morning.
   ------------------------------------------------------------------ */

const SHOWCASE = toSaturday + 7;
const SHOWCASE_DATE = iso(shift(TODAY, SHOWCASE));

// Clear whatever the generator put there, then build it by hand.
DB.events = DB.events.filter((e) => e.event_date !== SHOWCASE_DATE);

function slate(locSlug, fieldSlug, div, rows) {
  const f = fieldBy(locSlug, fieldSlug);
  rows.forEach(([st, en, home, away, extra]) => {
    add(f, SHOWCASE, st, en, Object.assign({
      event_type: 'game', division: div, home_team: home, away_team: away,
    }, extra || {}));
  });
}

// Holbrook: Farm runs four straight, AA three, Majors two.
slate('holbrook', 'farm', 'Farm', [
  ['08:00', '09:30', 'Mudcats', 'Bees'],
  ['09:45', '11:15', 'River Dogs', 'Sand Gnats'],
  ['11:30', '13:00', 'Bees', 'River Dogs'],
  ['13:15', '14:45', 'Sand Gnats', 'Mudcats', { notes: 'Last game — please help break down the field.' }],
]);
slate('holbrook', 'aa', 'AA', [
  ['08:30', '10:30', 'Pirates', 'Cardinals'],
  ['10:45', '12:45', 'Reds', 'Cubs'],
  ['13:00', '15:00', 'Cardinals', 'Reds'],
]);
slate('holbrook', 'aaa', 'AAA', [
  ['09:00', '11:00', 'Thunder', 'Rockies'],
  ['11:30', '13:30', 'Blue Jays', 'Tigers'],
]);
slate('holbrook', 'majors', 'Majors', [
  ['10:00', '12:30', 'Yankees', 'Mets'],
  ['13:00', '15:30', 'Braves', 'Phillies', { notes: 'Snack bar open all day.' }],
]);

// The cages run back to back all morning.
[['08:00', '09:00', 'Farm'], ['09:00', '10:00', 'AA'],
 ['10:00', '11:00', 'AAA'], ['11:00', '12:00', 'Majors']].forEach(([st, en, div]) => {
  add(fieldBy('holbrook', 'indoor-cages'), SHOWCASE, st, en, {
    event_type: 'cage', division: div, title: `${div} cage time`,
  });
});

// Justice: grass and turf both busy, softball doubleheader.
slate('justice', 'grass-a', 'AAA', [
  ['09:00', '11:00', 'Rockies', 'Thunder'],
  ['11:30', '13:30', 'Tigers', 'Blue Jays'],
]);
slate('justice', 'grass-b', 'AA', [['10:00', '12:00', 'Cubs', 'Pirates']]);
slate('justice', 'turf-1', 'Majors', [
  ['08:30', '11:00', 'Mets', 'Braves'],
  ['11:30', '14:00', 'Phillies', 'Yankees'],
]);
slate('justice', 'turf-2', 'AA', [
  ['09:00', '11:00', 'Reds', 'Cardinals'],
  ['11:30', '13:30', 'Pirates', 'Cubs'],
]);
slate('justice', 'softball', 'Softball', [
  ['09:00', '11:00', 'Comets', 'Storm'],
  ['11:15', '13:15', 'Lightning', 'Heat'],
]);

// Bartley takes the Minors slate.
slate('bartley', 'field-1', 'Minors', [
  ['09:00', '11:00', 'Orioles', 'Astros'],
  ['11:30', '13:30', 'Nationals', 'Giants'],
]);
slate('bartley', 'field-2', 'Minors', [['10:00', '12:00', 'Astros', 'Nationals']]);

// 527 is given over to a tournament: all three fields closed for the day.
['minors', 'majors', '60-90'].forEach((slug) => {
  add(fieldBy('527', slug), SHOWCASE, '00:00', '23:59', {
    event_type: 'tournament', division: 'Majors', all_day: 1,
    title: 'Fall Classic — pool play',
    notes: 'Field closed to regular play. Brackets posted at the concession stand.',
  });
});

DB.audit = [
  { id: 5, username: 'jim', action: 'update_settings', entity: 'settings', entity_id: '', detail: 'announcement', created_at: '2026-10-23 08:16:00' },
  { id: 4, username: 'dmartin', action: 'bulk_status', entity: 'events', entity_id: iso(shift(TODAY, toSaturday - 7)), detail: 'rain x1 loc=2', created_at: '2026-10-18 07:42:00' },
  { id: 3, username: 'dmartin', action: 'create_series', entity: 'events', entity_id: '', detail: '4 events, 0 skipped', created_at: '2026-10-15 21:03:00' },
  { id: 2, username: 'jim', action: 'upload_field_map', entity: 'locations', entity_id: '1', detail: '/uploads/holbrook.png', created_at: '2026-10-12 14:28:00' },
  { id: 1, username: 'jim', action: 'create_user', entity: 'users', entity_id: '2', detail: 'dmartin', created_at: '2026-09-04 19:19:00' },
];

/* ---------------- the scheduling rules, same as the server ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const bad = (msg, extra) => Object.assign(new Error(msg), { status: 400 }, extra || {});

function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDaysISO(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function normalize(p) {
  const fieldId = Number(p.fieldId);
  const field = DB.fields.find((f) => f.id === fieldId);
  if (!field) throw bad('Choose a field.');
  const date = clean(p.eventDate, 10);
  if (!isRealDate(date)) throw bad('Enter a valid date.');
  const allDay = p.allDay === true || p.allDay === 'true';
  const st = allDay ? '00:00' : clean(p.startTime, 5);
  const en = allDay ? '23:59' : clean(p.endTime, 5);
  if (!allDay) {
    if (!TIME_RE.test(st)) throw bad('Enter a valid start time.');
    if (!TIME_RE.test(en)) throw bad('Enter a valid end time.');
    if (mins(en) <= mins(st)) throw bad('The end time must be after the start time.');
  }
  const type = clean(p.eventType, 20) || 'game';
  if (!EVENT_TYPES.some((t) => t.value === type)) throw bad('Choose a valid event type.');
  const status = clean(p.status, 20) || 'scheduled';
  if (!STATUSES.some((s) => s.value === status)) throw bad('Choose a valid status.');
  return {
    field_id: fieldId, event_type: type, title: clean(p.title, 120), division: clean(p.division, 60),
    home_team: clean(p.homeTeam, 80), away_team: clean(p.awayTeam, 80),
    event_date: date, start_time: st, end_time: en, all_day: allDay ? 1 : 0,
    notes: clean(p.notes, 1000), status,
  };
}

function conflictsFor(ev, excludeId) {
  return DB.events.filter((e) =>
    e.field_id === ev.field_id && e.event_date === ev.event_date &&
    e.status !== 'canceled' && e.status !== 'rain' && e.id !== excludeId &&
    mins(e.start_time) < mins(ev.end_time) && mins(e.end_time) > mins(ev.start_time)
  ).map(describe);
}
function describe(e) {
  const f = DB.fields.find((x) => x.id === e.field_id);
  const l = DB.locations.find((x) => x.id === f.location_id);
  const who = [e.home_team, e.away_team].filter(Boolean).join(' vs ');
  return { id: e.id, label: e.title || who || e.division || e.event_type,
    locationName: l.name, fieldName: f.name, date: e.event_date,
    startTime: e.start_time, endTime: e.end_time, allDay: !!e.all_day };
}
function shape(e) {
  const f = DB.fields.find((x) => x.id === e.field_id);
  const l = DB.locations.find((x) => x.id === f.location_id);
  return {
    id: e.id, eventType: e.event_type, title: e.title, division: e.division,
    homeTeam: e.home_team, awayTeam: e.away_team, date: e.event_date,
    startTime: e.start_time, endTime: e.end_time, allDay: !!e.all_day,
    notes: e.notes, status: e.status,
    seriesId: e.series_id, fieldId: f.id, fieldName: f.name, fieldSlug: f.slug, fieldKind: f.kind,
    locationId: l.id, locationName: l.name, locationSlug: l.slug,
    locationAddress: l.address, locationMapsQuery: l.maps_query, updatedAt: e.updated_at,
  };
}

function locationsPayload(includeInactive) {
  return DB.locations.slice().sort((a, b) => a.sort_order - b.sort_order).map((l) => ({
    id: l.id, slug: l.slug, name: l.name, address: l.address,
    mapsQuery: l.maps_query || l.address || l.name, latitude: l.latitude, longitude: l.longitude,
    notes: l.notes, mapImage: l.map_image, sortOrder: l.sort_order,
    fields: DB.fields.filter((f) => f.location_id === l.id && (includeInactive || f.active))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((f) => ({ id: f.id, slug: f.slug, name: f.name, kind: f.kind, notes: f.notes, sortOrder: f.sort_order, active: !!f.active })),
    pins: DB.pins.filter((p) => p.location_id === l.id)
      .map((p) => ({ id: p.id, fieldId: p.field_id, label: p.label, x: p.x_pct, y: p.y_pct, color: p.color })),
  }));
}

function listEvents(q, includeInactive) {
  let out = DB.events.slice();
  if (q.from) { if (!isRealDate(q.from)) throw bad('The "from" date is not a valid date.'); out = out.filter((e) => e.event_date >= q.from); }
  if (q.to) { if (!isRealDate(q.to)) throw bad('The "to" date is not a valid date.'); out = out.filter((e) => e.event_date <= q.to); }
  if (!includeInactive) out = out.filter((e) => (DB.fields.find((f) => f.id === e.field_id) || {}).active);
  if (q.location) out = out.filter((e) => (DB.fields.find((f) => f.id === e.field_id) || {}).location_id === Number(q.location));
  if (q.field) out = out.filter((e) => e.field_id === Number(q.field));
  if (q.type) out = out.filter((e) => e.event_type === q.type);
  if (q.division) out = out.filter((e) => (e.division || '').toLowerCase() === String(q.division).toLowerCase());
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    out = out.filter((e) => [e.title, e.home_team, e.away_team, e.division, e.notes]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  return out.sort((a, b) =>
    a.event_date.localeCompare(b.event_date) || a.start_time.localeCompare(b.start_time) || a.field_id - b.field_id
  ).map(shape);
}

function logDemo(action, detail) {
  DB.audit.unshift({ id: Date.now(), username: SESSION.user ? SESSION.user.username : 'jim',
    action, entity: '', entity_id: '', detail: detail || '',
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
}

const SESSION = { user: { id: 1, username: 'jim', displayName: 'Jim Fekete', role: 'owner', mustChange: false } };

/* ---------------- the router ---------------- */

function route(method, url, body) {
  const [pathname, search] = url.split('?');
  const q = Object.fromEntries(new URLSearchParams(search || ''));
  const seg = pathname.split('/').filter(Boolean);
  const b = body || {};

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const s = DB.settings;
    return {
      settings: { leagueName: s.league_name, leagueShort: s.league_short, timezone: s.timezone,
        logoPath: s.logo_path, announcement: s.announcement, announcementLevel: s.announcement_level,
        contactEmail: s.contact_email, seasonLabel: s.season_label },
      locations: locationsPayload(!!SESSION.user),
      eventTypes: EVENT_TYPES, statuses: STATUSES, fieldKinds: FIELD_KINDS,
      divisions: [...new Set(DB.events.map((e) => e.division).filter(Boolean))].sort(),
      teams: [...new Set(DB.events.flatMap((e) => [e.home_team, e.away_team]).filter(Boolean))].sort(),
      today: iso(new Date()), signedIn: !!SESSION.user,
    };
  }

  if (method === 'GET' && pathname === '/api/events') {
    const events = listEvents(q, !!SESSION.user);
    return { events, count: events.length };
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    return { signedIn: !!SESSION.user, user: SESSION.user, csrfToken: 'demo-token', needsSetup: false };
  }
  if (method === 'POST' && pathname === '/api/auth/logout') { return { ok: true }; }
  if (method === 'POST' && pathname === '/api/auth/password') {
    if (String(b.newPassword || '').length < 10) throw bad('Password must be at least 10 characters.');
    logDemo('change_own_password', ''); return { ok: true };
  }

  // ---- events
  if (method === 'POST' && pathname === '/api/admin/events') {
    const every = Number(b.repeatEveryDays || 7);
    const base = normalize(b);
    let repeat = Number(b.repeatCount || 1);
    if (b.repeatUntil) {
      if (!isRealDate(b.repeatUntil)) throw bad('Enter a valid date to repeat until.');
      if (b.repeatUntil < base.event_date) throw bad('The repeat-until date is before the first date.');
      repeat = 0;
      for (let d = base.event_date; d <= b.repeatUntil; d = addDaysISO(d, every)) {
        repeat += 1;
        if (repeat > 60) throw bad('That would create more than 60 events. Choose an earlier end date, or repeat less often.');
      }
    }
    if (repeat > 1) {
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 60) throw bad('Repeat count must be between 1 and 60.');
      const sid = 'series-' + DB.nextId.event;
      const created = []; const skipped = [];
      for (let i = 0; i < repeat; i += 1) {
        const occ = Object.assign({}, base, { event_date: addDaysISO(base.event_date, i * every) });
        const c = conflictsFor(occ, null);
        if (c.length && !b.allowConflict) { skipped.push({ date: occ.event_date, conflicts: c }); continue; }
        const row = Object.assign({ id: DB.nextId.event++, series_id: sid, updated_at: '' }, occ);
        DB.events.push(row); created.push(shape(row));
      }
      if (!created.length) throw Object.assign(new Error('Every date in that series is already booked.'), { status: 409, conflicts: skipped.flatMap((s) => s.conflicts) });
      logDemo('create_series', `${created.length} events, ${skipped.length} skipped`);
      return { events: created, skipped, seriesId: sid };
    }
    const c = conflictsFor(base, null);
    if (c.length && !b.allowConflict) throw Object.assign(new Error('That field is already booked for part of this time.'), { status: 409, conflicts: c });
    const row = Object.assign({ id: DB.nextId.event++, series_id: null, updated_at: '' }, base);
    DB.events.push(row); logDemo('create_event', describe(row).label);
    return { event: shape(row) };
  }

  if (method === 'PUT' && seg[1] === 'admin' && seg[2] === 'events') {
    const id = Number(seg[3]);
    const idx = DB.events.findIndex((e) => e.id === id);
    if (idx < 0) throw Object.assign(new Error('That event no longer exists.'), { status: 404 });
    const next = normalize(b);
    const c = conflictsFor(next, id);
    if (c.length && !b.allowConflict) throw Object.assign(new Error('That field is already booked for part of this time.'), { status: 409, conflicts: c });
    DB.events[idx] = Object.assign({}, DB.events[idx], next);
    logDemo('update_event', describe(DB.events[idx]).label);
    return { event: shape(DB.events[idx]) };
  }

  if (method === 'DELETE' && seg[1] === 'admin' && seg[2] === 'events') {
    const id = Number(seg[3]);
    const idx = DB.events.findIndex((e) => e.id === id);
    if (idx < 0) throw Object.assign(new Error('That event no longer exists.'), { status: 404 });
    const [gone] = DB.events.splice(idx, 1);
    logDemo('delete_event', describe(gone).label);
    return { ok: true, event: shape(gone) };
  }

  if (method === 'DELETE' && seg[1] === 'admin' && seg[2] === 'series') {
    const sid = decodeURIComponent(seg[3]);
    if (q.from !== undefined && !isRealDate(q.from)) throw bad('That is not a valid date to delete from.');
    const before = DB.events.length;
    DB.events = DB.events.filter((e) => !(e.series_id === sid && (!q.from || e.event_date >= q.from)));
    const removed = before - DB.events.length;
    logDemo('delete_series', `removed ${removed}`);
    return { ok: true, removed };
  }

  if (method === 'POST' && pathname === '/api/admin/events/bulk-status') {
    if (!isRealDate(b.date)) throw bad('Enter a valid date.');
    if (!STATUSES.some((s) => s.value === b.status)) throw bad('Choose a valid status.');
    let ids = null;
    if (b.fieldIds !== undefined) {
      if (!Array.isArray(b.fieldIds)) throw bad('Choose which fields are affected.');
      ids = [...new Set(b.fieldIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) throw bad('Pick at least one field.');
    } else if (b.locationId) {
      ids = DB.fields.filter((f) => f.location_id === Number(b.locationId)).map((f) => f.id);
    }
    let n = 0;
    DB.events.forEach((e) => {
      if (e.event_date !== b.date) return;
      if (ids && !ids.includes(e.field_id)) return;
      e.status = b.status; n += 1;
    });
    logDemo('bulk_status', `${b.status} x${n}${ids ? ` fields=${ids.length}` : ' (all fields)'}`);
    return { ok: true, updated: n };
  }

  // ---- locations & fields
  if (method === 'POST' && pathname === '/api/admin/locations') {
    const name = clean(b.name, 80);
    if (!name) throw bad('Enter a location name.');
    DB.locations.push({ id: DB.nextId.location++, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name, address: '', maps_query: name, latitude: null, longitude: null, notes: '', map_image: null,
      sort_order: DB.locations.length + 1 });
    logDemo('create_location', name);
    return { locations: locationsPayload(true) };
  }
  if (method === 'PUT' && seg[1] === 'admin' && seg[2] === 'locations' && seg.length === 4) {
    const loc = DB.locations.find((l) => l.id === Number(seg[3]));
    if (!loc) throw Object.assign(new Error('That location no longer exists.'), { status: 404 });
    const name = clean(b.name == null ? loc.name : b.name, 80);
    if (!name) throw bad('Enter a location name.');
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const lat = num(b.latitude); const lng = num(b.longitude);
    if (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) throw bad('Latitude must be between -90 and 90.');
    if (lng != null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) throw bad('Longitude must be between -180 and 180.');
    Object.assign(loc, { name, address: clean(b.address, 240), maps_query: clean(b.mapsQuery, 240),
      notes: clean(b.notes, 500), latitude: lat, longitude: lng });
    logDemo('update_location', name);
    return { locations: locationsPayload(true) };
  }
  if (method === 'DELETE' && seg[1] === 'admin' && seg[2] === 'locations' && seg.length === 4) {
    const id = Number(seg[3]);
    const loc = DB.locations.find((l) => l.id === id);
    const fieldIds = DB.fields.filter((f) => f.location_id === id).map((f) => f.id);
    const count = DB.events.filter((e) => fieldIds.includes(e.field_id)).length;
    if (count && !q.force) throw Object.assign(new Error(`${loc.name} still has ${count} scheduled event(s). Remove them first, or confirm deletion.`), { status: 409, eventCount: count });
    DB.events = DB.events.filter((e) => !fieldIds.includes(e.field_id));
    DB.fields = DB.fields.filter((f) => f.location_id !== id);
    DB.pins = DB.pins.filter((p) => p.location_id !== id);
    DB.locations = DB.locations.filter((l) => l.id !== id);
    logDemo('delete_location', loc.name);
    return { ok: true, locations: locationsPayload(true) };
  }
  if (method === 'PUT' && seg[2] === 'locations' && seg[4] === 'pins') {
    const id = Number(seg[3]);
    if (!Array.isArray(b.pins)) throw bad('No map labels were submitted.');
    if (b.pins.length > 60) throw bad('A map can hold at most 60 labels.');
    const valid = new Set(DB.fields.filter((f) => f.location_id === id).map((f) => f.id));
    const next = b.pins.map((p) => {
      if (!p || typeof p !== 'object') throw bad('That map label is not in a readable form.');
      const label = clean(p.label, 60);
      if (!label) throw bad('Every map label needs text.');
      const x = Number(p.x); const y = Number(p.y);
      if (!Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100) throw bad('Map labels must sit inside the image.');
      const fid = Number(p.fieldId);
      return { id: DB.nextId.pin++, location_id: id, field_id: valid.has(fid) ? fid : null,
        label, x_pct: x, y_pct: y, color: /^#[0-9a-fA-F]{6}$/.test(String(p.color || '')) ? p.color : '#1d4ed8' };
    });
    DB.pins = DB.pins.filter((p) => p.location_id !== id).concat(next);
    logDemo('update_field_map_pins', `${next.length} labels`);
    return { locations: locationsPayload(true) };
  }
  if (method === 'DELETE' && seg[2] === 'locations' && seg[4] === 'map') {
    const id = Number(seg[3]);
    const loc = DB.locations.find((l) => l.id === id);
    loc.map_image = null; DB.pins = DB.pins.filter((p) => p.location_id !== id);
    logDemo('remove_field_map', loc.name);
    return { ok: true, locations: locationsPayload(true) };
  }
  if (method === 'POST' && seg[2] === 'locations' && seg[4] === 'map') {
    const id = Number(seg[3]);
    const loc = DB.locations.find((l) => l.id === id);
    loc.map_image = b.__dataUrl || null;
    logDemo('upload_field_map', loc.name);
    return { mapImage: loc.map_image, locations: locationsPayload(true) };
  }

  if (method === 'POST' && pathname === '/api/admin/fields') {
    const name = clean(b.name, 80);
    if (!name) throw bad('Enter a field name.');
    const locId = Number(b.locationId);
    DB.fields.push({ id: DB.nextId.field++, location_id: locId,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name,
      kind: FIELD_KINDS.some((k) => k.value === b.kind) ? b.kind : 'baseball', notes: '',
      sort_order: DB.fields.filter((f) => f.location_id === locId).length + 1, active: 1 });
    logDemo('create_field', name);
    return { locations: locationsPayload(true) };
  }
  if (method === 'PUT' && seg[2] === 'fields') {
    const f = DB.fields.find((x) => x.id === Number(seg[3]));
    if (!f) throw Object.assign(new Error('That field no longer exists.'), { status: 404 });
    const name = clean(b.name == null ? f.name : b.name, 80);
    if (!name) throw bad('Enter a field name.');
    f.name = name;
    if (FIELD_KINDS.some((k) => k.value === b.kind)) f.kind = b.kind;
    if (b.sortOrder !== undefined && String(b.sortOrder).trim() !== '' && Number.isInteger(Number(b.sortOrder))) f.sort_order = Number(b.sortOrder);
    if (b.active !== undefined) f.active = b.active ? 1 : 0;
    logDemo('update_field', name);
    return { locations: locationsPayload(true) };
  }
  if (method === 'DELETE' && seg[2] === 'fields') {
    const id = Number(seg[3]);
    const f = DB.fields.find((x) => x.id === id);
    const count = DB.events.filter((e) => e.field_id === id).length;
    if (count && !q.force) throw Object.assign(new Error(`${f.name} still has ${count} scheduled event(s). Mark it inactive to hide it, or confirm deletion.`), { status: 409, eventCount: count });
    DB.events = DB.events.filter((e) => e.field_id !== id);
    DB.fields = DB.fields.filter((x) => x.id !== id);
    logDemo('delete_field', f.name);
    return { ok: true, locations: locationsPayload(true) };
  }

  // ---- settings, logo
  if (method === 'PUT' && pathname === '/api/admin/settings') {
    const map = { leagueName: 'league_name', leagueShort: 'league_short', timezone: 'timezone',
      announcement: 'announcement', announcementLevel: 'announcement_level',
      contactEmail: 'contact_email', seasonLabel: 'season_label' };
    Object.entries(map).forEach(([k, dbk]) => {
      if (b[k] === undefined) return;
      if (dbk === 'timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: String(b[k]) }); } catch (e) { throw bad(`"${b[k]}" is not a valid timezone name.`); } }
      DB.settings[dbk] = String(b[k]).slice(0, 500);
    });
    logDemo('update_settings', Object.keys(b).join(','));
    return { settings: DB.settings };
  }
  if (method === 'POST' && pathname === '/api/admin/logo') { DB.settings.logo_path = b.__dataUrl || ''; logDemo('upload_logo', ''); return { logoPath: DB.settings.logo_path }; }
  if (method === 'DELETE' && pathname === '/api/admin/logo') { DB.settings.logo_path = ''; logDemo('remove_logo', ''); return { ok: true, logoPath: '' }; }

  // ---- users
  if (method === 'GET' && pathname === '/api/admin/users') {
    return { users: DB.users.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name,
      role: u.role, active: !!u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at })) };
  }
  if (method === 'POST' && pathname === '/api/admin/users') {
    if (SESSION.user.role !== 'owner') throw Object.assign(new Error('Only an owner can manage admin accounts.'), { status: 403 });
    const username = clean(b.username, 40);
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw bad('Username must be 3-40 characters: letters, numbers, . _ - only.');
    if (String(b.password || '').length < 10) throw bad('Password must be at least 10 characters.');
    if (!/[0-9]/.test(String(b.password))) throw bad('Password must include at least one number.');
    if (DB.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw Object.assign(new Error('That username is already taken.'), { status: 409 });
    const u = { id: DB.nextId.user++, username, display_name: clean(b.displayName, 80) || username,
      role: b.role === 'owner' ? 'owner' : 'admin', active: 1,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), last_login_at: null };
    DB.users.push(u); logDemo('create_user', username);
    return { user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role } };
  }
  if (seg[2] === 'users' && seg[4] === 'password') {
    if (SESSION.user.role !== 'owner') throw Object.assign(new Error('Only an owner can manage admin accounts.'), { status: 403 });
    if (String(b.password || '').length < 10) throw bad('Password must be at least 10 characters.');
    logDemo('reset_password', ''); return { ok: true };
  }
  if (method === 'PUT' && seg[2] === 'users') {
    if (SESSION.user.role !== 'owner') throw Object.assign(new Error('Only an owner can manage admin accounts.'), { status: 403 });
    const u = DB.users.find((x) => x.id === Number(seg[3]));
    if (!u) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });
    const nextActive = b.active === undefined ? u.active : (b.active ? 1 : 0);
    if (!nextActive && u.id === SESSION.user.id) throw bad('You cannot deactivate your own account.');
    if (!nextActive && u.active && DB.users.filter((x) => x.active).length <= 1) throw bad('At least one active admin must remain.');
    u.active = nextActive;
    if (b.displayName !== undefined) u.display_name = clean(b.displayName, 80);
    if (b.role === 'owner' || b.role === 'admin') u.role = b.role;
    logDemo('update_user', u.username);
    return { user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role } };
  }
  if (method === 'DELETE' && seg[2] === 'users') {
    if (SESSION.user.role !== 'owner') throw Object.assign(new Error('Only an owner can manage admin accounts.'), { status: 403 });
    const u = DB.users.find((x) => x.id === Number(seg[3]));
    if (!u) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });
    if (u.id === SESSION.user.id) throw bad('You cannot delete your own account.');
    if (u.active && DB.users.filter((x) => x.active).length <= 1) throw bad('At least one active admin must remain.');
    if (u.role === 'owner' && DB.users.filter((x) => x.active && x.role === 'owner').length <= 1) throw bad('At least one owner must remain.');
    DB.users = DB.users.filter((x) => x.id !== u.id); logDemo('delete_user', u.username);
    return { ok: true };
  }

  if (method === 'GET' && pathname === '/api/admin/audit') {
    return { entries: DB.audit.slice(0, Number(q.limit) || 100).map((a) => ({
      id: a.id, username: a.username, action: a.action, entity: a.entity,
      entityId: a.entity_id, detail: a.detail, createdAt: a.created_at })) };
  }

  throw Object.assign(new Error('Not found.'), { status: 404 });
}

/* Replaces the network layer in common.js. Same contract, same errors. */
api.request = function demoRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        let payload = body;
        if (body instanceof FormData) {
          const file = body.get('image');
          if (file && file.size) {
            const reader = new FileReader();
            reader.onload = () => {
              try { resolve(route(method, url, { __dataUrl: reader.result })); }
              catch (err) { reject(err); }
            };
            reader.onerror = () => reject(new Error('That image could not be read.'));
            reader.readAsDataURL(file);
            return;
          }
          payload = {};
        }
        resolve(route(method, url, payload));
      } catch (err) { reject(err); }
    };
    setTimeout(run, 60); // a touch of latency, so loading states are real
  });
};
