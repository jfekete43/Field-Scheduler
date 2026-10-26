/* Admin console. */
'use strict';

const admin = {
  me: null,
  boot: null,
  events: [],
  users: [],
  tab: 'schedule',
  filters: { from: '', to: '', location: '', field: '', type: '', q: '' },
  editing: null,     // event being edited, or null when adding
  mapEditor: null,   // { location, pins, selectedIndex }
  requestId: 0,      // guards against a slow earlier fetch landing last
  rainout: { date: '', events: [], selected: new Set(), loading: false, token: 0 },
  scheduleView: 'timeline',   // 'timeline' or 'list'
  timelineDate: '',       // the single day the timeline shows
};

/**
 * Which fields a rain-out should tick by default.
 *
 * The indoor cages are unaffected by weather, and turf drains long after grass
 * has given up, so neither is assumed out. Both can still be ticked by hand for
 * the snow day or the washout that takes everything.
 */
function rainDefault(kind) {
  return kind !== 'cage' && kind !== 'turf';
}

function rainReason(kind) {
  if (kind === 'cage') return { label: 'Indoor', className: 'indoor' };
  if (kind === 'turf') return { label: 'Drains well', className: 'drains' };
  return null;
}

/* ================================================================
   Boot
   ================================================================ */

async function init() {
  wireModals();

  try {
    const me = await api.get('/api/auth/me', { quiet: true });
    if (!me.signedIn) { window.location.href = '/admin/login'; return; }
    admin.me = me.user;
    api.csrfToken = me.csrfToken;
  } catch {
    window.location.href = '/admin/login';
    return;
  }

  $('#who').textContent = `${admin.me.displayName}${admin.me.role === 'owner' ? ' (owner)' : ''}`;

  await refreshBoot();

  const today = admin.boot.today;
  admin.filters.from = today;
  admin.filters.to = addDays(today, 30);
  $('#a-from').value = admin.filters.from;
  $('#a-to').value = admin.filters.to;

  admin.timelineDate = admin.boot.today;
  applyScheduleViewChrome();

  wireTabs();
  wireSchedule();
  wireBranding();
  wireAdmins();
  wireMisc();

  await loadEvents();
}

async function refreshBoot() {
  admin.boot = await api.get('/api/bootstrap');
  setBranding(admin.boot.settings);
  populateSelects();
}

function populateSelects() {
  const { locations, eventTypes, statuses, divisions, teams } = admin.boot;

  const select = $('#a-location');
  const keep = select.value;
  clear(select).append(h('option', { value: '' }, 'All locations'));
  locations.forEach((loc) => select.append(h('option', { value: String(loc.id) }, loc.name)));
  if (keep) select.value = keep;

  rebuildAdminFieldOptions();

  // Event editor: one flat list grouped by location so duplicate field
  // names (Majors, 60/90) can never be mixed up.
  const fieldSelect = $('#e-field');
  clear(fieldSelect).append(h('option', { value: '' }, 'Choose a field…'));
  locations.forEach((loc) => {
    const group = h('optgroup', { label: loc.name });
    loc.fields.forEach((field) =>
      group.append(h('option', { value: String(field.id) },
        `${field.name}${field.kind === 'cage' ? ' (cage)' : ''}`)));
    if (loc.fields.length) fieldSelect.append(group);
  });

  [['#a-type', 'All types'], ['#e-type', null]].forEach(([sel, allLabel]) => {
    const select = $(sel);
    const keep = select.value;
    clear(select);
    if (allLabel) select.append(h('option', { value: '' }, allLabel));
    eventTypes.forEach((type) => select.append(h('option', { value: type.value }, type.label)));
    if (keep) select.value = keep;
  });

  [['#e-status', statuses], ['#r-status', statuses.filter((s) => s.value !== 'scheduled')]]
    .forEach(([sel, list]) => {
      const select = $(sel);
      clear(select);
      list.forEach((item) => select.append(h('option', { value: item.value }, item.label)));
    });
  $('#r-status').value = 'rain';
  $('#r-status').addEventListener('change', updateRainoutCount);

  const divList = clear($('#division-list'));
  divisions.forEach((div) => divList.append(h('option', { value: div })));
  const teamList = clear($('#team-list'));
  teams.forEach((team) => teamList.append(h('option', { value: team })));
}

function rebuildAdminFieldOptions() {
  const select = $('#a-field');
  const keep = select.value;
  clear(select).append(h('option', { value: '' }, 'All fields'));
  const pool = admin.filters.location
    ? admin.boot.locations.filter((loc) => String(loc.id) === admin.filters.location)
    : admin.boot.locations;
  pool.forEach((loc) => {
    const group = h('optgroup', { label: loc.name });
    loc.fields.forEach((field) => group.append(h('option', { value: String(field.id) }, field.name)));
    if (loc.fields.length) select.append(group);
  });
  if (keep && select.querySelector(`option[value="${keep}"]`)) select.value = keep;
  else select.value = '';
}

/* ================================================================
   Tabs
   ================================================================ */

function wireTabs() {
  $$('.admin-tabs [data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
}

function showTab(tab) {
  admin.tab = tab;
  $$('.admin-tabs [data-tab]').forEach((btn) =>
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab)));
  ['schedule', 'locations', 'branding', 'admins', 'activity'].forEach((name) => {
    $(`#tab-${name}`).hidden = name !== tab;
  });

  if (tab === 'locations') renderLocationsAdmin();
  if (tab === 'branding') fillBrandingForm();
  if (tab === 'admins') loadUsers();
  if (tab === 'activity') loadAudit();
}

function wireMisc() {
  $('#btn-logout').addEventListener('click', async () => {
    await api.post('/api/auth/logout', {}).catch(() => {});
    window.location.href = '/';
  });

  $('#btn-my-password').addEventListener('click', () => {
    clear($('#password-form-error'));
    $('#password-form').reset();
    openModal($('#password-modal'));
  });

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const slot = clear($('#password-form-error'));
    const current = $('#p-current').value;
    const next = $('#p-new').value;
    if (next !== $('#p-confirm').value) {
      slot.append(h('div', { class: 'form-error' }, 'The new passwords do not match.'));
      return;
    }
    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
      closeModal($('#password-modal'));
      toast('Your password was updated.', 'success');
    } catch (err) {
      slot.append(h('div', { class: 'form-error' }, err.message));
    }
  });
}

/** Promise-based confirm dialog. */
function confirmAction({ title = 'Please Confirm', message, confirmLabel = 'Yes, Continue' }) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-modal-title').textContent = title;
    const body = clear($('#confirm-modal-body'));
    (Array.isArray(message) ? message : [message]).forEach((line) =>
      body.append(h('p', { style: 'margin:0 0 9px;font-size:14.5px' }, line)));

    const yes = $('#btn-confirm-yes');
    yes.textContent = confirmLabel;

    const cleanup = (result) => {
      yes.removeEventListener('click', onYes);
      modal.removeEventListener('close', onClose);
      resolve(result);
    };
    const onYes = () => { closeModal(modal); cleanup(true); };
    const onClose = () => cleanup(false);

    yes.addEventListener('click', onYes);
    modal.addEventListener('close', onClose, { once: true });
    openModal(modal);
  });
}

