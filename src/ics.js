'use strict';

/**
 * Minimal iCalendar (RFC 5545) feed builder.
 *
 * Wall-clock times are stored without a zone, so they are converted to UTC
 * using the league's configured timezone before being emitted as Z-times.
 * That keeps the feed correct in Google Calendar, Apple Calendar and Outlook
 * across daylight-saving changes.
 */

const { EVENT_TYPES, STATUSES } = require('./schedule');

const TYPE_LABELS = Object.fromEntries(EVENT_TYPES.map((t) => [t.value, t.label]));
const STATUS_LABELS = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));

/** Offset in minutes between the given timezone and UTC at that instant. */
function zoneOffsetMinutes(utcDate, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcDate).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUTC - utcDate.getTime()) / 60000;
}

/** Converts 'YYYY-MM-DD' + 'HH:MM' in `timeZone` to a UTC Date. */
function wallTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Two passes settle the offset correctly on DST boundaries.
  let guess = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMinutes(guess, timeZone);
    guess = new Date(naive - offset * 60000);
  }
  return guess;
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function stampUtc(date) {
  return `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // Any CR, LF or CRLF becomes a literal \n escape. A bare CR left in place
    // would start a new content line and let text break out of the field.
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds lines at 75 octets as the spec requires. */
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  for (const char of line) {
    const candidate = current + char;
    const limit = out.length === 0 ? 75 : 74;
    if (Buffer.byteLength(candidate, 'utf8') > limit) {
      out.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

function summaryFor(event) {
  const vs = [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ');
  const core = event.title || vs || TYPE_LABELS[event.eventType] || 'Event';
  const prefix = event.status !== 'scheduled' ? `${STATUS_LABELS[event.status] || event.status}: ` : '';
  const division = event.division ? ` (${event.division})` : '';
  return `${prefix}${core}${division}`;
}

function descriptionFor(event) {
  const lines = [];
  if (event.title) lines.push(event.title);
  const vs = [event.homeTeam, event.awayTeam].filter(Boolean).join(' vs ');
  if (vs) lines.push(vs);
  if (event.division) lines.push(`Division: ${event.division}`);
  lines.push(`Type: ${TYPE_LABELS[event.eventType] || event.eventType}`);
  if (event.status !== 'scheduled') lines.push(`Status: ${STATUS_LABELS[event.status] || event.status}`);
  if (event.notes) lines.push('', event.notes);
  return lines.join('\n');
}

function buildCalendar(events, { calendarName, timeZone, domain = 'jhll.local' }) {
  const now = stampUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jackson Holbrook Little League//Field Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(timeZone)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  for (const event of events) {
    const place = [event.locationName, event.fieldName].filter(Boolean).join(' - ');
    const address = event.locationAddress ? ` (${event.locationAddress})` : '';

    // An all-day block is emitted as a DATE value, so calendars show it as a
    // banner across the day instead of a timed entry from midnight to 23:59.
    // DTEND is exclusive, hence the following day.
    const whenLines = event.allDay
      ? [`DTSTART;VALUE=DATE:${event.date.replace(/-/g, '')}`,
         `DTEND;VALUE=DATE:${nextDay(event.date).replace(/-/g, '')}`]
      : [`DTSTART:${stampUtc(wallTimeToUtc(event.date, event.startTime, timeZone))}`,
         `DTEND:${stampUtc(wallTimeToUtc(event.date, event.endTime, timeZone))}`];

    lines.push(
      'BEGIN:VEVENT',
      `UID:event-${event.id}@${domain}`,
      `DTSTAMP:${now}`,
      ...whenLines,
      `SUMMARY:${escapeText(summaryFor(event))}`,
      `LOCATION:${escapeText(place + address)}`,
      `DESCRIPTION:${escapeText(descriptionFor(event))}`,
      `CATEGORIES:${escapeText(TYPE_LABELS[event.eventType] || 'Event')}`,
      `STATUS:${event.status === 'scheduled' ? 'CONFIRMED' : 'CANCELLED'}`,
      `LAST-MODIFIED:${now}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, wallTimeToUtc, zoneOffsetMinutes };
