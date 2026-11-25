// The scheduling engine: astronomical prayer times (adhan) -> per-day local
// blocks, resolved against the IANA timezone of *that* day, filtered by the
// user's workday, with Jumu'ah overrides and travel trips.
import { Coordinates, PrayerTimes, Madhab, HighLatitudeRule, PolarCircleResolution, Rounding } from 'adhan';
import { DateTime } from 'luxon';
import { buildMethodParams } from './methods.js';
import { findChange, zoneAbbr } from './tz.js';
import { PRAYERS, PRAYER_LABELS } from './settings.js';

/** @typedef {ReturnType<import('./settings.js').defaultSettings>} Settings */
/** @typedef {NonNullable<Settings['location']>} Location */

const ISO_OPTS = { suppressMilliseconds: true, suppressSeconds: true };

/** Location in effect on a given local date (a trip overrides home). */
export function locationFor(settings, isoDate) {
  const trip = settings.trips.find((t) => t.from <= isoDate && isoDate <= t.to);
  return trip ? { location: trip.location, trip } : { location: settings.location, trip: null };
}

/** adhan parameters for a settings object at a coordinate. */
function calcParams(settings, coords) {
  const p = buildMethodParams(settings.method, settings.customAngles);
  p.madhab = settings.madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  p.highLatitudeRule = settings.highLatitudeRule === 'auto' ? HighLatitudeRule.recommended(coords) : settings.highLatitudeRule;
  // Inside the polar circles some days have no sunrise/sunset; borrow the
  // nearest latitude where they exist instead of returning invalid times.
  p.polarCircleResolution = PolarCircleResolution.AqrabBalad;
  p.rounding = Rounding.Nearest;
  p.adjustments = { ...p.adjustments, ...settings.adjustments, sunrise: 0 };
  return p;
}

/**
 * Raw adhan times (as Luxon DateTimes in the location's zone) for a local date.
 * adhan reads the calendar date from the JS Date's *local* components, so we
 * build the Date from components (at local noon, which always exists).
 */
export function adhanTimes(settings, location, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const coords = new Coordinates(location.lat, location.lon);
  const pt = new PrayerTimes(coords, new Date(y, m - 1, d, 12, 0, 0), calcParams(settings, coords));
  const z = (t) => (t && !Number.isNaN(t.getTime()) ? DateTime.fromJSDate(t, { zone: location.timezone }) : null);
  return { fajr: z(pt.fajr), sunrise: z(pt.sunrise), dhuhr: z(pt.dhuhr), asr: z(pt.asr), sunset: z(pt.sunset), maghrib: z(pt.maghrib), isha: z(pt.isha) };
}

const atLocal = (isoDate, hhmm, zone) => {
  const [h, mi] = hhmm.split(':').map(Number);
  return DateTime.fromISO(isoDate, { zone }).set({ hour: h, minute: mi, second: 0, millisecond: 0 });
};

/**
 * Work windows that can contain blocks of `isoDate`: the window starting that
 * day, plus yesterday's window when a shift runs past midnight. Only windows
 * that start on a configured workday are returned.
 */
export function workWindows(settings, isoDate, zone) {
  const { start, end, days } = settings.work;
  const overnight = end <= start;
  const out = [];
  const starts = overnight ? [DateTime.fromISO(isoDate, { zone }).minus({ days: 1 }).toISODate(), isoDate] : [isoDate];
  for (const day of starts) {
    const dayDt = DateTime.fromISO(day, { zone });
    if (!days.includes(dayDt.weekday)) continue;
    const s = atLocal(day, start, zone);
    const e = overnight ? atLocal(dayDt.plus({ days: 1 }).toISODate(), end, zone) : atLocal(day, end, zone);
    out.push({ start: s, end: e, startDay: day });
  }
  return out;
}

function fits(block, win, mode) {
  if (mode === 'start') return block.start >= win.start && block.start < win.end;
  if (mode === 'overlap') return block.start < win.end && block.end > win.start;
  return block.start >= win.start && block.end <= win.end; // 'within'
}

/** The Jumu'ah block for a Friday, or null when the override is off. */
function jumuahBlock(settings, isoDate, zone, dhuhr) {
  const j = settings.jumuah;
  if (j.mode === 'off') return null;
  let start;
  let rule;
  if (j.mode === 'fixed') {
    start = atLocal(isoDate, j.fixedTime, zone);
    rule = `fixed ${j.fixedTime}`;
  } else if (j.mode === 'seasonal') {
    const dst = atLocal(isoDate, '12:00', zone).isInDST;
    start = atLocal(isoDate, dst ? j.summerTime : j.winterTime, zone);
    rule = dst ? `summer-time slot ${j.summerTime}` : `winter-time slot ${j.winterTime}`;
  } else {
    if (!dhuhr) return null;
    start = dhuhr.plus({ minutes: j.relativeOffset });
    rule = `Dhuhr ${j.relativeOffset >= 0 ? '+' : ''}${j.relativeOffset} min`;
  }
  return { prayer: 'jumuah', label: PRAYER_LABELS.jumuah, adhan: dhuhr, start, end: start.plus({ minutes: j.duration }), rule };
}