/* ================================================================
   Schedule tab
   ================================================================ */

function wireSchedule() {
  const reload = () => {
    admin.filters.from = $('#a-from').value;
    admin.filters.to = $('#a-to').value;
    admin.filters.location = $('#a-location').value;
    admin.filters.field = $('#a-field').value;
    admin.filters.type = $('#a-type').value;
    loadEvents();
  };

  ['#a-from', '#a-to', '#a-type', '#a-field'].forEach((sel) =>
    $(sel).addEventListener('change', reload));

  $('#a-location').addEventListener('change', () => {
    admin.filters.location = $('#a-location').value;
    admin.filters.field = '';
    rebuildAdminFieldOptions();
    reload();
  });

  $('#a-search').addEventListener('input', debounce(() => {
    admin.filters.q = $('#a-search').value.trim();
    loadEvents();
  }, 300));

  $('#btn-a-reset').addEventListener('click', () => {
    admin.filters = {
      from: admin.boot.today, to: addDays(admin.boot.today, 30),
      location: '', field: '', type: '', q: '',
    };
    $('#a-from').value = admin.filters.from;
    $('#a-to').value = admin.filters.to;
    $('#a-location').value = '';
    $('#a-type').value = '';
    $('#a-search').value = '';
    // Cleared before the rebuild, which otherwise restores the previous
    // selection and leaves a filter applied that the controls do not show.
    $('#a-field').value = '';
    rebuildAdminFieldOptions();
    loadEvents();
  });

  $$('[data-admin-view]').forEach((btn) => {
    btn.addEventListener('click', () => setScheduleView(btn.dataset.adminView));
  });

  $('#btn-tl-prev').addEventListener('click', () => shiftTimeline(-1));
  $('#btn-tl-next').addEventListener('click', () => shiftTimeline(1));
  $('#btn-tl-today').addEventListener('click', () => {
    admin.timelineDate = admin.boot.today;
    loadEvents();
  });

  $('#btn-new-event').addEventListener('click', () => openEventEditor(null));
  $('#event-form').addEventListener('submit', saveEvent);
  $('#btn-delete-event').addEventListener('click', deleteCurrentEvent);

  $('#e-all-day').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('#field-start').hidden = on;
    $('#field-end').hidden = on;
    $('#field-through').hidden = !on;
    $('#e-start').required = !on;
    $('#e-end').required = !on;
    // All day and Repeat would fight over the same dates, so only one applies.
    $('#repeat-box').hidden = on || !!admin.editing;
    if (on) {
      $('#e-repeat').checked = false;
      $('#repeat-options').hidden = true;
    } else {
      $('#e-through').value = '';
    }
  });

  $('#e-repeat').addEventListener('change', (e) => {
    $('#repeat-options').hidden = !e.target.checked;
    if (e.target.checked && !$('#e-repeat-until').value) {
      // A sensible first guess: eight weeks out from the event's own date.
      $('#e-repeat-until').value = addDays($('#e-date').value || admin.boot.today, 7 * 7);
    }
    updateRepeatSummary();
  });

  ['#e-repeat-every', '#e-repeat-count', '#e-repeat-until', '#e-end-count', '#e-end-until', '#e-date']
    .forEach((sel) => {
      $(sel).addEventListener('change', updateRepeatSummary);
      $(sel).addEventListener('input', updateRepeatSummary);
    });

  // Typing in a box picks the matching option, so the two never disagree.
  $('#e-repeat-count').addEventListener('focus', () => { $('#e-end-count').checked = true; updateRepeatSummary(); });
  $('#e-repeat-until').addEventListener('focus', () => { $('#e-end-until').checked = true; updateRepeatSummary(); });

  $('#btn-rainout').addEventListener('click', () => {
    $('#r-date').value = admin.filters.from || admin.boot.today;
    openModal($('#rainout-modal'));
    loadRainoutDay();
  });

  $('#r-date').addEventListener('change', loadRainoutDay);

  $('#r-suggest').addEventListener('click', () => applyRainSelection('suggested'));
  $('#r-all').addEventListener('click', () => applyRainSelection('all'));
  $('#r-none').addEventListener('click', () => applyRainSelection('none'));

  $('#rainout-form').addEventListener('submit', submitRainout);
}

/* ---------------- Rain out a day ---------------- */

async function loadRainoutDay() {
  const date = $('#r-date').value;
  const picker = clear($('#rainout-picker'));
  admin.rainout.date = date;

  if (!date) {
    picker.append(h('p', { class: 'hint' }, 'Pick a date to see what is scheduled.'));
    updateRainoutCount();
    return;
  }

  picker.append(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton-row' })));
  const token = ++admin.rainout.token;

  try {
    const data = await api.get(`/api/events?from=${date}&to=${date}`);
    if (token !== admin.rainout.token) return; // a newer date already answered
    admin.rainout.events = data.events;
    applyRainSelection('suggested');
  } catch (err) {
    if (token !== admin.rainout.token) return;
    clear($('#rainout-picker')).append(h('p', { class: 'form-error' }, err.message));
  }
}

/** Ticks a preset, then redraws. */
function applyRainSelection(mode) {
  const selected = new Set();
  for (const event of admin.rainout.events) {
    if (mode === 'all') selected.add(event.fieldId);
    else if (mode === 'suggested' && rainDefault(event.fieldKind)) selected.add(event.fieldId);
  }
  admin.rainout.selected = selected;
  renderRainoutPicker();
}

function renderRainoutPicker() {
  const picker = clear($('#rainout-picker'));
  const { events, selected } = admin.rainout;

  if (!events.length) {
    picker.append(
      h('div', { class: 'empty', style: 'padding:26px 16px' },
        h('h3', {}, 'Nothing scheduled that day'),
        h('p', {}, 'There is nothing to call off on this date.'))
    );
    updateRainoutCount();
    return;
  }

  // Count the day's events per field.
  const counts = new Map();
  for (const event of events) {
    counts.set(event.fieldId, (counts.get(event.fieldId) || 0) + 1);
  }

  // Walk the locations and fields in their configured order, so the list reads
  // the same way as everywhere else rather than in first-game-of-the-day order.
  const byLocation = admin.boot.locations
    .map((loc) => ({
      name: loc.name,
      fields: new Map(
        loc.fields
          .filter((f) => counts.has(f.id))
          .map((f) => [f.id, { name: f.name, kind: f.kind, count: counts.get(f.id) }])
      ),
    }))
    .filter((loc) => loc.fields.size);

  for (const loc of byLocation) {
    const fieldIds = [...loc.fields.keys()];
    const total = [...loc.fields.values()].reduce((sum, f) => sum + f.count, 0);
    const allOn = fieldIds.every((id) => selected.has(id));

    const block = h('div', { class: 'rain-loc' },
      h('div', { class: 'rain-loc-head' },
        loc.name,
        h('span', { class: 'rain-loc-count' }, total === 1 ? '1 event' : `${total} events`),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onClick: () => {
            fieldIds.forEach((id) => (allOn ? selected.delete(id) : selected.add(id)));
            renderRainoutPicker();
          },
        }, allOn ? 'Clear site' : 'Whole site')));

    for (const [fieldId, field] of loc.fields) {
      const on = selected.has(fieldId);
      const why = rainReason(field.kind);
      block.append(
        h('label', { class: `rain-field${on ? '' : ' is-off'}` },
          h('input', {
            type: 'checkbox', checked: on,
            onChange: (e) => {
              if (e.target.checked) selected.add(fieldId);
              else selected.delete(fieldId);
              renderRainoutPicker();
            },
          }),
          h('span', { class: 'rain-name' }, field.name),
          h('span', { class: 'rain-count' }, field.count === 1 ? '1 event' : `${field.count} events`),
          h('span', { class: 'spacer' }),
          why ? h('span', { class: `rain-why ${why.className}` }, why.label) : null)
      );
    }
    picker.append(block);
  }

  updateRainoutCount();
}

