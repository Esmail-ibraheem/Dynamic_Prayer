// Fetches independent reference timings from the public AlAdhan API and stores
// them as a test fixture (test/fixtures/aladhan.json), so the test suite can
// cross-check our engine offline. Only public city coordinates are sent.
//
//   node scripts/fetch-reference.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// AlAdhan method ids: 2 = ISNA, 3 = MWL, 4 = Umm al-Qura.
const CASES = [
  { city: 'Munich', lat: 48.1351, lon: 11.582, tz: 'Europe/Berlin', method: 3, ours: 'MWL', school: 0, dates: ['2026-06-15', '2026-10-23', '2026-10-24', '2026-10-26', '2026-03-27', '2026-03-30', '2026-12-21'] },
  { city: 'Munich (Hanafi)', lat: 48.1351, lon: 11.582, tz: 'Europe/Berlin', method: 3, ours: 'MWL', school: 1, dates: ['2026-06-15', '2026-12-21'] },
  { city: 'London', lat: 51.5074, lon: -0.1278, tz: 'Europe/London', method: 3, ours: 'MWL', school: 0, dates: ['2026-03-27', '2026-03-30', '2026-07-01'] },
  { city: 'New York', lat: 40.7128, lon: -74.006, tz: 'America/New_York', method: 2, ours: 'ISNA', school: 0, dates: ['2026-03-06', '2026-03-09', '2026-10-30', '2026-11-02'] },
  { city: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', method: 3, ours: 'MWL', school: 0, dates: ['2026-04-03', '2026-04-06', '2026-10-02', '2026-10-05'] },
  { city: 'Makkah', lat: 21.4225, lon: 39.8262, tz: 'Asia/Riyadh', method: 4, ours: 'UmmAlQura', school: 0, dates: ['2026-06-15', '2026-12-15'] },
];

const out = { source: 'https://api.aladhan.com/v1/timings', fetched: new Date().toISOString().slice(0, 10), cases: [] };
for (const c of CASES) {
  for (const date of c.dates) {
    const [y, m, d] = date.split('-');
    const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${c.lat}&longitude=${c.lon}&method=${c.method}&school=${c.school}&timezonestring=${encodeURIComponent(c.tz)}`;
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))); // stay well inside the free API's rate limit
      res = await fetch(url);
      if (res.status !== 429) break;
    }
    if (!res.ok) throw new Error(`${c.city} ${date}: HTTP ${res.status}`);
    const json = await res.json();
    const t = json.data.timings;
    const clean = (s) => s.slice(0, 5);
    out.cases.push({
      city: c.city, lat: c.lat, lon: c.lon, timezone: c.tz, method: c.ours, madhab: c.school ? 'hanafi' : 'shafi', date,
      timings: { fajr: clean(t.Fajr), sunrise: clean(t.Sunrise), dhuhr: clean(t.Dhuhr), asr: clean(t.Asr), maghrib: clean(t.Maghrib), isha: clean(t.Isha) },
    });
    process.stdout.write('.');
  }
}
await mkdir(path.join(root, 'test', 'fixtures'), { recursive: true });
await writeFile(path.join(root, 'test', 'fixtures', 'aladhan.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote ${out.cases.length} reference days.`);
