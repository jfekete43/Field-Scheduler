/* Shared helpers for the public schedule and the admin console. */
'use strict';

/* ---------------- DOM building (text-safe by construction) ---------------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- Dates (plain YYYY-MM-DD strings, no timezone math) ------ */

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** Parses 'YYYY-MM-DD' into a local Date at midnight (never UTC-shifted). */
function parseDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

/** Sunday-based start of week. */
function startOfWeek(dateStr) {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() - date.getDay());
  return toISODate(date);
}

function formatDateLong(dateStr) {
  const date = parseDate(dateStr);
  return `${DOW_LONG[date.getDay()]}, ${MONTH_LONG[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatDateMedium(dateStr) {
  const date = parseDate(dateStr);
  return `${DOW_SHORT[date.getDay()]}, ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
}

function formatRangeLabel(fromStr, toStr) {
  const from = parseDate(fromStr);
  const to = parseDate(toStr);
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  // A week spanning New Year has to name both years, or late December reads as
  // though it belonged to the following one.
  const left = sameYear
    ? `${MONTH_SHORT[from.getMonth()]} ${from.getDate()}`
    : `${MONTH_SHORT[from.getMonth()]} ${from.getDate()}, ${from.getFullYear()}`;
  const right = sameMonth
    ? `${to.getDate()}`
    : `${MONTH_SHORT[to.getMonth()]} ${to.getDate()}`;
  return `${left} – ${right}, ${to.getFullYear()}`;
}

/** '14:30' -> '2:30 PM' */
function formatTime(timeStr) {
  const [hRaw, m] = String(timeStr).split(':').map(Number);
  const suffix = hRaw < 12 ? 'AM' : 'PM';
  const hour = hRaw % 12 === 0 ? 12 : hRaw % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** How an event's time reads in a list: a span, or "All day". */
function describeWhen(event) {
  return event.allDay ? 'All day' : formatTimeRange(event.startTime, event.endTime);
}

function formatTimeRange(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function formatTimestamp(value) {
  if (!value) return '—';
  // SQLite datetime('now') returns UTC without a zone marker.
  const normalized = /Z|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/* ---------------- API ---------------- */

const api = {
  csrfToken: null,

  async request(method, url, body, options = {}) {
    const init = { method, headers: {}, credentials: 'same-origin' };

    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (api.csrfToken && method !== 'GET') init.headers['x-csrf-token'] = api.csrfToken;

    const response = await fetch(url, init);
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await response.json().catch(() => ({})) : {};

    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.conflicts = payload.conflicts;
      error.eventCount = payload.eventCount;
      error.payload = payload;
      if (response.status === 401 && !options.quiet) {
        toast('Your session ended. Please sign in again.', 'error');
        setTimeout(() => { window.location.href = '/admin/login'; }, 1400);
      }
      throw error;
    }
    return payload;
  },

  get: (url, options) => api.request('GET', url, undefined, options),
  post: (url, body, options) => api.request('POST', url, body, options),
  put: (url, body, options) => api.request('PUT', url, body, options),
  del: (url, options) => api.request('DELETE', url, undefined, options),
};

/* ---------------- Toasts ---------------- */

function toast(message, kind = 'info', ms = 4200) {
  const stack = document.getElementById('toast-stack');
  if (!stack) { console.log(`[${kind}]`, message); return; }
  const node = h('div', { class: `toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`, role: 'status' }, message);
  stack.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? ms + 2200 : ms);
}

/* ---------------- Modals ---------------- */

function openModal(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeModal(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function wireModals(root = document) {
  $$('dialog.modal', root).forEach((dialog) => {
    $$('[data-close]', dialog).forEach((btn) =>
      btn.addEventListener('click', () => closeModal(dialog))
    );
    // Click on the backdrop closes the dialog.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeModal(dialog);
    });
  });
}

/* ---------------- Maps ---------------- */

function directionsUrl(location) {
  const query = location.mapsQuery || location.address || location.name || '';
  if (location.latitude != null && location.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${location.latitude},${location.longitude}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

/* ---------------- Misc ---------------- */

function setBranding(settings) {
  const name = settings.leagueName || 'Jackson Holbrook Little League';
  document.title = `Field Schedule — ${name}`;

  const nameEl = document.getElementById('brand-name');
  if (nameEl) nameEl.textContent = name;

  const subEl = document.getElementById('brand-sub');
  if (subEl && settings.seasonLabel) subEl.textContent = settings.seasonLabel;

  const footer = document.getElementById('footer-league');
  if (footer) footer.textContent = name;

  const contact = document.getElementById('footer-contact');
  if (contact && settings.contactEmail) {
    clear(contact).append(h('a', { href: `mailto:${settings.contactEmail}` }, settings.contactEmail));
  }

  const slot = document.getElementById('brand-logo-slot');
  if (slot && settings.logoPath) {
    clear(slot).append(h('img', { class: 'brand-logo', src: settings.logoPath, alt: `${name} logo` }));
  } else if (slot) {
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const fallback = slot.querySelector('.brand-logo-fallback');
    if (fallback) fallback.textContent = initials || 'JH';
  }
}

function renderAnnouncement(settings) {
  const slot = document.getElementById('announcement-slot');
  if (!slot) return;
  clear(slot);
  if (!settings.announcement) return;
  const level = ['info', 'warning', 'alert'].includes(settings.announcementLevel)
    ? settings.announcementLevel
    : 'info';
  const icon = level === 'alert' ? '⚠' : level === 'warning' ? '⚡' : 'ℹ';
  slot.append(
    h('div', { class: `announcement announcement-${level}`, role: 'status' },
      h('span', { class: 'announcement-icon', 'aria-hidden': 'true' }, icon),
      h('span', {}, settings.announcement))
  );
}

function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function labelFor(list, value, fallback = '') {
  const found = (list || []).find((item) => item.value === value);
  return found ? found.label : fallback || value;
}

function eventHeadline(event) {
  const vs = [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ');
  return event.title || vs || event.division || '';
}