function updateRainoutCount() {
  const { events, selected } = admin.rainout;
  const affected = events.filter((e) => selected.has(e.fieldId)).length;
  const status = labelFor(admin.boot.statuses, $('#r-status').value);

  $('#rainout-count').textContent = !events.length
    ? ''
    : affected === 0
      ? 'No fields ticked'
      : `${affected} of ${events.length} event(s) \u2192 ${status}`;

  $('#r-apply').disabled = affected === 0;
}

async function submitRainout(event) {
  event.preventDefault();
  const { date, selected, events } = admin.rainout;
  const status = $('#r-status').value;
  const fieldIds = [...selected];
  const affected = events.filter((e) => selected.has(e.fieldId));

  if (!affected.length) {
    toast('Tick at least one field.', 'error');
    return;
  }

  const spared = events.length - affected.length;
  const ok = await confirmAction({
    title: `Mark ${affected.length} event(s) as ${labelFor(admin.boot.statuses, status)}?`,
    message: [
      `On ${formatDateLong(date)}.`,
      spared
        ? `${spared} event(s) on the fields you left unticked carry on as scheduled.`
        : 'Every event that day is affected.',
      'You can change individual events back afterwards.',
    ],
    confirmLabel: 'Apply',
  });
  if (!ok) return;

  try {
    const result = await api.post('/api/admin/events/bulk-status', { date, status, fieldIds });
    closeModal($('#rainout-modal'));
    toast(`${result.updated} event(s) updated.`, 'success');
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  const timeline = admin.scheduleView === 'timeline';

  if (timeline) {
    const date = admin.timelineDate || admin.boot.today;
    admin.timelineDate = date;
    params.set('from', date);
    params.set('to', date);
  } else {
    if (admin.filters.from) params.set('from', admin.filters.from);
    if (admin.filters.to) params.set('to', admin.filters.to);
  }
  if (admin.filters.location) params.set('location', admin.filters.location);
  if (admin.filters.field) params.set('field', admin.filters.field);
  if (admin.filters.type) params.set('type', admin.filters.type);
  if (admin.filters.q) params.set('q', admin.filters.q);

  const root = $('#admin-schedule-root');
  root.replaceChildren(h('div', { class: 'skeleton' },
    h('div', { class: 'skeleton-row' }), h('div', { class: 'skeleton-row' })));

  const requestId = ++admin.requestId;

  try {
    const data = await api.get(`/api/events?${params}`);
    if (requestId !== admin.requestId) return; // a newer request already answered
    admin.events = data.events;
    renderStats();
    renderAdminSchedule();
  } catch (err) {
    if (requestId !== admin.requestId) return;
    root.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Could not load events'), h('p', {}, err.message)));
  }
}

function renderStats() {
  const row = clear($('#stat-row'));
  const events = admin.events;
  const games = events.filter((e) => e.eventType === 'game').length;
  const cage = events.filter((e) => e.eventType === 'cage' || e.fieldKind === 'cage').length;
  const off = events.filter((e) => e.status !== 'scheduled').length;
  const locationCount = new Set(events.map((e) => e.locationId)).size;

  [
    [admin.scheduleView === 'timeline' ? 'That day' : 'In range', events.length],
    ['Games', games],
    ['Cage sessions', cage],
    ['Not playing', off],
    ['Sites in use', locationCount],
  ].forEach(([label, value]) => {
    row.append(h('div', { class: 'stat' },
      h('div', { class: 'stat-value' }, String(value)),
      h('div', { class: 'stat-label' }, label)));
  });
}

function setScheduleView(view) {
  if (admin.scheduleView === view) return;
  admin.scheduleView = view;
  applyScheduleViewChrome();
  loadEvents();
}

/** The two views need different controls, so show only the ones that apply. */
function applyScheduleViewChrome() {
  const view = admin.scheduleView;
  $$('[data-admin-view]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.adminView === view)));

  const timeline = view === 'timeline';
  $('#admin-day-nav').hidden = !timeline;
  // The timeline has its own day arrows, so a From/To range would contradict it.
  $('#field-a-from').hidden = timeline;
  $('#field-a-to').hidden = timeline;

  if (timeline && !admin.timelineDate) {
    admin.timelineDate = admin.filters.from || admin.boot.today;
  }
}

function shiftTimeline(direction) {
  admin.timelineDate = addDays(admin.timelineDate || admin.boot.today, direction);
  loadEvents();
}

/** The timeline shows one day, so it asks for that day rather than the range. */
function renderAdminTimeline() {
  const root = clear($('#admin-schedule-root'));
  const date = admin.timelineDate;
  $('#tl-date-label').textContent = formatDateLong(date);

  renderTimeline(root, {
    events: admin.events,
    locations: admin.boot.locations,
    date,
    today: admin.boot.today,
    labels: admin.boot.eventTypes,
    onEventClick: (event) => openEventEditor(event),
    onEmptyClick: (field, location, time) => {
      const endHour = String(Math.min(23, Number(time.slice(0, 2)) + 2)).padStart(2, '0');
      openEventEditor(null, {
        date,
        fieldId: field.id,
        startTime: time,
        endTime: `${endHour}:${time.slice(3)}`,
      });
    },
  });
}

function renderAdminSchedule() {
  if (admin.scheduleView === 'timeline') return renderAdminTimeline();

  const root = clear($('#admin-schedule-root'));

  if (!admin.events.length) {
    root.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '⚾'),
      h('h3', {}, 'No events in this range'),
      h('p', {}, 'Adjust the dates above, or add the first event.')));
    return;
  }

  const byDate = new Map();
  admin.events.forEach((event) => {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  });

  for (const [date, events] of byDate) {
    const table = h('table', { class: 'data' },
      h('thead', {},
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Location / Field'),
          h('th', {}, 'Event'),
          h('th', {}, 'Type'),
          h('th', {}, 'Status'),
          h('th', {}, ''))),
      h('tbody', {}, events.map(adminEventRow)));

    root.append(
      h('div', { class: 'day-block' },
        h('div', { class: `day-heading${date === admin.boot.today ? ' is-today' : ''}` },
          h('h3', {}, formatDateMedium(date)),
          h('span', { class: 'day-count' }, events.length === 1 ? '1 event' : `${events.length} events`),
          h('span', { class: 'spacer' }),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onClick: () => openEventEditor(null, { date }),
          }, '+ Add on this day')),
        h('div', { class: 'table-wrap' }, table))
    );
  }
}

