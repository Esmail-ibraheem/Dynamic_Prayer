// Cross-checks against two independent sources:
//
// 1. The public AlAdhan API (PrayTimes algorithm), captured in
//    test/fixtures/aladhan.json by scripts/fetch-reference.mjs.
//    Dhuhr and Maghrib agree within 2 min. AlAdhan's Asr drifts up to ~3 min
//    around the equinoxes (its declination approximation), so Asr gets 3 min.
//    Fajr and Isha are compared only below 45° latitude: above that the two
//    libraries apply different high-latitude rules by design.
// 2. A direct solar-position solve (NOAA / Meeus equations, written here from
//    scratch) for Asr, which pins down who is right when the two differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { computeDay } from '../src/engine.js';
import { settings, minutes, hhmm } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/aladhan.json', import.meta.url), 'utf8'));
const TOLERANCE = { fajr: 2, dhuhr: 2, asr: 3, maghrib: 2, isha: 2 };

const allPrayers = (c) => settings({
  location: { name: c.city, lat: c.lat, lon: c.lon, timezone: c.timezone },
  method: c.method,
  madhab: c.madhab,
  work: { filter: false },
  prayers: Object.fromEntries(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((p) => [p, { enabled: true, offset: 0, duration: 15 }])),
  jumuah: { mode: 'off' },
});

for (const c of fixture.cases) {
  test(`AlAdhan: ${c.city} ${c.date}`, () => {
    const day = computeDay(allPrayers(c), c.date);
    const keys = Math.abs(c.lat) < 45 ? ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] : ['dhuhr', 'asr', 'maghrib'];
    for (const k of keys) {
      const diff = Math.abs(minutes(hhmm(day.times[k])) - minutes(c.timings[k]));
      assert.ok(diff <= TOLERANCE[k], `${k}: ours ${hhmm(day.times[k])} vs AlAdhan ${c.timings[k]}`);
    }
  });
}

// ---- independent solar-position solve (NOAA spreadsheet equations) --------
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function solar(ms) {
  const T = (ms / 86_400_000 + 2440587.5 - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  return { decl, eot };
}

function altitude(ms, lat, lon) {
  const { decl, eot } = solar(ms);
  const d = new Date(ms);
  const tst = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + eot + 4 * lon;
  const ha = tst / 4 - 180;
  return { alt: deg(Math.asin(Math.sin(rad(lat)) * Math.sin(rad(decl)) + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha)))), decl };
}

/** Asr (UTC ms): afternoon instant when the shadow is (factor + noon shadow) times the object. */
function solveAsr(isoDate, lat, lon, factor) {
  const midnight = Date.parse(`${isoDate}T00:00:00Z`);
  let noon = midnight;
  let best = -90;
  for (let m = 0; m < 1440; m++) {
    const a = altitude(midnight + m * 60_000, lat, lon).alt;
    if (a > best) { best = a; noon = midnight + m * 60_000; }
  }
  let lo = noon;
  let hi = noon + 8 * 3_600_000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const { alt, decl } = altitude(mid, lat, lon);
    const target = deg(Math.atan(1 / (factor + Math.tan(Math.abs(rad(lat) - rad(decl))))));
    if (alt > target) lo = mid; else hi = mid;
  }
  return lo;
}

for (const c of fixture.cases) {
  test(`Solar solve: Asr at ${c.city} ${c.date} within 2 min`, () => {
    const day = computeDay(allPrayers(c), c.date);
    const ours = DateTime.fromISO(day.times.asr).toMillis();
    const truth = solveAsr(c.date, c.lat, c.lon, c.madhab === 'hanafi' ? 2 : 1);
    assert.ok(Math.abs(ours - truth) <= 2 * 60_000, `ours ${day.times.asr} vs solve ${new Date(truth).toISOString()}`);
  });
}
