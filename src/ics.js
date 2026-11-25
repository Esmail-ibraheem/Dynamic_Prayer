// RFC 5545 iCalendar writer for prayer blocks.
import { DateTime } from 'luxon';
import { vtimezoneLines } from './vtimezone.js';
import { METHODS } from './methods.js';

export const PRODID = '-//Waqt Blocks//Prayer Calendar Blocker 1.0//EN';

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/**
 * Fold a content line to at most 75 octets per physical line (RFC 5545 §3.1),
 * never splitting a UTF-8 multi-byte sequence.
 */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  let limit = 75;
  while (i < bytes.length) {
    let end = Math.min(i + limit, bytes.length);
    // Back off so we do not cut inside a multi-byte character (10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(i, end).toString('utf8'));
    i = end;
    limit = 74; // continuation lines start with one space
  }
  return parts.join('\r\n ');
}

const utcStamp = (dt) => dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
const localStamp = (dt) => dt.toFormat("yyyyMMdd'T'HHmmss");

function summaryFor(block, ev) {
  if (ev.titleMode === 'prayer') return block.label;
  if (ev.titleMode === 'both') return `${ev.title} · ${block.label}`;
  return ev.title;
}

function descriptionFor(block, day, settings) {
  const mode = settings.event.description;
  if (mode === 'none') return null;
  if (mode === 'generic') return 'Personal time block. Please schedule around it.';
  const method = METHODS.find((m) => m.id === settings.method)?.label || settings.method;
  const adhan = block.adhan ? DateTime.fromISO(block.adhan, { setZone: true }).toFormat('HH:mm') : null;
  const parts = [`${block.label}${adhan && block.prayer !== 'jumuah' ? ` · Adhan ${adhan} ${day.abbr}` : ''}`];
  if (block.prayer === 'jumuah' && block.rule) parts.push(`Friday rule: ${block.rule}`);
  parts.push(`${day.location.name}${day.location.country ? `, ${day.location.country}` : ''} · ${method}`);
  return parts.join('\n');
}

/**
 * Build the calendar text.
 * @param {object} opts
 * @param {any} opts.settings    normalised settings
 * @param {any[]} opts.days      output of computeRange()
 * @param {string} opts.feedId   stable, non-secret id used in UIDs
 * @param {number} [opts.revision]
 * @param {string} [opts.updatedAt] ISO timestamp of the last settings change
 * @param {string} [opts.uidDomain]
 */
export function buildCalendar({ settings, days, feedId, revision = 1, updatedAt, uidDomain = 'waqt.blocks' }) {
  const ev = settings.event;
  const tzid = settings.feed.timeFormat === 'tzid';
  const stamp = utcStamp(updatedAt ? DateTime.fromISO(updatedAt) : DateTime.utc());
  const home = settings.location.timezone;

  const events = [];
  const zonesUsed = new Map(); // zone -> [minMs, maxMs]
  for (const day of days) {
    for (const b of day.blocks) {
      if (!b.included) continue;
      const start = DateTime.fromISO(b.start, { zone: day.zone });
      const end = DateTime.fromISO(b.end, { zone: day.zone });
      const range = zonesUsed.get(day.zone) || [Infinity, -Infinity];
      zonesUsed.set(day.zone, [Math.min(range[0], start.toMillis()), Math.max(range[1], end.toMillis())]);
      const desc = descriptionFor(b, day, settings);
      const lines = [
        'BEGIN:VEVENT',
        `UID:${feedId}-${day.date.replace(/-/g, '')}-${b.prayer}@${uidDomain}`,
        `DTSTAMP:${stamp}`,
        `LAST-MODIFIED:${stamp}`,
        `SEQUENCE:${revision}`,
        tzid ? `DTSTART;TZID=${day.zone}:${localStamp(start)}` : `DTSTART:${utcStamp(start)}`,
        tzid ? `DTEND;TZID=${day.zone}:${localStamp(end)}` : `DTEND:${utcStamp(end)}`,
        `SUMMARY:${escapeText(summaryFor(b, ev))}`,
      ];
      if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
      lines.push(
        `TRANSP:${ev.busy ? 'OPAQUE' : 'TRANSPARENT'}`,
        'STATUS:CONFIRMED',
        `CLASS:${ev.private ? 'PRIVATE' : 'PUBLIC'}`,
        `X-MICROSOFT-CDO-BUSYSTATUS:${ev.busy ? 'BUSY' : 'FREE'}`,
        `X-MICROSOFT-CDO-INTENDEDSTATUS:${ev.busy ? 'BUSY' : 'FREE'}`,
        'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
      );
      if (ev.alarmMinutes > 0) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(summaryFor(b, ev))}`, `TRIGGER:-PT${ev.alarmMinutes}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
      events.push(...lines);
    }
  }

  const cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(settings.feed.name)}`,
    `X-WR-CALNAME:${escapeText(settings.feed.name)}`,
    `X-WR-CALDESC:${escapeText('Prayer-time blocks that follow the sun and your timezone.')}`,
    `X-WR-TIMEZONE:${home}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  if (tzid) {
    if (!zonesUsed.has(home)) {
      const now = Date.now();
      zonesUsed.set(home, [now, now]);
    }
    for (const [zone, [lo, hi]] of zonesUsed) cal.push(...vtimezoneLines(zone, lo, hi));
  }
  cal.push(...events, 'END:VCALENDAR');
  return cal.map(foldLine).join('\r\n') + '\r\n';
}
