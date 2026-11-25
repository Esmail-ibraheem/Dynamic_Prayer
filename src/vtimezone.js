// RFC 5545 VTIMEZONE generation from the live IANA database.
//
// For zones whose transitions follow a yearly "nth weekday of month" pattern
// (EU: last Sunday of March/October, US: 2nd Sunday March / 1st Sunday
// November, …) we emit the compact RRULE form that Outlook handles best,
// e.g. `RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU`. The rule is derived from
// and verified against every real transition around the feed window. Zones
// with irregular rules fall back to one explicit observance per transition.
import { DateTime } from 'luxon';
import { transitionsBetween, fmtOffset, wallBefore, zoneAbbr } from './tz.js';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const MARGIN_MS = 400 * 86_400_000;

const icsLocal = (dt) => dt.toFormat("yyyyMMdd'T'HHmmss");

/** Derive a yearly RRULE describing all transitions of one kind, or null. */
function deriveRule(list) {
  if (list.length < 2) return null;
  const walls = list.map(wallBefore);
  const first = walls[0];
  const same = (f) => walls.every((w) => f(w) === f(first));
  if (!same((w) => w.month) || !same((w) => w.weekday) || !same((w) => w.toFormat('HHmmss'))) return null;
  if (!list.every((t) => t.from === list[0].from && t.to === list[0].to)) return null;
  // One transition per consecutive year, no gaps.
  if (!walls.every((w, i) => i === 0 || w.year === walls[i - 1].year + 1)) return null;
  const ordinals = walls.map((w) => Math.ceil(w.day / 7));
  const isLast = walls.map((w) => w.day + 7 > w.daysInMonth);
  let n;
  if (isLast.every(Boolean)) n = -1;
  else if (ordinals.every((o) => o === ordinals[0]) && ordinals[0] <= 4) n = ordinals[0];
  else return null;
  return { month: first.month, weekday: first.weekday, n, hour: first.hour, minute: first.minute, second: first.second };
}

/** The date in `year` matching a derived rule (used for the 1970 DTSTART). */
function ruleDate(rule, year) {
  if (rule.n > 0) {
    const firstOfMonth = DateTime.utc(year, rule.month, 1);
    const delta = (rule.weekday - firstOfMonth.weekday + 7) % 7;
    return firstOfMonth.plus({ days: delta + 7 * (rule.n - 1) });
  }
  const last = DateTime.utc(year, rule.month, 1).endOf('month').startOf('day');
  const delta = (last.weekday - rule.weekday + 7) % 7;
  return last.minus({ days: delta });
}

/**
 * VTIMEZONE lines for `zone`, valid for events between fromMs and toMs.
 * @returns {string[]}
 */
export function vtimezoneLines(zone, fromMs, toMs) {
  const scanStart = fromMs - MARGIN_MS;
  const scanEnd = toMs + MARGIN_MS;
  const trans = transitionsBetween(zone, scanStart, scanEnd);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, `X-LIC-LOCATION:${zone}`];

  if (trans.length === 0) {
    const dt = DateTime.fromMillis(fromMs, { zone });
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${fmtOffset(dt.offset)}`, `TZOFFSETTO:${fmtOffset(dt.offset)}`, `TZNAME:${zoneAbbr(dt)}`, 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE');
    return lines;
  }

  const daylight = trans.filter((t) => t.isDST);
  const standard = trans.filter((t) => !t.isDST);
  const dRule = deriveRule(daylight);
  const sRule = deriveRule(standard);

  if (daylight.length && standard.length && dRule && sRule) {
    for (const [kind, list, rule] of [['DAYLIGHT', daylight, dRule], ['STANDARD', standard, sRule]]) {
      const t = list[list.length - 1];
      const start = ruleDate(rule, 1970).set({ hour: rule.hour, minute: rule.minute, second: rule.second });
      const byday = `${rule.n}${WEEKDAYS[rule.weekday - 1]}`;
      lines.push(
        `BEGIN:${kind}`,
        `TZOFFSETFROM:${fmtOffset(t.from)}`,
        `TZOFFSETTO:${fmtOffset(t.to)}`,
        `TZNAME:${t.abbrAfter}`,
        `DTSTART:${icsLocal(start)}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${byday}`,
        `END:${kind}`,
      );
    }
    lines.push('END:VTIMEZONE');
    return lines;
  }

  // Irregular history: base observance + one observance per real transition.
  const base = DateTime.fromMillis(scanStart, { zone });
  const baseKind = base.isInDST ? 'DAYLIGHT' : 'STANDARD';
  lines.push(`BEGIN:${baseKind}`, `TZOFFSETFROM:${fmtOffset(base.offset)}`, `TZOFFSETTO:${fmtOffset(base.offset)}`, `TZNAME:${zoneAbbr(base)}`, 'DTSTART:19700101T000000', `END:${baseKind}`);
  for (const t of trans) {
    const kind = t.isDST ? 'DAYLIGHT' : 'STANDARD';
    lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${fmtOffset(t.from)}`, `TZOFFSETTO:${fmtOffset(t.to)}`, `TZNAME:${t.abbrAfter}`, `DTSTART:${icsLocal(wallBefore(t))}`, `END:${kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}