function adminEventRow(event) {
  const headline = eventHeadline(event) || labelFor(admin.boot.eventTypes, event.eventType);
  return h('tr', {},
    h('td', { class: 'num', style: 'white-space:nowrap' }, describeWhen(event)),
    h('td', {}, h('strong', {}, event.locationName), ' · ', event.fieldName),
    h('td', {},
      h('div', { style: 'font-weight:600' }, headline),
      event.division ? h('div', { class: 'inline-note' }, event.division) : null,
      event.notes ? h('div', { class: 'inline-note' }, event.notes.length > 70 ? `${event.notes.slice(0, 70)}…` : event.notes) : null),
    h('td', {}, h('span', { class: `badge badge-${event.eventType}` },
      labelFor(admin.boot.eventTypes, event.eventType))),
    h('td', {}, event.status === 'scheduled'
      ? h('span', { class: 'inline-note' }, 'Scheduled')
      : h('span', { class: `status-flag ${event.status}` }, labelFor(admin.boot.statuses, event.status))),
    h('td', { class: 'actions' },
      event.seriesId
        ? h('button', { class: 'btn btn-sm', type: 'button', title: 'Delete the whole repeating series',
            onClick: () => deleteSeries(event) }, 'Series')
        : null,
      ' ',
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => openEventEditor(event) }, 'Edit'))
  );
}

/* ---------------- Event editor ---------------- */

const MAX_OCCURRENCES = 60;

/** The dates a repeat would actually produce, given what is on the form. */
function repeatDates() {
  const start = $('#e-date').value;
  const every = Number($('#e-repeat-every').value) || 7;
  if (!start) return { dates: [], error: null };

  if ($('#e-end-until').checked) {
    const until = $('#e-repeat-until').value;
    if (!until) return { dates: [], error: 'Pick a date to repeat until.' };
    if (until < start) return { dates: [], error: 'That end date is before the event itself.' };
    const dates = [];
    for (let d = start; d <= until; d = addDays(d, every)) {
      dates.push(d);
      if (dates.length > MAX_OCCURRENCES) {
        return { dates: [], error: `That is more than ${MAX_OCCURRENCES} events. Choose an earlier end date.` };
      }
    }
    return { dates, error: null };
  }

  const count = Number($('#e-repeat-count').value);
  if (!Number.isInteger(count) || count < 1) return { dates: [], error: 'Enter how many times it repeats.' };
  if (count > MAX_OCCURRENCES) return { dates: [], error: `At most ${MAX_OCCURRENCES} at a time.` };
  const dates = [];
  for (let i = 0; i < count; i += 1) dates.push(addDays(start, i * every));
  return { dates, error: null };
}

/** Says in plain words what the Save button is about to create. */
function updateRepeatSummary() {
  const box = $('#repeat-summary');
  if (!$('#e-repeat').checked) { box.textContent = ''; return; }

  const { dates, error } = repeatDates();
  box.classList.toggle('is-warning', !!error);

  if (error) { box.textContent = error; return; }
  if (!dates.length) { box.textContent = ''; return; }
  if (dates.length === 1) {
    box.textContent = `Creates 1 event on ${formatDateMedium(dates[0])}.`;
    return;
  }

  const every = Number($('#e-repeat-every').value) || 7;
  const cadence = every === 1
    ? 'every day'
    : every === 7
      ? `every ${DOW_LONG[parseDate(dates[0]).getDay()]}`
      : `every other ${DOW_LONG[parseDate(dates[0]).getDay()]}`;

  box.textContent = `Creates ${dates.length} events, ${cadence} from `
    + `${formatDateMedium(dates[0])} through ${formatDateMedium(dates[dates.length - 1])}.`;
}

function openEventEditor(event, defaults = {}) {
  admin.editing = event;
  clear($('#event-form-error'));
  clear($('#conflict-slot'));

  const source = event || {};

  $('#event-editor-title').textContent = event ? 'Edit Event' : 'Add Event';
  $('#btn-delete-event').hidden = !event;
  $('#repeat-box').hidden = !!event;
  $('#e-repeat').checked = false;
  $('#repeat-options').hidden = true;

  const allDay = !!source.allDay;
  $('#e-all-day').checked = allDay;
  $('#field-start').hidden = allDay;
  $('#field-end').hidden = allDay;
  $('#field-through').hidden = !allDay;
  $('#e-start').required = !allDay;
  $('#e-end').required = !allDay;
  $('#e-through').value = '';
  $('#repeat-box').hidden = allDay || !!event;
  $('#e-repeat-count').value = '8';
  $('#e-repeat-every').value = '7';
  $('#e-end-count').checked = true;
  $('#e-repeat-until').value = '';
  clear($('#repeat-summary'));

  $('#e-field').value = String(source.fieldId || defaults.fieldId || '');
  $('#e-type').value = source.eventType || 'game';
  $('#e-date').value = source.date || defaults.date || admin.filters.from || admin.boot.today;
  $('#e-start').value = source.startTime || defaults.startTime || '17:30';
  $('#e-end').value = source.endTime || defaults.endTime || '19:30';
  $('#e-division').value = source.division || '';
  $('#e-home').value = source.homeTeam || '';
  $('#e-away').value = source.awayTeam || '';
  $('#e-title').value = source.title || '';
  $('#e-status').value = source.status || 'scheduled';
  $('#e-notes').value = source.notes || '';

  openModal($('#event-editor'));
  setTimeout(() => $('#e-field').focus(), 60);
}

function readEventForm() {
  return {
    allDay: $('#e-all-day').checked,
    fieldId: $('#e-field').value,
    eventType: $('#e-type').value,
    eventDate: $('#e-date').value,
    startTime: $('#e-start').value,
    endTime: $('#e-end').value,
    division: $('#e-division').value,
    homeTeam: $('#e-home').value,
    awayTeam: $('#e-away').value,
    title: $('#e-title').value,
    status: $('#e-status').value,
    notes: $('#e-notes').value,
  };
}