/** Offset and DST change (if any) happening on a local date. */
function transitionOn(isoDate, zone) {
  const a = DateTime.fromISO(isoDate, { zone }).startOf('day');
  const b = a.plus({ days: 1 }).startOf('day');
  if (a.offset === b.offset) return null;
  const at = findChange(a.toMillis(), b.toMillis(), zone);
  return { at: at.toUTC().toISO(ISO_OPTS), fromOffset: a.toFormat('ZZ'), toOffset: b.toFormat('ZZ'), fromAbbr: zoneAbbr(a), toAbbr: zoneAbbr(at), toDST: at.isInDST };
}

/**
 * Compute one local day: adhan times + candidate blocks with inclusion flags.
 * @param {Settings} settings
 * @param {string} isoDate  local calendar date (YYYY-MM-DD) at the location in effect
 */
export function computeDay(settings, isoDate) {
  const { location, trip } = locationFor(settings, isoDate);
  if (!location) throw new Error('No location configured');
  const zone = location.timezone;
  const noon = atLocal(isoDate, '12:00', zone);
  const times = adhanTimes(settings, location, isoDate);
  const weekday = noon.weekday;
  const isWorkday = settings.work.days.includes(weekday);
  const windows = settings.work.filter ? workWindows(settings, isoDate, zone) : [];

  /** @type {any[]} */
  const candidates = [];
  const friday = weekday === 5 && settings.jumuah.mode !== 'off';
  for (const p of PRAYERS) {
    const cfg = settings.prayers[p];
    const adhan = times[p];
    if (!adhan) continue;
    if (p === 'dhuhr' && friday) {
      const jb = jumuahBlock(settings, isoDate, zone, adhan);
      if (jb) { candidates.push({ ...jb, enabled: true }); continue; }
    }
    const start = adhan.plus({ minutes: cfg.offset });
    candidates.push({ prayer: p, label: PRAYER_LABELS[p], adhan, start, end: start.plus({ minutes: cfg.duration }), enabled: cfg.enabled });
  }

  const blocks = candidates.map((b) => {
    let included = b.enabled;
    let reason = b.enabled ? null : 'disabled';
    if (included && settings.work.filter) {
      if (!isWorkday && settings.work.offDays === 'all') {
        included = true;
      } else if (!windows.some((w) => fits(b, w, settings.work.fit))) {
        included = false;
        reason = windows.length === 0 ? 'day-off' : 'outside-hours';
      }
    }
    return {
      prayer: b.prayer,
      label: b.label,
      adhan: b.adhan ? b.adhan.toISO(ISO_OPTS) : null,
      start: b.start.toISO(ISO_OPTS),
      end: b.end.toISO(ISO_OPTS),
      startUtc: b.start.toUTC().toISO(ISO_OPTS),
      endUtc: b.end.toUTC().toISO(ISO_OPTS),
      minutes: Math.round(b.end.diff(b.start, 'minutes').minutes),
      rule: b.rule || null,
      included,
      reason,
    };
  });

  return {
    date: isoDate,
    weekday,
    isWorkday,
    zone,
    offset: noon.toFormat('ZZ'),
    abbr: zoneAbbr(noon),
    isDST: noon.isInDST,
    location: { name: location.name, admin: location.admin, country: location.country, cc: location.cc, lat: location.lat, lon: location.lon, timezone: zone },
    trip: trip ? { id: trip.id, label: trip.label, from: trip.from, to: trip.to } : null,
    transition: transitionOn(isoDate, zone),
    windows: windows.filter((w) => w.startDay === isoDate || w.end > atLocal(isoDate, '00:00', zone)).map((w) => ({ start: w.start.toISO(ISO_OPTS), end: w.end.toISO(ISO_OPTS) })),
    times: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v ? v.toISO(ISO_OPTS) : null])),
    blocks,
  };
}

/**
 * Compute a run of consecutive local dates.
 * @param {Settings} settings
 * @param {string} fromIso
 * @param {number} days
 */
export function computeRange(settings, fromIso, days) {
  const out = [];
  let d = DateTime.fromISO(fromIso, { zone: 'UTC' });
  for (let i = 0; i < days; i++) {
    out.push(computeDay(settings, d.toISODate()));
    d = d.plus({ days: 1 });
  }
  return out;
}

/** "Today" in the home location's timezone. */
export function todayIn(settings, now = DateTime.now()) {
  return now.setZone(settings.location.timezone).toISODate();
}

/** Rolling feed window: daysBack before today … daysAhead after. */
export function feedWindow(settings, now = DateTime.now()) {
  const today = DateTime.fromISO(todayIn(settings, now), { zone: 'UTC' });
  const from = today.minus({ days: settings.feed.daysBack }).toISODate();
  return { from, days: settings.feed.daysBack + settings.feed.daysAhead + 1 };
}

/** Next DST/offset change at the home location within `horizonDays`. */
export function nextTransition(settings, now = DateTime.now(), horizonDays = 400) {
  const zone = settings.location.timezone;
  let d = now.setZone(zone).startOf('day');
  for (let i = 0; i < horizonDays; i++) {
    const t = transitionOn(d.toISODate(), zone);
    if (t) return { date: d.toISODate(), ...t };
    d = d.plus({ days: 1 });
  }
  return null;
}

/** Compact weekly summary used by the dashboard. */
export function summarize(days) {
  const included = days.flatMap((d) => d.blocks.filter((b) => b.included));
  const byPrayer = {};
  for (const b of included) byPrayer[b.prayer] = (byPrayer[b.prayer] || 0) + 1;
  return {
    days: days.length,
    blocks: included.length,
    minutes: included.reduce((a, b) => a + b.minutes, 0),
    byPrayer,
  };
}
