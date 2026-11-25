// Timezone helpers built on Luxon (which uses the platform's IANA tz database).
import { DateTime, FixedOffsetZone } from 'luxon';

const MIN = 60_000;
const DAY = 86_400_000;

/**
 * First whole minute in (loMs, hiMs] whose UTC offset differs from loMs's.
 * Binary search on minutes, so the result is exact (tz changes fall on minutes).
 */
export function findChange(loMs, hiMs, zone) {
  const base = DateTime.fromMillis(loMs, { zone }).offset;
  let lo = Math.floor(loMs / MIN);
  let hi = Math.ceil(hiMs / MIN);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (DateTime.fromMillis(mid * MIN, { zone }).offset === base) lo = mid; else hi = mid;
  }
  return DateTime.fromMillis(hi * MIN, { zone });
}

/** Human abbreviation (CET/CEST, EST/EDT, GMT/BST); falls back to the UTC offset. */
export function zoneAbbr(dt) {
  for (const locale of ['en-US', 'en-GB', 'en-AU', 'en-NZ', 'en-IN', 'en-ZA']) {
    const n = dt.setLocale(locale).offsetNameShort;
    if (n && !/^(GMT|UTC)[+-]/.test(n)) return n;
  }
  const o = dt.toFormat('ZZ');
  return o === '+00:00' ? 'UTC' : `UTC${o.replace(/:00$/, '')}`;
}

/**
 * Every offset change of `zone` between two instants.
 * @returns {{at: DateTime, from: number, to: number, isDST: boolean, abbrBefore: string, abbrAfter: string}[]}
 */
export function transitionsBetween(zone, startMs, endMs) {
  const out = [];
  let prevMs = startMs;
  let prevOffset = DateTime.fromMillis(startMs, { zone }).offset;
  for (let t = startMs + DAY; t <= endMs + DAY; t += DAY) {
    const ms = Math.min(t, endMs);
    const off = DateTime.fromMillis(ms, { zone }).offset;
    if (off !== prevOffset) {
      const at = findChange(prevMs, ms, zone);
      const before = DateTime.fromMillis(at.toMillis() - MIN, { zone });
      out.push({ at, from: prevOffset, to: at.offset, isDST: at.isInDST, abbrBefore: zoneAbbr(before), abbrAfter: zoneAbbr(at) });
      prevOffset = off;
    }
    prevMs = ms;
    if (ms === endMs) break;
  }
  return out;
}

/** Offset minutes -> RFC 5545 UTC-OFFSET (+hhmm / -hhmm[ss]). */
export function fmtOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = Math.floor(abs % 60);
  const s = Math.round((abs * 60) % 60);
  return `${sign}${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${s ? String(s).padStart(2, '0') : ''}`;
}

/** Wall-clock time just before a transition, expressed in the old offset. */
export function wallBefore(transition) {
  return DateTime.fromMillis(transition.at.toMillis(), { zone: FixedOffsetZone.instance(transition.from) });
}
