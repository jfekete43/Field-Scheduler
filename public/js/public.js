/* Public schedule view. */
'use strict';

const state = {
  view: 'day',
  anchor: null,          // YYYY-MM-DD
  today: null,
  filters: { location: '', field: '', type: '', division: '', q: '' },
  boot: null,
  events: [],
  loading: false,
  requestId: 0,
};

const UPCOMING_DAYS = 60;

/* ---------------- Bootstrapping ---------------- */

async function init() {
  wireModals();

  try {
    const boot = await api.get('/api/bootstrap');
    state.boot = boot;
    state.today = boot.today;
    setBranding(boot.settings);
    renderAnnouncement(boot.settings);
    populateFilterOptions();
    renderLocations();
    applyStateFromUrl();
    // Wired only once the data is in: clicking a view or filter before then
    // would run against a null state.boot.
    wireControls();
    await loadEvents();
  } catch (err) {
    $('#schedule-root').replaceChildren(
      h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, '⚠'),
        h('h3', {}, 'The schedule could not be loaded'),
        h('p', {}, err.message))
    );
  }
}

function wireControls() {
  $$('.segmented [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('#btn-prev').addEventListener('click', () => shift(-1));
  $('#btn-next').addEventListener('click', () => shift(1));
  $('#btn-today').addEventListener('click', () => {
    state.anchor = state.today;
    syncUrl();
    loadEvents();
  });

  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-subscribe').addEventListener('click', openSubscribe);

  const onFilterChange = () => {
    state.filters.location = $('#f-location').value;
    state.filters.field = $('#f-field').value;
    state.filters.type = $('#f-type').value;
    state.filters.division = $('#f-division').value;
    rebuildFieldOptions();
    syncUrl();
    loadEvents();
  };

  $('#f-location').addEventListener('change', () => {
    // Changing location invalidates a field chosen at another site.
    state.filters.field = '';
    $('#f-field').value = '';
    onFilterChange();
  });
  ['#f-field', '#f-type', '#f-division'].forEach((sel) =>
    $(sel).addEventListener('change', onFilterChange)
  );

  $('#f-search').addEventListener('input', debounce(() => {
    state.filters.q = $('#f-search').value.trim();
    syncUrl();
    loadEvents();
  }, 300));

  $('#btn-clear').addEventListener('click', () => {
    state.filters = { location: '', field: '', type: '', division: '', q: '' };
    $('#f-location').value = '';
    $('#f-type').value = '';
    $('#f-division').value = '';
    $('#f-search').value = '';
    rebuildFieldOptions();
    syncUrl();
    loadEvents();
  });

  window.addEventListener('popstate', () => {
    applyStateFromUrl();
    loadEvents();
  });
}

function populateFilterOptions() {
  const { locations, eventTypes, divisions } = state.boot;

  const locSelect = $('#f-location');
  const subLoc = $('#sub-location');
  for (const select of [locSelect, subLoc]) {
    clear(select).append(h('option', { value: '' }, 'All locations'));
    locations.forEach((loc) => select.append(h('option', { value: String(loc.id) }, loc.name)));
  }

  const typeSelect = $('#f-type');
  clear(typeSelect).append(h('option', { value: '' }, 'All types'));
  eventTypes.forEach((type) => typeSelect.append(h('option', { value: type.value }, type.label)));

  const divSelect = $('#f-division');
  const subDiv = $('#sub-division');
  for (const select of [divSelect, subDiv]) {
    clear(select).append(h('option', { value: '' }, 'All divisions'));
    divisions.forEach((div) => select.append(h('option', { value: div }, div)));
  }

  rebuildFieldOptions();
}

function rebuildFieldOptions() {
  const { locations } = state.boot;
  const build = (select, locationId, keep) => {
    const chosen = keep ? select.value : '';
    clear(select).append(h('option', { value: '' }, 'All fields'));
    const pool = locationId
      ? locations.filter((loc) => String(loc.id) === String(locationId))
      : locations;
    pool.forEach((loc) => {
      const group = h('optgroup', { label: loc.name });
      loc.fields.forEach((field) =>
        group.append(h('option', { value: String(field.id) }, field.name))
      );
      if (loc.fields.length) select.append(group);
    });
    if (chosen && select.querySelector(`option[value="${chosen}"]`)) select.value = chosen;
  };

  build($('#f-field'), state.filters.location, true);
  $('#f-field').value = state.filters.field || '';
  build($('#sub-field'), $('#sub-location')?.value, true);
}

/* ---------------- URL state ---------------- */

function applyStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  state.view = ['day', 'timeline', 'week', 'upcoming'].includes(view) ? view : 'day';

  const date = params.get('date');
  state.anchor = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : state.today;

  // Ids from the URL are checked against the real data. An id that no longer
  // exists would otherwise stay in state and filter the schedule while the
  // controls still read "All locations".
  const knownLocation = (id) => state.boot.locations.some((l) => String(l.id) === id);
  const knownField = (id) => state.boot.locations.some((l) => l.fields.some((f) => String(f.id) === id));
  const knownType = (value) => state.boot.eventTypes.some((t) => t.value === value);
  const knownDivision = (value) => state.boot.divisions.includes(value);

  const rawLocation = params.get('location') || '';
  const rawField = params.get('field') || '';
  const rawType = params.get('type') || '';
  const rawDivision = params.get('division') || '';

  state.filters = {
    location: knownLocation(rawLocation) ? rawLocation : '',
    field: knownField(rawField) ? rawField : '',
    type: knownType(rawType) ? rawType : '',
    division: knownDivision(rawDivision) ? rawDivision : '',
    q: params.get('q') || '',
  };

  $('#f-location').value = state.filters.location;
  $('#f-type').value = state.filters.type;
  $('#f-division').value = state.filters.division;
  $('#f-search').value = state.filters.q;
  rebuildFieldOptions();

  $$('.segmented [data-view]').forEach((btn) =>
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view))
  );
  $('#date-nav').hidden = state.view === 'upcoming';
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.view !== 'day') params.set('view', state.view);
  if (state.view !== 'upcoming' && state.anchor !== state.today) params.set('date', state.anchor);
  for (const [key, value] of Object.entries(state.filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  window.history.replaceState(null, '', query ? `/?${query}` : '/');
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  $$('.segmented [data-view]').forEach((btn) =>
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view))
  );
  $('#date-nav').hidden = view === 'upcoming';
  syncUrl();
  loadEvents();
}

