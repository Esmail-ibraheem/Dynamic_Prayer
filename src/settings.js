// Feed settings: defaults, presets and strict-but-forgiving validation.
// Every value that reaches the engine passes through normalizeSettings().
import { IANAZone, DateTime } from 'luxon';
import { METHOD_IDS } from './methods.js';

export const PRAYERS = /** @type {const} */ (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
export const PRAYER_LABELS = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha', jumuah: "Jumu'ah" };

export const SETTINGS_VERSION = 1;
const MAX_TRIPS = 20;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A complete default configuration (location is filled in by the user). */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    location: null,
    method: 'MWL',
    customAngles: { fajrAngle: 18, ishaAngle: 17, ishaInterval: 0 },
    madhab: 'shafi',
    highLatitudeRule: 'auto',
    adjustments: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
    prayers: {
      fajr: { enabled: true, offset: 0, duration: 15 },
      dhuhr: { enabled: true, offset: 5, duration: 20 },
      asr: { enabled: true, offset: 5, duration: 20 },
      maghrib: { enabled: true, offset: 0, duration: 15 },
      isha: { enabled: true, offset: 5, duration: 20 },
    },
    work: { filter: true, start: '09:00', end: '17:30', days: [1, 2, 3, 4, 5], fit: 'within', offDays: 'skip' },
    jumuah: { mode: 'relative', fixedTime: '13:30', relativeOffset: 0, summerTime: '13:15', winterTime: '12:15', duration: 60 },
    event: { title: 'Focus / Personal Block', titleMode: 'custom', description: 'generic', busy: true, private: true, alarmMinutes: 0 },
    feed: { name: 'Prayer blocks', daysAhead: 90, daysBack: 7, timeFormat: 'utc' },
    trips: [],
  };
}

/** The exact configuration from the project proposal (Munich engineer, 09:00–18:00). */
export function munichExample() {
  const s = defaultSettings();
  s.location = { name: 'Munich', admin: 'Bavaria', country: 'Germany', cc: 'DE', lat: 48.1351, lon: 11.582, timezone: 'Europe/Berlin' };
  s.method = 'MWL';
  s.prayers.fajr.enabled = false;
  s.prayers.dhuhr = { enabled: true, offset: 5, duration: 20 };
  s.prayers.asr = { enabled: true, offset: 5, duration: 20 };
  s.prayers.maghrib = { enabled: true, offset: 0, duration: 15 };
  s.prayers.isha.enabled = false;
  s.work = { filter: true, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], fit: 'within', offDays: 'skip' };
  s.jumuah = { mode: 'seasonal', fixedTime: '13:30', relativeOffset: 15, summerTime: '13:15', winterTime: '12:15', duration: 60 };
  s.event = { title: 'Focus / Personal Block', titleMode: 'custom', description: 'generic', busy: true, private: true, alarmMinutes: 0 };
  return s;
}

export class SettingsError extends Error {
  /** @param {string[]} issues */
  constructor(issues) {
    super(issues.join('; '));
    this.issues = issues;
    this.status = 400;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate and normalise untrusted settings input. Missing fields fall back to
 * defaults; present-but-invalid fields are reported (never silently replaced).
 * @param {unknown} input
 * @param {{requireLocation?: boolean}} [opts]
 */
export function normalizeSettings(input, opts = {}) {
  const issues = [];
  const d = defaultSettings();
  const src = isObj(input) ? input : {};
  if (!isObj(input)) issues.push('settings must be an object');

  const num = (path, v, def, min, max, { int = true } = {}) => {
    if (v === undefined || v === null || v === '') return def;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) { issues.push(`${path} must be a number`); return def; }
    if (int && !Number.isInteger(n)) { issues.push(`${path} must be a whole number`); return def; }
    if (n < min || n > max) { issues.push(`${path} must be between ${min} and ${max}`); return def; }
    return n;
  };
  const bool = (path, v, def) => {
    if (v === undefined || v === null) return def;
    if (typeof v !== 'boolean') { issues.push(`${path} must be true or false`); return def; }
    return v;
  };
  const oneOf = (path, v, def, allowed) => {
    if (v === undefined || v === null || v === '') return def;
    if (!allowed.includes(v)) { issues.push(`${path} must be one of: ${allowed.join(', ')}`); return def; }
    return v;
  };
  const time = (path, v, def) => {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v !== 'string' || !TIME_RE.test(v)) { issues.push(`${path} must be a time like 09:00`); return def; }
    return v;
  };
  const text = (path, v, def, max) => {
    if (v === undefined || v === null) return def;
    if (typeof v !== 'string') { issues.push(`${path} must be text`); return def; }
    // Strip control characters (they would corrupt the .ics output).
    const clean = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (clean.length > max) { issues.push(`${path} must be at most ${max} characters`); return def; }
    return clean;
  };