async function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  const errorSlot = clear($('#event-form-error'));
  clear($('#conflict-slot'));

  const payload = readEventForm();
  if (!payload.fieldId) {
    errorSlot.append(h('div', { class: 'form-error' }, 'Choose a location and field.'));
    return;
  }

  // "Through" a later date is a block on each of those days.
  if (!admin.editing && $('#e-all-day').checked && $('#e-through').value) {
    const through = $('#e-through').value;
    if (through < payload.eventDate) {
      errorSlot.append(h('div', { class: 'form-error' }, 'The "through" date is before the start date.'));
      return;
    }
    payload.repeat = true;
    payload.repeatEveryDays = 1;
    payload.repeatUntil = through;
  }

  if (!admin.editing && $('#e-repeat').checked) {
    const { error } = repeatDates();
    if (error) {
      errorSlot.append(h('div', { class: 'form-error' }, error));
      return;
    }
    payload.repeat = true;
    payload.repeatEveryDays = Number($('#e-repeat-every').value) || 7;
    if ($('#e-end-until').checked) payload.repeatUntil = $('#e-repeat-until').value;
    else payload.repeatCount = Number($('#e-repeat-count').value) || 1;
  }

  const button = $('#btn-save-event');
  button.disabled = true;
  button.textContent = 'Saving…';

  const send = (allowConflict) =>
    admin.editing
      ? api.put(`/api/admin/events/${admin.editing.id}`, { ...payload, allowConflict })
      : api.post('/api/admin/events', { ...payload, allowConflict });

  try {
    const result = await send(false);
    finishSave(result);
  } catch (err) {
    if (err.status === 409 && err.conflicts?.length) {
      // Let the form go back to rest while the dialog is up, so the button
      // behind it is not stuck reading "Saving...".
      button.disabled = false;
      button.textContent = 'Save Event';

      const attempted = {
        allDay: payload.allDay,
        startTime: payload.startTime,
        endTime: payload.endTime,
      };
      const choice = await showConflicts(err.conflicts, attempted);

      if (choice.action === 'anyway') {
        try {
          finishSave(await send(true));
          return;
        } catch (err2) {
          errorSlot.append(h('div', { class: 'form-error' }, err2.message));
        }
      } else if (choice.action === 'edit') {
        // Swap this editor for the booking that is in the way.
        const existing = admin.events.find((e) => e.id === choice.eventId)
          || (await api.get(`/api/events?from=${payload.eventDate}&to=${payload.eventDate}`))
            .events.find((e) => e.id === choice.eventId);
        closeModal($('#event-editor'));
        if (existing) {
          setTimeout(() => openEventEditor(existing), 120);
        } else {
          toast('That booking could not be opened. Find it in the list below.', 'error');
        }
      } else {
        // Back to the form, with the start time selected to retype.
        setTimeout(() => $('#e-start').focus(), 60);
      }
    } else {
      errorSlot.append(h('div', { class: 'form-error' }, err.message));
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Save Event';
  }
}

function finishSave(result) {
  closeModal($('#event-editor'));
  if (result.skipped?.length) {
    toast(`Saved. ${result.skipped.length} date(s) were skipped because the field was booked.`, 'success', 6000);
  } else if (result.events) {
    toast(`${result.events.length} event(s) added.`, 'success');
  } else {
    toast('Event saved.', 'success');
  }
  refreshBoot().then(loadEvents);
}

/**
 * Stops the save and shows what is in the way.
 *
 * Resolves to 'anyway' to allow the overlap, 'edit' when the admin chose to go
 * and move the existing booking instead, or 'cancel' to go back to the form.
 */
function showConflicts(conflicts, attempted) {
  return new Promise((resolve) => {
    const modal = $('#conflict-modal');
    const only = conflicts.length === 1;

    $('#conflict-modal-title').textContent = only
      ? 'That field is already booked'
      : 'That field has other bookings';

    $('#conflict-intro').textContent = only
      ? `${conflicts[0].locationName} · ${conflicts[0].fieldName} already has something on `
        + `${formatDateMedium(conflicts[0].date)}:`
      : `${conflicts[0].locationName} · ${conflicts[0].fieldName} already has `
        + `${conflicts.length} bookings that overlap:`;

    const list = clear($('#conflict-list'));

    conflicts.forEach((clash) => {
      list.append(
        h('div', { class: 'clash' },
          h('div', { class: 'clash-main' },
            h('div', { class: 'clash-when' },
              clash.allDay ? 'All day' : formatTimeRange(clash.startTime, clash.endTime)),
            h('div', { class: 'clash-what' }, clash.label || 'Booked')),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onClick: () => settle('edit', clash.id),
          }, 'Open this one'))
      );
    });

    // Spell out what was being added, so the overlap is obvious.
    if (attempted) {
      list.append(
        h('div', { class: 'clash-yours' },
          h('div', { class: 'clash-when' },
            attempted.allDay ? 'All day' : formatTimeRange(attempted.startTime, attempted.endTime)),
          h('div', { class: 'clash-what' }, 'what you are adding'))
      );
    }

    let settled = false;
    const settle = (result, id) => {
      if (settled) return;
      settled = true;
      closeModal(modal);
      resolve({ action: result, eventId: id });
    };

    $('#btn-conflict-anyway').onclick = () => settle('anyway');
    $$('[data-conflict-cancel]', modal).forEach((btn) => { btn.onclick = () => settle('cancel'); });
    modal.addEventListener('close', () => settle('cancel'), { once: true });

    openModal(modal);
  });
}