function shift(direction) {
  const step = state.view === 'week' ? 7 : 1;
  state.anchor = addDays(state.anchor, direction * step);
  syncUrl();
  loadEvents();
}

/* ---------------- Fetching ---------------- */

function currentRange() {
  if (state.view === 'day' || state.view === 'timeline') {
    return { from: state.anchor, to: state.anchor };
  }
  if (state.view === 'week') {
    const from = startOfWeek(state.anchor);
    return { from, to: addDays(from, 6) };
  }
  return { from: state.today, to: addDays(state.today, UPCOMING_DAYS) };
}

async function loadEvents() {
  const range = currentRange();
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (state.filters.location) params.set('location', state.filters.location);
  if (state.filters.field) params.set('field', state.filters.field);
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.division) params.set('division', state.filters.division);
  if (state.filters.q) params.set('q', state.filters.q);

  updateDateLabel(range);
  renderChips();

  const requestId = ++state.requestId;
  state.loading = true;

  try {
    const data = await api.get(`/api/events?${params}`);
    if (requestId !== state.requestId) return; // a newer request already answered
    state.events = data.events;
    render();
  } catch (err) {
    if (requestId !== state.requestId) return;
    $('#schedule-root').replaceChildren(
      h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, '⚠'),
        h('h3', {}, 'Could not load the schedule'),
        h('p', {}, err.message))
    );
  } finally {
    if (requestId === state.requestId) state.loading = false;
  }
}

function updateDateLabel(range) {
  const label = $('#date-label');
  if (state.view === 'day' || state.view === 'timeline') label.textContent = formatDateLong(range.from);
  else if (state.view === 'week') label.textContent = formatRangeLabel(range.from, range.to);
  else label.textContent = '';

  const title = $('#schedule-title');
  title.textContent =
    state.view === 'upcoming' ? `Next ${UPCOMING_DAYS} Days` :
    state.view === 'week' ? 'Week Schedule' :
    state.view === 'timeline' ? 'Field by Field' : 'Daily Schedule';
}

