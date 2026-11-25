// End-to-end HTTP tests: a real server on a random port with an in-memory DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ICAL from 'ical.js';
import { openDb } from '../src/db.js';
import { loadCities } from '../src/geo.js';
import { createApp, detectClient } from '../src/app.js';
import { munichExample } from '../src/settings.js';
import { PLACES } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base;

before(async () => {
  loadCities(path.join(root, 'data', 'cities.json'));
  const db = openDb(':memory:');
  const config = { port: 0, publicBaseUrl: '', trustProxy: false, publicDir: path.join(root, 'public'), uidDomain: 'waqt.test', log: false };
  server = createServer(createApp({ db, config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, p, { body, key, headers = {} } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
};

const feedPath = (u) => new URL(u.feedUrl).pathname;

test('full lifecycle: create, subscribe, travel, edit, rotate, delete', async () => {
  // Create
  const created = await call('POST', '/api/feeds', { body: { settings: munichExample() } });
  assert.equal(created.res.status, 201);
  const { urls } = created.data;
  assert.match(urls.feedUrl, /\/cal\/f_[\w-]{22}\.ics$/);
  assert.match(urls.webcalUrl, /^webcal:\/\//);
  assert.match(urls.google, /^https:\/\/calendar\.google\.com\/calendar\/render\?cid=webcal%3A%2F%2F/);
  assert.match(urls.outlookWork, /^https:\/\/outlook\.office\.com\/calendar\/0\/addfromweb\?url=/);
  const key = urls.manageUrl.split('#k=')[1];
  assert.match(key, /^k_[\w-]{32}$/);
  assert.equal(created.data.publicReachable, false);

  // Subscribe (as Outlook would)
  const ics = await call('GET', feedPath(urls), { headers: { 'User-Agent': 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)' } });
  assert.equal(ics.res.status, 200);
  assert.equal(ics.res.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const etag = ics.res.headers.get('etag');
  assert.ok(etag);
  const comp = new ICAL.Component(ICAL.parse(ics.data));
  assert.ok(comp.getAllSubcomponents('vevent').length > 150, 'about 98 days of blocks');
  const notModified = await call('GET', feedPath(urls), { headers: { 'If-None-Match': etag, 'User-Agent': 'Microsoft Exchange/15.20 (Windows NT 10.0)' } });
  assert.equal(notModified.res.status, 304);

  // Sync status is visible from the manage API
  const info = await call('GET', '/api/feed', { key });
  assert.equal(info.res.status, 200);
  assert.equal(info.data.sync.lastClient, 'Microsoft Outlook');
  assert.equal(info.data.sync.fetchCount, 2);
  assert.equal(info.data.urls.feedUrl, urls.feedUrl);

  // Travel quick-switch: same URL, different timezone in the feed
  const trip = await call('POST', '/api/feed/travel', { key, body: { mode: 'trip', location: PLACES.newYork, from: '2026-12-01', to: '2026-12-03' } });
  assert.equal(trip.res.status, 200);
  assert.equal(trip.data.urls.feedUrl, urls.feedUrl, 'subscription URL never changes');
  assert.equal(trip.data.settings.trips.length, 1);
  const home = await call('POST', '/api/feed/travel', { key, body: { mode: 'home', location: PLACES.london } });
  assert.equal(home.data.settings.location.timezone, 'Europe/London');
  const after = await call('GET', feedPath(urls));
  assert.notEqual(after.res.headers.get('etag'), etag, 'feed content changed');
  assert.match(after.data, /X-WR-TIMEZONE:Europe\/London/);

  // Edit with optimistic concurrency
  const current = (await call('GET', '/api/feed', { key })).data;
  const stale = await call('PUT', '/api/feed', { key, body: { settings: current.settings, revision: current.revision - 1 } });
  assert.equal(stale.res.status, 409);
  const next = { ...current.settings, event: { ...current.settings.event, title: 'Personal block' } };
  const saved = await call('PUT', '/api/feed', { key, body: { settings: next, revision: current.revision } });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.revision, current.revision + 1);
  assert.match((await call('GET', feedPath(urls))).data, /SUMMARY:Personal block/);

  // Invalid edit is rejected with readable issues
  const bad = await call('PUT', '/api/feed', { key, body: { settings: { ...next, work: { start: '25:00' } } } });
  assert.equal(bad.res.status, 400);
  assert.ok(bad.data.issues.some((i) => i.includes('work.start')));

  // Rotate the feed address: old URL dies, manage key keeps working
  const rotated = await call('POST', '/api/feed/rotate', { key });
  assert.notEqual(rotated.data.urls.feedUrl, urls.feedUrl);
  assert.equal((await call('GET', feedPath(urls))).res.status, 404);
  assert.equal((await call('GET', feedPath(rotated.data.urls))).res.status, 200);

  // Delete
  assert.equal((await call('DELETE', '/api/feed', { key })).res.status, 200);
  assert.equal((await call('GET', feedPath(rotated.data.urls))).res.status, 404);
  assert.equal((await call('GET', '/api/feed', { key })).res.status, 404);
});

test('manage endpoints require a valid key', async () => {
  assert.equal((await call('GET', '/api/feed')).res.status, 401);
  assert.equal((await call('GET', '/api/feed', { key: 'k_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).res.status, 404);
  assert.equal((await call('GET', '/cal/f_doesnotexist0000000000.ics')).res.status, 404);
});

test('creating a feed validates settings', async () => {
  const r = await call('POST', '/api/feeds', { body: { settings: { method: 'MWL' } } });
  assert.equal(r.res.status, 400);
  assert.match(r.data.issues.join(), /location is required/);
  const notJson = await fetch(`${base}/api/feeds`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
});

test('preview and year endpoints', async () => {
  const p = await call('POST', '/api/preview', { body: { settings: munichExample(), from: '2026-10-19', days: 14 } });
  assert.equal(p.res.status, 200);
  assert.equal(p.data.days.length, 14);
  assert.equal(p.data.days.find((d) => d.date === '2026-10-25').transition.toAbbr, 'CET');
  const y = await call('POST', '/api/year', { body: { settings: munichExample(), year: 2026 } });
  assert.equal(y.data.days.length, 365);
  assert.equal(y.data.days.filter((d, i, a) => i && d.offset !== a[i - 1].offset).length, 2);
});

test('stateless feed link (no storage)', async () => {
  const r = await call('POST', '/api/stateless', { body: { settings: munichExample() } });
  assert.equal(r.res.status, 200);
  const ics = await call('GET', new URL(r.data.feedUrl).pathname);
  assert.equal(ics.res.status, 200);
  assert.match(ics.data, /BEGIN:VCALENDAR/);
  assert.equal((await call('GET', '/s/bm90LWpzb24tYXQtYWxs.ics')).res.status, 400);
});

test('offline geocoding', async () => {
  const r = await call('GET', `/api/geo/search?q=${encodeURIComponent('münchen')}`);
  assert.equal(r.data.results[0].name, 'Munich');
  assert.equal(r.data.results[0].timezone, 'Europe/Berlin');
  const ar = await call('GET', `/api/geo/search?q=${encodeURIComponent('ميونخ')}`);
  assert.equal(ar.data.results[0].name, 'Munich');
  const ca = await call('GET', `/api/geo/search?q=${encodeURIComponent('London, Canada')}`);
  assert.equal(ca.data.results[0].timezone, 'America/Toronto');
  const coords = await call('GET', '/api/geo/search?q=40.7128,-74.006');
  assert.equal(coords.data.results[0].timezone, 'America/New_York');
  const rev = await call('GET', '/api/geo/reverse?lat=48.5665&lon=13.4312');
  assert.equal(rev.data.location.name, 'Passau');
  assert.equal((await call('GET', '/api/geo/reverse?lat=99&lon=0')).res.status, 400);
});

test('pages, static files and security headers', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /Prayer blocks that follow the sun/);
  assert.equal((await fetch(`${base}/manage`)).status, 200);
  assert.equal((await fetch(`${base}/travel`)).status, 200);
  assert.equal((await fetch(`${base}/css/app.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A.css`)).status, 404, 'malformed escapes are a 404, not a crash');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('calendar client detection', () => {
  assert.equal(detectClient('Google-Calendar-Importer'), 'Google Calendar');
  assert.equal(detectClient('Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17328; Pro)'), 'Microsoft Outlook');
  assert.equal(detectClient('Mac OS X/14.4 (23E214) CalendarAgent/1000'), 'Apple Calendar');
  assert.equal(detectClient('iOS/17.4 (21E219) dataaccessd/1.0'), 'Apple Calendar');
});