async function deleteCurrentEvent() {
  const event = admin.editing;
  if (!event) return;
  const ok = await confirmAction({
    title: 'Delete this event?',
    message: [
      `${eventHeadline(event) || labelFor(admin.boot.eventTypes, event.eventType)} — ${formatDateMedium(event.date)}, ${describeWhen(event)} at ${event.locationName} · ${event.fieldName}.`,
      'This cannot be undone. To keep it visible but called off, set the status to Canceled or Rained Out instead.',
    ],
    confirmLabel: 'Delete Event',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/events/${event.id}`);
    closeModal($('#event-editor'));
    toast('Event deleted.', 'success');
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteSeries(event) {
  const ok = await confirmAction({
    title: 'Delete the repeating series?',
    message: [
      `This removes every remaining event in this series from ${formatDateMedium(event.date)} onward.`,
      'Earlier dates in the series stay on the schedule.',
    ],
    confirmLabel: 'Delete Series',
  });
  if (!ok) return;
  try {
    const result = await api.del(`/api/admin/series/${encodeURIComponent(event.seriesId)}?from=${event.date}`);
    toast(`${result.removed} event(s) removed.`, 'success');
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================
   Locations tab
   ================================================================ */

function renderLocationsAdmin() {
  const root = clear($('#locations-root'));

  admin.boot.locations.forEach((loc) => {
    const form = h('form', { class: 'form-grid', onSubmit: (e) => saveLocation(e, loc.id) },
      h('div', { class: 'field' },
        h('label', { class: 'lbl', for: `loc-name-${loc.id}` }, 'Name'),
        h('input', { type: 'text', id: `loc-name-${loc.id}`, value: loc.name, maxlength: '80', required: true })),
      h('div', { class: 'field span-2' },
        h('label', { class: 'lbl', for: `loc-addr-${loc.id}` }, 'Address'),
        h('input', { type: 'text', id: `loc-addr-${loc.id}`, value: loc.address, maxlength: '240',
          placeholder: '123 Main St, Jackson, NJ 08527' })),
      h('div', { class: 'field span-2' },
        h('label', { class: 'lbl', for: `loc-maps-${loc.id}` }, 'Directions search text'),
        h('input', { type: 'text', id: `loc-maps-${loc.id}`, value: loc.mapsQuery, maxlength: '240' }),
        h('p', { class: 'hint' }, 'What the Directions button looks up in Maps. Usually the same as the address.')),
      h('div', { class: 'field' },
        h('label', { class: 'lbl', for: `loc-lat-${loc.id}` }, 'Latitude'),
        h('input', { type: 'number', id: `loc-lat-${loc.id}`, value: loc.latitude ?? '', step: 'any', placeholder: 'optional' })),
      h('div', { class: 'field' },
        h('label', { class: 'lbl', for: `loc-lng-${loc.id}` }, 'Longitude'),
        h('input', { type: 'number', id: `loc-lng-${loc.id}`, value: loc.longitude ?? '', step: 'any', placeholder: 'optional' })),
      h('div', { class: 'field span-all' },
        h('label', { class: 'lbl', for: `loc-notes-${loc.id}` }, 'Notes shown on the public site'),
        h('input', { type: 'text', id: `loc-notes-${loc.id}`, value: loc.notes, maxlength: '500',
          placeholder: 'e.g. Parking is behind the concession stand.' })),
      h('div', { class: 'span-all', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save Location'),
        h('a', { class: 'btn btn-sm', href: directionsUrl(loc), target: '_blank', rel: 'noopener' },
          'Test Directions'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onClick: () => removeLocation(loc) },
          'Delete Location'))
    );

    const mapRow = h('div', { class: 'file-row' });
    if (loc.mapImage) {
      mapRow.append(
        h('img', { class: 'logo-preview', src: loc.mapImage, alt: `${loc.name} field map` }),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onClick: () => openMapEditor(loc) },
          `Label Fields (${loc.pins.length})`),
        h('button', { class: 'btn btn-sm', type: 'button', onClick: () => replaceMap(loc) }, 'Replace Image'),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onClick: () => removeMap(loc) }, 'Remove')
      );
    } else {
      mapRow.append(
        h('span', { class: 'inline-note' }, 'No field map uploaded yet.'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onClick: () => replaceMap(loc) },
          'Upload Field Map')
      );
    }

    const fieldTable = h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Field'), h('th', {}, 'Kind'), h('th', {}, 'Order'),
        h('th', {}, 'Shown'), h('th', {}, ''))),
      h('tbody', {}, loc.fields.map((field) => fieldRow(loc, field))));

    root.append(
      h('div', { class: 'panel', style: 'background:var(--surface-sunken)' },
        h('div', { class: 'panel-head' }, h('h2', {}, loc.name)),
        form,
        h('h3', { style: 'font-size:14.5px;margin:20px 0 8px' }, 'Field Map'),
        mapRow,
        h('p', { class: 'hint', style: 'margin-top:6px' },
          'Upload a photo or drawing of the site, then add a label for each field so families can find it.'),
        h('h3', { style: 'font-size:14.5px;margin:20px 0 8px' }, `Fields (${loc.fields.length})`),
        h('div', { class: 'table-wrap' }, fieldTable),
        h('form', { class: 'form-grid', style: 'margin-top:12px', onSubmit: (e) => addField(e, loc.id) },
          h('div', { class: 'field' },
            h('label', { class: 'lbl', for: `new-field-${loc.id}` }, 'Add a field'),
            h('input', { type: 'text', id: `new-field-${loc.id}`, placeholder: 'Field name', maxlength: '80', required: true })),
          h('div', { class: 'field' },
            h('label', { class: 'lbl', for: `new-kind-${loc.id}` }, 'Kind'),
            h('select', { id: `new-kind-${loc.id}` },
              admin.boot.fieldKinds.map((k) => h('option', { value: k.value }, k.label)))),
          h('div', { class: 'field', style: 'justify-content:flex-end' },
            h('button', { class: 'btn btn-sm', type: 'submit' }, '+ Add Field'))))
    );
  });
}

function fieldRow(loc, field) {
  return h('tr', {},
    h('td', {},
      h('input', { type: 'text', value: field.name, maxlength: '80',
        id: `fname-${field.id}`, style: 'min-width:120px' })),
    h('td', {},
      h('select', { id: `fkind-${field.id}` },
        admin.boot.fieldKinds.map((k) =>
          h('option', { value: k.value, selected: k.value === field.kind }, k.label)))),
    h('td', { class: 'num' },
      h('input', { type: 'number', value: String(field.sortOrder), id: `forder-${field.id}`,
        style: 'width:72px' })),
    h('td', {},
      h('input', { type: 'checkbox', id: `factive-${field.id}`, checked: field.active,
        style: 'width:auto' })),
    h('td', { class: 'actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => saveField(field.id) }, 'Save'),
      ' ',
      h('button', { class: 'btn btn-sm btn-danger', type: 'button',
        onClick: () => removeField(loc, field) }, 'Delete'))
  );
}

async function saveLocation(event, id) {
  event.preventDefault();
  try {
    await api.put(`/api/admin/locations/${id}`, {
      name: $(`#loc-name-${id}`).value,
      address: $(`#loc-addr-${id}`).value,
      mapsQuery: $(`#loc-maps-${id}`).value,
      latitude: $(`#loc-lat-${id}`).value,
      longitude: $(`#loc-lng-${id}`).value,
      notes: $(`#loc-notes-${id}`).value,
    });
    toast('Location saved.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeLocation(loc) {
  const ok = await confirmAction({
    title: `Delete ${loc.name}?`,
    message: [
      `This removes ${loc.name}, its ${loc.fields.length} field(s) and every event scheduled there.`,
      'This cannot be undone.',
    ],
    confirmLabel: 'Delete Location',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/locations/${loc.id}?force=1`);
    toast('Location deleted.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveField(id) {
  try {
    await api.put(`/api/admin/fields/${id}`, {
      name: $(`#fname-${id}`).value,
      kind: $(`#fkind-${id}`).value,
      sortOrder: $(`#forder-${id}`).value,
      active: $(`#factive-${id}`).checked,
    });
    toast('Field saved.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function addField(event, locationId) {
  event.preventDefault();
  const nameInput = $(`#new-field-${locationId}`);
  try {
    await api.post('/api/admin/fields', {
      locationId,
      name: nameInput.value,
      kind: $(`#new-kind-${locationId}`).value,
    });
    toast('Field added.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeField(loc, field) {
  const ok = await confirmAction({
    title: `Delete ${field.name}?`,
    message: [
      `This removes ${loc.name} · ${field.name} and every event scheduled on it.`,
      'To keep its history but hide it from the public site, untick "Shown" and save instead.',
    ],
    confirmLabel: 'Delete Field',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/fields/${field.id}?force=1`);
    toast('Field deleted.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- Field map upload + labeling ---------------- */

function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml' });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0] || null;
      input.remove();
      resolve(file);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    input.click();
  });
}

async function replaceMap(loc) {
  const file = await pickImage();
  if (!file) return;
  const body = new FormData();
  body.append('image', file);
  try {
    toast('Uploading…');
    await api.post(`/api/admin/locations/${loc.id}/map`, body);
    toast('Field map uploaded. Now add labels for each field.', 'success', 5500);
    await refreshBoot();
    renderLocationsAdmin();
    const fresh = admin.boot.locations.find((l) => l.id === loc.id);
    if (fresh) openMapEditor(fresh);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeMap(loc) {
  const ok = await confirmAction({
    title: 'Remove this field map?',
    message: `The map image and its ${loc.pins.length} label(s) will be deleted.`,
    confirmLabel: 'Remove Map',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/locations/${loc.id}/map`);
    toast('Field map removed.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openMapEditor(loc) {
  admin.mapEditor = {
    location: loc,
    pins: loc.pins.map((p) => ({ label: p.label, x: p.x, y: p.y, color: p.color, fieldId: p.fieldId })),
  };
  $('#map-editor-title').textContent = `${loc.name} — Label the Field Map`;
  renderMapEditor();
  openModal($('#map-editor'));
}

function renderMapEditor() {
  const { location, pins } = admin.mapEditor;
  const wrap = clear($('#map-editor-stage-wrap'));

  const stage = h('div', { class: 'pin-editor-stage' },
    h('img', { src: location.mapImage, alt: `${location.name} field map`, draggable: 'false' }));

  stage.addEventListener('click', (event) => {
    if (event.target.closest('.map-pin')) return;
    const rect = stage.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    pins.push({
      label: `Label ${pins.length + 1}`,
      x: Math.min(100, Math.max(0, x)),
      y: Math.min(100, Math.max(0, y)),
      color: '#1d4ed8',
      fieldId: null,
    });
    renderMapEditor();
    setTimeout(() => $(`#pin-label-${pins.length - 1}`)?.select(), 40);
  });

  pins.forEach((pin, index) => {
    const marker = h('div', { class: 'map-pin', dataset: { index: String(index) } },
      h('span', { class: 'map-pin-label' }, pin.label || '(no label)'),
      h('span', { class: 'map-pin-stem' }),
      h('span', { class: 'map-pin-dot' }));
    marker.style.left = `${pin.x}%`;
    marker.style.top = `${pin.y}%`;
    marker.querySelector('.map-pin-label').style.background = pin.color;
    marker.querySelector('.map-pin-stem').style.background = pin.color;
    marker.querySelector('.map-pin-dot').style.background = pin.color;

    // Drag to reposition.
    marker.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      marker.setPointerCapture(event.pointerId);
      const rect = stage.getBoundingClientRect();
      const move = (moveEvent) => {
        pin.x = Math.min(100, Math.max(0, ((moveEvent.clientX - rect.left) / rect.width) * 100));
        pin.y = Math.min(100, Math.max(0, ((moveEvent.clientY - rect.top) / rect.height) * 100));
        marker.style.left = `${pin.x}%`;
        marker.style.top = `${pin.y}%`;
      };
      const up = () => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        marker.removeEventListener('pointercancel', up);
        try {
          marker.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
      };
      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up, { once: true });
      // Without this a cancelled drag (a touch interrupted by a scroll or an
      // incoming call) leaves pointermove attached and the label keeps
      // following the cursor afterwards.
      marker.addEventListener('pointercancel', up, { once: true });
    });

    stage.append(marker);
  });

  wrap.append(stage);

  const list = clear($('#pin-list'));
  pins.forEach((pin, index) => {
    list.append(
      h('div', { class: 'pin-row' },
        h('span', { class: 'pin-index' }, String(index + 1)),
        h('input', {
          type: 'text', id: `pin-label-${index}`, value: pin.label, maxlength: '60',
          placeholder: 'Label text',
          onInput: (e) => {
            pin.label = e.target.value;
            const marker = $(`.map-pin[data-index="${index}"] .map-pin-label`, stage);
            if (marker) marker.textContent = pin.label || '(no label)';
          },
        }),
        h('select', {
          onChange: (e) => { pin.fieldId = e.target.value ? Number(e.target.value) : null; },
        },
          h('option', { value: '' }, 'Not linked'),
          location.fields.map((f) =>
            h('option', { value: String(f.id), selected: f.id === pin.fieldId }, f.name))),
        h('input', {
          type: 'color', value: pin.color, style: 'width:44px;padding:2px;height:34px',
          'aria-label': 'Label color',
          // Repainted in place: a full re-render on every input event would
          // tear down the colour picker the admin is still dragging in.
          onInput: (e) => {
            pin.color = e.target.value;
            const marker = $(`.map-pin[data-index="${index}"]`, stage);
            if (!marker) return;
            marker.querySelector('.map-pin-label').style.background = pin.color;
            marker.querySelector('.map-pin-stem').style.background = pin.color;
            marker.querySelector('.map-pin-dot').style.background = pin.color;
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onClick: () => { pins.splice(index, 1); renderMapEditor(); },
        }, 'Remove'))
    );
  });

  if (!pins.length) {
    list.append(h('p', { class: 'hint' }, 'No labels yet. Click the map above to add the first one.'));
  }
  $('#pin-count').textContent = pins.length === 1 ? '1 label' : `${pins.length} labels`;
}

$('#btn-save-pins')?.addEventListener('click', async () => {
  const { location, pins } = admin.mapEditor;
  if (pins.some((p) => !p.label.trim())) {
    toast('Every label needs some text.', 'error');
    return;
  }
  try {
    await api.put(`/api/admin/locations/${location.id}/pins`, { pins });
    closeModal($('#map-editor'));
    toast('Labels saved.', 'success');
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-new-location')?.addEventListener('click', async () => {
  const name = window.prompt('Name of the new location?');
  if (!name || !name.trim()) return;
  try {
    await api.post('/api/admin/locations', { name: name.trim() });
    toast('Location added. Fill in the address and add its fields.', 'success', 5500);
    await refreshBoot();
    renderLocationsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ================================================================
   Branding tab
   ================================================================ */

function fillBrandingForm() {
  const s = admin.boot.settings;
  $('#s-league-name').value = s.leagueName || '';
  $('#s-league-short').value = s.leagueShort || '';
  $('#s-season').value = s.seasonLabel || '';
  $('#s-timezone').value = s.timezone || '';
  $('#s-contact').value = s.contactEmail || '';
  $('#s-announcement').value = s.announcement || '';
  $('#s-announcement-level').value = s.announcementLevel || 'info';

  const row = clear($('#logo-row'));
  if (s.logoPath) {
    row.append(
      h('img', { class: 'logo-preview', src: s.logoPath, alt: 'League logo' }),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: uploadLogo }, 'Replace Logo'),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onClick: removeLogo }, 'Remove Logo')
    );
  } else {
    row.append(
      h('span', { class: 'inline-note' }, 'No logo uploaded — the league initials are shown instead.'),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onClick: uploadLogo }, 'Upload Logo')
    );
  }
}

function wireBranding() {
  $('#branding-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.put('/api/admin/settings', {
        leagueName: $('#s-league-name').value,
        leagueShort: $('#s-league-short').value,
        seasonLabel: $('#s-season').value,
        timezone: $('#s-timezone').value,
        contactEmail: $('#s-contact').value,
      });
      toast('Branding saved.', 'success');
      await refreshBoot();
      fillBrandingForm();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#announcement-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.put('/api/admin/settings', {
        announcement: $('#s-announcement').value,
        announcementLevel: $('#s-announcement-level').value,
      });
      toast('Announcement saved.', 'success');
      await refreshBoot();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-clear-announcement').addEventListener('click', async () => {
    try {
      await api.put('/api/admin/settings', { announcement: '' });
      $('#s-announcement').value = '';
      toast('Banner cleared.', 'success');
      await refreshBoot();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function uploadLogo() {
  const file = await pickImage();
  if (!file) return;
  const body = new FormData();
  body.append('image', file);
  try {
    await api.post('/api/admin/logo', body);
    toast('Logo uploaded.', 'success');
    await refreshBoot();
    fillBrandingForm();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeLogo() {
  try {
    await api.del('/api/admin/logo');
    toast('Logo removed.', 'success');
    await refreshBoot();
    fillBrandingForm();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================
   Admins tab
   ================================================================ */

function wireAdmins() {
  $('#btn-new-admin').addEventListener('click', () => {
    clear($('#admin-form-error'));
    $('#admin-form').reset();
    $('#u-password').value = suggestPassword();
    openModal($('#admin-modal'));
  });

  $('#btn-suggest-password').addEventListener('click', () => {
    $('#u-password').value = suggestPassword();
  });

  $('#admin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const slot = clear($('#admin-form-error'));
    try {
      await api.post('/api/admin/users', {
        username: $('#u-username').value,
        password: $('#u-password').value,
        displayName: $('#u-display').value,
        role: $('#u-role').value,
      });
      closeModal($('#admin-modal'));
      toast('Admin account created.', 'success');
      loadUsers();
    } catch (err) {
      slot.append(h('div', { class: 'form-error' }, err.message));
    }
  });
}

function suggestPassword() {
  const words = ['Dugout', 'Bullpen', 'Infield', 'Fastball', 'Shortstop', 'Homeplate',
    'Outfield', 'Changeup', 'Grandslam', 'Baseline'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(Math.random() * 9000) + 1000);
  return `${pick()}-${pick()}-${digits}`;
}

async function loadUsers() {
  const root = $('#admins-root');
  root.replaceChildren(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton-row' })));
  try {
    const data = await api.get('/api/admin/users');
    admin.users = data.users;
    renderUsers();
  } catch (err) {
    root.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Could not load accounts'), h('p', {}, err.message)));
  }
}

function renderUsers() {
  const root = clear($('#admins-root'));
  // Account management is owner-only on the server; hide the controls rather
  // than offer buttons that come back 403.
  const isOwner = admin.me.role === 'owner';
  $('#btn-new-admin').hidden = !isOwner;

  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Role'),
      h('th', {}, 'Status'), h('th', {}, 'Last signed in'), h('th', {}, ''))),
    h('tbody', {}, admin.users.map((user) => {
      const isMe = user.id === admin.me.id;
      return h('tr', {},
        h('td', {}, user.displayName || user.username, isMe ? h('span', { class: 'inline-note' }, ' (you)') : null),
        h('td', {}, h('code', { style: 'font-family:var(--mono);font-size:13px' }, user.username)),
        h('td', {}, h('span', { class: `role-pill${user.role === 'owner' ? ' owner' : ''}` }, user.role)),
        h('td', {}, h('span', { class: `state-pill${user.active ? '' : ' off'}` }, user.active ? 'Active' : 'Disabled')),
        h('td', { class: 'inline-note' }, formatTimestamp(user.lastLoginAt)),
        h('td', { class: 'actions' },
          !isOwner
            ? h('span', { class: 'inline-note' }, isMe ? 'Use "My Password" above' : '\u2014')
            : [
              h('button', { class: 'btn btn-sm', type: 'button', onClick: () => resetUserPassword(user) }, 'Reset Password'),
              ' ',
              isMe ? null : h('button', {
                class: 'btn btn-sm', type: 'button',
                onClick: () => toggleUser(user),
              }, user.active ? 'Disable' : 'Enable'),
              ' ',
              isMe ? null : h('button', {
                class: 'btn btn-sm btn-danger', type: 'button',
                onClick: () => deleteUser(user),
              }, 'Delete'),
            ]));
    })));

  root.append(h('div', { class: 'table-wrap' }, table));
  root.append(h('p', { class: 'hint', style: 'margin-top:10px' },
    isOwner
      ? 'Owners can manage accounts and the schedule. Admins can manage the schedule. '
        + 'At least one active admin and one owner always have to remain.'
      : 'Only an owner can add or change accounts. You can change your own password '
        + 'with "My Password" at the top of the page.'));
}

async function resetUserPassword(user) {
  const suggested = suggestPassword();
  const entered = window.prompt(
    `Set a new password for ${user.username}.\n\nAt least 10 characters with a letter and a number.`,
    suggested
  );
  if (!entered) return;
  try {
    await api.post(`/api/admin/users/${user.id}/password`, { password: entered });
    toast(`Password updated. Give ${user.username} this password: ${entered}`, 'success', 12000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function toggleUser(user) {
  try {
    await api.put(`/api/admin/users/${user.id}`, { active: !user.active, displayName: user.displayName, role: user.role });
    toast(user.active ? 'Account disabled.' : 'Account enabled.', 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUser(user) {
  const ok = await confirmAction({
    title: `Delete ${user.username}?`,
    message: ['This permanently removes the account.', 'Their past schedule changes stay in the activity log.'],
    confirmLabel: 'Delete Account',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/users/${user.id}`);
    toast('Account deleted.', 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================
   Activity tab
   ================================================================ */

$('#btn-refresh-audit')?.addEventListener('click', () => loadAudit());

async function loadAudit() {
  const root = $('#activity-root');
  root.replaceChildren(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton-row' })));
  try {
    const data = await api.get('/api/admin/audit?limit=200');
    const root2 = clear(root);
    if (!data.entries.length) {
      root2.append(h('div', { class: 'empty' }, h('h3', {}, 'Nothing logged yet')));
      return;
    }
    root2.append(h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Action'), h('th', {}, 'Details'))),
        h('tbody', {}, data.entries.map((entry) =>
          h('tr', {},
            h('td', { class: 'inline-note', style: 'white-space:nowrap' }, formatTimestamp(entry.createdAt)),
            h('td', {}, entry.username),
            h('td', {}, h('code', { style: 'font-family:var(--mono);font-size:12.5px' }, entry.action)),
            h('td', { class: 'inline-note' }, entry.detail)))))));
  } catch (err) {
    root.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Could not load the log'), h('p', {}, err.message)));
  }
}

document.addEventListener('DOMContentLoaded', init);