function renderChips() {
  const wrap = $('#chip-row-wrap');
  const row = clear($('#chip-row'));
  const { locations, eventTypes } = state.boot;
  const active = [];

  if (state.filters.location) {
    const loc = locations.find((l) => String(l.id) === state.filters.location);
    if (loc) active.push({ key: 'location', text: loc.name });
  }
  if (state.filters.field) {
    const field = locations.flatMap((l) => l.fields).find((f) => String(f.id) === state.filters.field);
    if (field) active.push({ key: 'field', text: field.name });
  }
  if (state.filters.type) active.push({ key: 'type', text: labelFor(eventTypes, state.filters.type) });
  if (state.filters.division) active.push({ key: 'division', text: state.filters.division });
  if (state.filters.q) active.push({ key: 'q', text: `"${state.filters.q}"` });

  wrap.hidden = active.length === 0;
  if (!active.length) return;

  row.append(h('span', { class: 'lbl' }, 'Filtered by'));
  active.forEach((item) => {
    row.append(
      h('span', { class: 'chip' }, item.text,
        h('button', {
          type: 'button',
          'aria-label': `Remove ${item.text} filter`,
          onClick: () => {
            state.filters[item.key] = '';
            if (item.key === 'location') state.filters.field = '';
            $('#f-location').value = state.filters.location;
            $('#f-type').value = state.filters.type;
            $('#f-division').value = state.filters.division;
            $('#f-search').value = state.filters.q;
            rebuildFieldOptions();
            syncUrl();
            loadEvents();
          },
        }, '×'))
    );
  });
}

/* ---------------- Rendering ---------------- */

function render() {
  const root = clear($('#schedule-root'));
  const count = state.events.length;
  $('#result-count').textContent = count === 1 ? '1 event' : `${count} events`;

  if (!count) {
    root.append(emptyState());
    return;
  }
  if (state.view === 'timeline') {
    renderTimeline(root, {
      events: state.events,
      locations: state.boot.locations,
      date: state.anchor,
      today: state.today,
      labels: state.boot.eventTypes,
      onEventClick: showEvent,
    });
    root.append(timelineLegend());
  } else if (state.view === 'week') {
    root.append(renderWeek());
  } else {
    root.append(renderGroupedByDate());
  }
}

/** A small key to the block colours. */
function timelineLegend() {
  const shown = ['game', 'practice', 'cage', 'tournament'];
  return h('div', { class: 'tl-legend' },
    shown.map((type) => {
      const swatch = h('span', { class: `tl-swatch type-${type}` });
      return h('span', { class: 'tl-legend-item' },
        swatch, labelFor(state.boot.eventTypes, type));
    }),
    h('span', { class: 'tl-legend-item', style: 'margin-left:auto' },
      'Scroll sideways for later in the day'));
}

function emptyState() {
  const hasFilters = Object.values(state.filters).some(Boolean);
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '⚾'),
    h('h3', {}, 'Nothing scheduled'),
    h('p', {}, hasFilters
      ? 'No events match these filters. Try clearing them or looking at another date.'
      : state.view === 'day'
        ? 'No events are on the schedule for this day.'
        : 'No events are on the schedule for this range yet.'));
}

/** Day and Upcoming views: date headings, then a block per location. */
function renderGroupedByDate() {
  const frag = document.createDocumentFragment();
  const byDate = new Map();
  for (const event of state.events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }

  for (const [date, events] of byDate) {
    const block = h('div', { class: 'day-block' });
    const heading = h('div', { class: `day-heading${date === state.today ? ' is-today' : ''}` },
      h('h3', {}, formatDateLong(date)),
      h('span', { class: 'day-count' }, events.length === 1 ? '1 event' : `${events.length} events`));
    block.append(heading);

    const byLocation = new Map();
    for (const event of events) {
      if (!byLocation.has(event.locationId)) byLocation.set(event.locationId, []);
      byLocation.get(event.locationId).push(event);
    }

    // Locations keep their configured order. Sorting by first start time would
    // float a site to the top just because it has an all-day block on it.
    const order = new Map(state.boot.locations.map((loc, i) => [loc.id, i]));
    const ordered = [...byLocation.entries()].sort(
      (a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99)
    );

    for (const [, locEvents] of ordered) {
      const first = locEvents[0];
      const group = h('div', { class: 'loc-group' },
        h('div', { class: 'loc-group-head' },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          first.locationName),
        h('div', { class: 'event-list' }, locEvents.map(eventCard)));
      block.append(group);
    }
    frag.append(block);
  }
  return frag;
}

