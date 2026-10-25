/* ------------------------------------------------------------------
   Timeline view: fields down the side, time across the top.

   Reads like a TV guide — each field is a row, each booking a block, and
   the gaps between them are the times the field is free. Shared by the
   public schedule and the admin console; the admin passes onEmptyClick so
   that clicking a gap starts a booking at that time.
   ------------------------------------------------------------------ */
'use strict';

const TL_PX_PER_HOUR = 92;
const TL_DEFAULT_START = 8 * 60;   // 8:00 am
const TL_DEFAULT_END = 21 * 60;    // 9:00 pm
const TL_SNAP_MINUTES = 15;

function tlMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function tlLabel(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h}${suffix}` : `${h}:${String(m).padStart(2, '0')}`;
}

/** The window the day needs: a sensible default, widened to fit real bookings. */
function tlRange(events) {
  let start = TL_DEFAULT_START;
  let end = TL_DEFAULT_END;
  for (const event of events) {
    if (event.allDay) continue;
    start = Math.min(start, tlMinutes(event.startTime));
    end = Math.max(end, tlMinutes(event.endTime));
  }
  // Round out to whole hours so the header ticks land cleanly.
  start = Math.floor(start / 60) * 60;
  end = Math.ceil(end / 60) * 60;
  if (end - start < 240) end = start + 240;
  return { start, end };
}

/**
 * Packs a field's bookings into lanes so a double-booking shows as two
 * stacked blocks rather than one hiding the other.
 */
function tlLanes(events) {
  const sorted = events.slice().sort((a, b) => tlMinutes(a.startTime) - tlMinutes(b.startTime));
  const lanes = [];
  for (const event of sorted) {
    const from = tlMinutes(event.startTime);
    const to = tlMinutes(event.endTime);
    let placed = false;
    for (const lane of lanes) {
      if (lane.length && tlMinutes(lane[lane.length - 1].endTime) <= from) {
        lane.push(event);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([event]);
    event.__from = from;
    event.__to = to;
  }
  return lanes;
}

/**
 * Draws the whole timeline into `container`.
 *
 * events      - the day's events, already filtered
 * locations   - bootstrap locations, for row order and field names
 * date        - the day being shown (YYYY-MM-DD)
 * today       - the league's today, for the "now" line
 * labels      - event type labels, for block text
 * onEventClick(event)
 * onEmptyClick(field, location, 'HH:MM')  - optional; enables gap clicking
 */
function renderTimeline(container, {
  events, locations, date, today, labels = [], onEventClick, onEmptyClick,
}) {
  clear(container);

  const byField = new Map();
  for (const event of events) {
    if (!byField.has(event.fieldId)) byField.set(event.fieldId, []);
    byField.get(event.fieldId).push(event);
  }

  // Only show sites that have something on; an empty site is noise here.
  const rows = [];
  for (const loc of locations) {
    const used = loc.fields.filter((f) => byField.has(f.id));
    if (!used.length) continue;
    rows.push({ location: loc, fields: used });
  }

  if (!rows.length) {
    container.append(
      h('div', { class: 'empty' },
        h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '⚾'),
        h('h3', {}, 'Nothing booked'),
        h('p', {}, 'No fields are in use on this date.'))
    );
    return;
  }

  const { start, end } = tlRange(events);
  const span = end - start;
  const width = (span / 60) * TL_PX_PER_HOUR;
  const pct = (minutes) => ((minutes - start) / span) * 100;

  const scroll = h('div', { class: 'tl-scroll' });
  const inner = h('div', { class: 'tl-inner' });
  inner.style.setProperty('--tl-track', `${width}px`);

  /* ---- header: the hour ruler ---- */
  const headTrack = h('div', { class: 'tl-track tl-head-track' });
  for (let m = start; m <= end; m += 60) {
    const tick = h('div', { class: 'tl-tick' }, tlLabel(m));
    tick.style.left = `${pct(m)}%`;
    headTrack.append(tick);
  }
  inner.append(
    h('div', { class: 'tl-row tl-head' },
      h('div', { class: 'tl-label tl-head-label' }, 'Field'),
      headTrack)
  );

  /* ---- a row per field, grouped by location ---- */
  for (const row of rows) {
    inner.append(
      h('div', { class: 'tl-row tl-loc' },
        h('div', { class: 'tl-label tl-loc-label' }, row.location.name),
        h('div', { class: 'tl-track tl-loc-track' }))
    );

    for (const field of row.fields) {
      const fieldEvents = byField.get(field.id) || [];
      const allDay = fieldEvents.filter((e) => e.allDay);
      const timed = fieldEvents.filter((e) => !e.allDay);
      const lanes = tlLanes(timed);
      const laneCount = Math.max(1, lanes.length);

      const track = h('div', { class: 'tl-track tl-field-track' });
      track.style.setProperty('--tl-lanes', String(laneCount));

      // A gap is bookable: clicking one starts an event at that time.
      if (onEmptyClick) {
        track.classList.add('is-clickable');
        track.addEventListener('click', (clickEvent) => {
          if (clickEvent.target.closest('.tl-event')) return;
          const rect = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (clickEvent.clientX - rect.left) / rect.width));
          const raw = start + ratio * span;
          const snapped = Math.round(raw / TL_SNAP_MINUTES) * TL_SNAP_MINUTES;
          const clamped = Math.min(end - 60, Math.max(start, snapped));
          const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
          const mm = String(clamped % 60).padStart(2, '0');
          onEmptyClick(field, row.location, `${hh}:${mm}`);
        });
      }

      allDay.forEach((event) => {
        const block = tlBlock(event, labels, onEventClick);
        block.classList.add('is-all-day');
        block.style.left = '0';
        block.style.width = '100%';
        block.style.top = '3px';
        block.style.bottom = '3px';
        track.append(block);
      });

      lanes.forEach((lane, laneIndex) => {
        lane.forEach((event) => {
          const block = tlBlock(event, labels, onEventClick);
          block.style.left = `${pct(event.__from)}%`;
          block.style.width = `${Math.max(((event.__to - event.__from) / span) * 100, 1.6)}%`;
          block.style.top = `calc(${(laneIndex / laneCount) * 100}% + 3px)`;
          block.style.height = `calc(${100 / laneCount}% - 6px)`;
          track.append(block);
        });
      });

      // A line showing the current time, when looking at today.
      if (date === today) {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        if (nowMinutes >= start && nowMinutes <= end) {
          const line = h('div', { class: 'tl-now', 'aria-hidden': 'true' });
          line.style.left = `${pct(nowMinutes)}%`;
          track.append(line);
        }
      }

      const label = h('div', { class: 'tl-label tl-field-label' },
        h('span', { class: 'tl-field-name' }, field.name),
        field.kind === 'cage' ? h('span', { class: 'tl-kind' }, 'indoor') : null,
        field.kind === 'turf' ? h('span', { class: 'tl-kind' }, 'turf') : null);

      const fieldRow = h('div', { class: 'tl-row tl-field' }, label, track);
      fieldRow.style.setProperty('--tl-lanes', String(laneCount));
      inner.append(fieldRow);
    }
  }

  scroll.append(inner);
  container.append(scroll);

  if (onEmptyClick) {
    container.append(
      h('p', { class: 'hint', style: 'margin:9px 2px 0' },
        'Click any empty stretch to book that field at that time.')
    );
  }

  // Open on the first booking rather than at the far left of the ruler.
  const earliest = events.filter((e) => !e.allDay)
    .reduce((min, e) => Math.min(min, tlMinutes(e.startTime)), Infinity);
  if (Number.isFinite(earliest)) {
    scroll.scrollLeft = Math.max(0, ((earliest - start) / span) * width - 24);
  }
}

function tlBlock(event, labels, onEventClick) {
  const vs = [event.homeTeam, event.awayTeam].filter(Boolean).join(' v ');
  const title = event.title || vs || event.division
    || labelFor(labels, event.eventType, event.eventType);

  const block = h('button', {
    type: 'button',
    class: `tl-event type-${event.eventType}${event.status !== 'scheduled' ? ' is-off' : ''}`,
    title: `${event.allDay ? 'All day' : formatTimeRange(event.startTime, event.endTime)} — ${title}`,
    onClick: (clickEvent) => {
      clickEvent.stopPropagation();
      if (onEventClick) onEventClick(event);
    },
  },
    h('span', { class: 'tl-event-title' }, title),
    h('span', { class: 'tl-event-time' },
      event.allDay ? 'All day' : formatTime(event.startTime)));

  return block;
}

/* Exported for the test suite; harmless in the browser, where there is no
   module object. Nothing above runs at import time. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tlMinutes, tlLabel, tlRange, tlLanes };
}