  const location = (path, v, required) => {
    if (v === undefined || v === null) {
      if (required) issues.push(`${path} is required`);
      return null;
    }
    if (!isObj(v)) { issues.push(`${path} must be an object`); return null; }
    const lat = num(`${path}.lat`, v.lat, NaN, -90, 90, { int: false });
    const lon = num(`${path}.lon`, v.lon, NaN, -180, 180, { int: false });
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      if (v.lat === undefined || v.lon === undefined) issues.push(`${path} needs lat and lon`);
      return null;
    }
    const tz = typeof v.timezone === 'string' ? v.timezone : '';
    if (!tz || !IANAZone.isValidZone(tz)) { issues.push(`${path}.timezone must be a valid IANA timezone (e.g. Europe/Berlin)`); return null; }
    return {
      name: text(`${path}.name`, v.name, `${lat.toFixed(4)}, ${lon.toFixed(4)}`, 120) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      admin: text(`${path}.admin`, v.admin, '', 120),
      country: text(`${path}.country`, v.country, '', 80),
      cc: text(`${path}.cc`, v.cc, '', 2).toUpperCase(),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      timezone: tz,
    };
  };

  const out = defaultSettings();
  out.location = location('location', src.location, !!opts.requireLocation);
  out.method = oneOf('method', src.method, d.method, METHOD_IDS);

  const ca = isObj(src.customAngles) ? src.customAngles : {};
  out.customAngles = {
    fajrAngle: num('customAngles.fajrAngle', ca.fajrAngle, d.customAngles.fajrAngle, 5, 25, { int: false }),
    ishaAngle: num('customAngles.ishaAngle', ca.ishaAngle, d.customAngles.ishaAngle, 0, 25, { int: false }),
    ishaInterval: num('customAngles.ishaInterval', ca.ishaInterval, d.customAngles.ishaInterval, 0, 180),
  };
  if (out.method === 'Custom' && out.customAngles.ishaAngle === 0 && out.customAngles.ishaInterval === 0) {
    issues.push('customAngles needs an Isha angle or an Isha interval');
  }

  out.madhab = oneOf('madhab', src.madhab, d.madhab, ['shafi', 'hanafi']);
  out.highLatitudeRule = oneOf('highLatitudeRule', src.highLatitudeRule, d.highLatitudeRule, ['auto', 'middleofthenight', 'seventhofthenight', 'twilightangle']);

  const adj = isObj(src.adjustments) ? src.adjustments : {};
  for (const p of PRAYERS) out.adjustments[p] = num(`adjustments.${p}`, adj[p], 0, -60, 60);

  const pr = isObj(src.prayers) ? src.prayers : {};
  for (const p of PRAYERS) {
    const v = isObj(pr[p]) ? pr[p] : {};
    out.prayers[p] = {
      enabled: bool(`prayers.${p}.enabled`, v.enabled, d.prayers[p].enabled),
      offset: num(`prayers.${p}.offset`, v.offset, d.prayers[p].offset, -60, 120),
      duration: num(`prayers.${p}.duration`, v.duration, d.prayers[p].duration, 5, 180),
    };
  }

  const w = isObj(src.work) ? src.work : {};
  out.work.filter = bool('work.filter', w.filter, d.work.filter);
  out.work.start = time('work.start', w.start, d.work.start);
  out.work.end = time('work.end', w.end, d.work.end);
  if (out.work.start === out.work.end) issues.push('work.start and work.end must differ');
  if (w.days !== undefined) {
    if (!Array.isArray(w.days) || w.days.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) {
      issues.push('work.days must be a list of weekday numbers 1 (Mon) … 7 (Sun)');
    } else {
      out.work.days = [...new Set(w.days)].sort((a, b) => a - b);
    }
  }
  out.work.fit = oneOf('work.fit', w.fit, d.work.fit, ['within', 'start', 'overlap']);
  out.work.offDays = oneOf('work.offDays', w.offDays, d.work.offDays, ['skip', 'all']);

  const j = isObj(src.jumuah) ? src.jumuah : {};
  out.jumuah = {
    mode: oneOf('jumuah.mode', j.mode, d.jumuah.mode, ['off', 'fixed', 'relative', 'seasonal']),
    fixedTime: time('jumuah.fixedTime', j.fixedTime, d.jumuah.fixedTime),
    relativeOffset: num('jumuah.relativeOffset', j.relativeOffset, d.jumuah.relativeOffset, -60, 180),
    summerTime: time('jumuah.summerTime', j.summerTime, d.jumuah.summerTime),
    winterTime: time('jumuah.winterTime', j.winterTime, d.jumuah.winterTime),
    duration: num('jumuah.duration', j.duration, d.jumuah.duration, 10, 240),
  };

  const e = isObj(src.event) ? src.event : {};
  out.event = {
    title: text('event.title', e.title, d.event.title, 80) || d.event.title,
    titleMode: oneOf('event.titleMode', e.titleMode, d.event.titleMode, ['custom', 'prayer', 'both']),
    description: oneOf('event.description', e.description, d.event.description, ['none', 'generic', 'detailed']),
    busy: bool('event.busy', e.busy, d.event.busy),
    private: bool('event.private', e.private, d.event.private),
    alarmMinutes: num('event.alarmMinutes', e.alarmMinutes, d.event.alarmMinutes, 0, 120),
  };

  const f = isObj(src.feed) ? src.feed : {};
  out.feed = {
    name: text('feed.name', f.name, d.feed.name, 60) || d.feed.name,
    daysAhead: num('feed.daysAhead', f.daysAhead, d.feed.daysAhead, 7, 400),
    daysBack: num('feed.daysBack', f.daysBack, d.feed.daysBack, 0, 60),
    timeFormat: oneOf('feed.timeFormat', f.timeFormat, d.feed.timeFormat, ['utc', 'tzid']),
  };

  out.trips = [];
  if (src.trips !== undefined) {
    if (!Array.isArray(src.trips)) issues.push('trips must be a list');
    else if (src.trips.length > MAX_TRIPS) issues.push(`at most ${MAX_TRIPS} trips`);
    else {
      src.trips.forEach((t, i) => {
        const path = `trips[${i}]`;
        if (!isObj(t)) { issues.push(`${path} must be an object`); return; }
        const from = typeof t.from === 'string' && DATE_RE.test(t.from) && DateTime.fromISO(t.from).isValid ? t.from : null;
        const to = typeof t.to === 'string' && DATE_RE.test(t.to) && DateTime.fromISO(t.to).isValid ? t.to : null;
        if (!from || !to) { issues.push(`${path} needs from/to dates like 2026-12-03`); return; }
        if (to < from) { issues.push(`${path}.to must be on or after from`); return; }
        const loc = location(`${path}.location`, t.location, true);
        if (!loc) return;
        out.trips.push({
          id: text(`${path}.id`, t.id, '', 40) || `trip-${i + 1}`,
          label: text(`${path}.label`, t.label, '', 60),
          from, to, location: loc,
        });
      });
      out.trips.sort((a, b) => a.from.localeCompare(b.from));
    }
  }

  if (issues.length) throw new SettingsError(issues);
  return out;
}