function eventCard(event) {
  const isOff = event.status !== 'scheduled';
  const headline = eventHeadline(event) || labelFor(state.boot.eventTypes, event.eventType);
  const meta = [];

  if (event.division) meta.push(h('span', {}, event.division));
  if (eventHeadline(event) && event.title && (event.homeTeam || event.awayTeam)) {
    meta.push(h('span', {}, [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ')));
  }
  meta.push(h('span', { class: `badge badge-${event.eventType}` },
    labelFor(state.boot.eventTypes, event.eventType)));

  return h('article', {
    class: `event type-${event.eventType}${isOff ? ' is-off' : ''}`,
    role: 'button',
    tabindex: '0',
    onClick: () => showEvent(event),
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showEvent(event); }
    },
  },
    h('div', { class: 'event-time' },
      event.allDay ? 'All day' : formatTime(event.startTime),
      event.allDay
        ? h('span', { class: 'to' }, 'field closed')
        : h('span', { class: 'to' }, `to ${formatTime(event.endTime)}`)),
    h('div', { class: 'event-main' },
      h('div', { class: 'event-title' }, headline),
      h('div', { class: 'event-meta' }, meta),
      event.notes ? h('div', { class: 'event-notes' }, event.notes) : null),
    h('div', { class: 'event-side' },
      isOff ? h('span', { class: `status-flag ${event.status}` },
        labelFor(state.boot.statuses, event.status)) : null,
      h('span', { class: 'event-field' }, `${event.locationName} · ${event.fieldName}`))
  );
}

function renderWeek() {
  const from = startOfWeek(state.anchor);
  const grid = h('div', { class: 'week-grid' });

  for (let i = 0; i < 7; i += 1) {
    const date = addDays(from, i);
    const dayEvents = state.events.filter((event) => event.date === date);
    const dateObj = parseDate(date);

    const col = h('div', { class: `week-col${date === state.today ? ' is-today' : ''}` },
      h('div', { class: 'week-col-head' },
        h('div', { class: 'week-col-dow' }, DOW_SHORT[dateObj.getDay()]),
        h('div', { class: 'week-col-date' }, `${MONTH_SHORT[dateObj.getMonth()]} ${dateObj.getDate()}`)),
      h('div', { class: 'week-col-body' },
        dayEvents.length
          ? dayEvents.map((event) =>
            h('button', {
              type: 'button',
              class: `mini-event type-${event.eventType}${event.status !== 'scheduled' ? ' is-off' : ''}`,
              onClick: () => showEvent(event),
            },
              h('div', { class: 'mini-time' }, event.allDay ? 'All day' : formatTime(event.startTime)),
              h('div', { class: 'mini-title' },
                eventHeadline(event) || labelFor(state.boot.eventTypes, event.eventType)),
              h('div', { class: 'mini-where' }, `${event.locationName} · ${event.fieldName}`)))
          : h('p', { class: 'inline-note', style: 'margin:4px 2px;font-size:12px' }, 'No events')));
    grid.append(col);
  }
  return grid;
}

/* ---------------- Event detail modal ---------------- */

function showEvent(event) {
  const modal = $('#event-modal');
  const location = state.boot.locations.find((loc) => loc.id === event.locationId);

  $('#event-modal-title').textContent =
    eventHeadline(event) || labelFor(state.boot.eventTypes, event.eventType);

  const rows = [
    ['When', `${formatDateLong(event.date)}\n${describeWhen(event)}`],
    ['Where', `${event.locationName} — ${event.fieldName}`],
    ['Type', labelFor(state.boot.eventTypes, event.eventType)],
  ];
  if (event.division) rows.push(['Division', event.division]);
  if (event.homeTeam || event.awayTeam) {
    rows.push(['Teams', [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ')]);
  }
  if (event.status !== 'scheduled') {
    rows.push(['Status', labelFor(state.boot.statuses, event.status)]);
  }
  if (event.locationAddress) rows.push(['Address', event.locationAddress]);
  if (event.notes) rows.push(['Notes', event.notes]);

  const list = h('dl', { class: 'detail-rows' });
  rows.forEach(([label, value]) => {
    const dd = h('dd', {});
    String(value).split('\n').forEach((line, i) => {
      if (i) dd.append(h('br'));
      dd.append(document.createTextNode(line));
    });
    list.append(h('div', { class: 'detail-row' }, h('dt', {}, label), dd));
  });

  const body = clear($('#event-modal-body'));
  body.append(list);

  if (location?.mapImage) {
    body.append(
      h('div', { style: 'margin-top:14px' },
        h('button', { class: 'btn btn-block', type: 'button',
          onClick: () => { closeModal(modal); showFieldMap(location); } },
          `View ${location.name} field map`))
    );
  }

  const directions = $('#event-modal-directions');
  if (location) {
    directions.href = directionsUrl(location);
    directions.hidden = false;
    directions.textContent = `Directions to ${location.name}`;
  } else {
    directions.hidden = true;
  }

  openModal(modal);
}

/* ---------------- Locations, directions and field maps ---------------- */

function renderLocations() {
  const grid = clear($('#loc-grid'));

  state.boot.locations.forEach((loc) => {
    const pills = h('div', { class: 'field-pills' },
      loc.fields.map((field) =>
        h('span', { class: `field-pill${field.kind === 'cage' ? ' is-cage' : field.kind === 'turf' ? ' is-turf' : field.kind === 'softball' ? ' is-softball' : ''}` },
          field.name)));

    const card = h('article', { class: 'loc-card' },
      h('div', { class: 'loc-card-head' },
        h('h3', {}, loc.name),
        loc.address ? h('div', { class: 'addr' }, loc.address) : null),
      h('div', { class: 'loc-card-body' },
        h('div', {},
          h('div', { class: 'lbl', style: 'margin-bottom:6px' },
            loc.fields.length === 1 ? '1 field' : `${loc.fields.length} fields`),
          pills),
        loc.notes ? h('p', { class: 'loc-note' }, loc.notes) : null,
        h('div', { class: 'loc-card-actions' },
          h('a', { class: 'btn btn-primary', href: directionsUrl(loc), target: '_blank', rel: 'noopener' },
            'Directions'),
          h('button', { class: 'btn', type: 'button', onClick: () => showFieldMap(loc) },
            'Field Map'))));

    grid.append(card);
  });
}

function showFieldMap(location) {
  const modal = $('#map-modal');
  $('#map-modal-title').textContent = `${location.name} — Field Map`;
  const body = clear($('#map-modal-body'));

  if (location.mapImage) {
    const stage = h('div', { class: 'map-stage' },
      h('img', { src: location.mapImage, alt: `Map of the fields at ${location.name}` }));

    location.pins.forEach((pin) => {
      const marker = h('div', { class: 'map-pin' },
        h('span', { class: 'map-pin-label' }, pin.label),
        h('span', { class: 'map-pin-stem' }),
        h('span', { class: 'map-pin-dot' }));
      marker.style.left = `${pin.x}%`;
      marker.style.top = `${pin.y}%`;
      if (pin.color) {
        marker.querySelector('.map-pin-label').style.background = pin.color;
        marker.querySelector('.map-pin-stem').style.background = pin.color;
        marker.querySelector('.map-pin-dot').style.background = pin.color;
      }
      stage.append(marker);
    });
    body.append(stage);

    if (location.pins.length) {
      body.append(h('p', { class: 'hint', style: 'margin-top:10px' },
        'Labels mark each field on the site.'));
    }
  } else {
    body.append(
      h('div', { class: 'map-empty' },
        h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🗺'),
        h('h3', {}, 'No field map uploaded yet'),
        h('p', {}, `A league admin can add a labeled map of ${location.name} from the admin console.`),
        h('div', { class: 'field-pills', style: 'justify-content:center;margin-top:14px' },
          location.fields.map((f) => h('span', { class: 'field-pill' }, f.name))))
    );
  }

  const directions = $('#map-modal-directions');
  directions.href = directionsUrl(location);
  directions.textContent = `Directions to ${location.name}`;
  openModal(modal);
}

/* ---------------- Calendar subscription ---------------- */

function openSubscribe() {
  const modal = $('#subscribe-modal');

  const refresh = () => {
    const params = new URLSearchParams();
    const loc = $('#sub-location').value;
    const field = $('#sub-field').value;
    const division = $('#sub-division').value;
    if (loc) params.set('location', loc);
    if (field) params.set('field', field);
    if (division) params.set('division', division);
    const query = params.toString();
    const path = `/calendar.ics${query ? `?${query}` : ''}`;
    $('#sub-url').value = `${window.location.origin}${path}`;
    $('#btn-download-ics').href = path;
  };

  $('#sub-location').value = state.filters.location || '';
  $('#sub-division').value = state.filters.division || '';
  rebuildFieldOptions();
  $('#sub-field').value = state.filters.field || '';
  refresh();

  $('#sub-location').onchange = () => { rebuildFieldOptions(); refresh(); };
  $('#sub-field').onchange = refresh;
  $('#sub-division').onchange = refresh;

  $('#btn-copy-url').onclick = async () => {
    const input = $('#sub-url');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Subscription link copied.', 'success');
    } catch {
      input.select();
      toast('Press Ctrl/Cmd + C to copy the selected link.');
    }
  };

  openModal(modal);
}

document.addEventListener('DOMContentLoaded', init);
