import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, SettingsError, defaultSettings, munichExample } from '../src/settings.js';

const issues = (input, opts) => {
  try {
    normalizeSettings(input, opts);
  } catch (e) {
    assert.ok(e instanceof SettingsError);
    return e.issues;
  }
  return [];
};

test('defaults and the proposal example are valid', () => {
  assert.deepEqual(issues(defaultSettings()), []);
  assert.deepEqual(issues(munichExample(), { requireLocation: true }), []);
});

test('missing fields fall back to defaults', () => {
  const s = normalizeSettings({ location: munichExample().location }, { requireLocation: true });
  assert.equal(s.method, 'MWL');
  assert.equal(s.prayers.dhuhr.duration, 20);
  assert.deepEqual(s.work.days, [1, 2, 3, 4, 5]);
});

test('location is required when creating a feed', () => {
  assert.match(issues({}, { requireLocation: true }).join(), /location is required/);
});

test('invalid values are reported, not silently replaced', () => {
  const bad = {
    location: { lat: 48, lon: 11, timezone: 'Mars/Olympus' },
    method: 'Nope',
    work: { start: '9am', days: [0, 8] },
    prayers: { dhuhr: { duration: 9999 } },
    jumuah: { mode: 'sometimes' },
    feed: { daysAhead: 5000 },
    trips: [{ from: '2026-12-05', to: '2026-12-01', location: munichExample().location }],
  };
  const list = issues(bad, { requireLocation: true }).join('\n');
  for (const frag of ['timezone', 'method', 'work.start', 'work.days', 'prayers.dhuhr.duration', 'jumuah.mode', 'feed.daysAhead', 'trips[0].to']) {
    assert.ok(list.includes(frag), `expected an issue about ${frag}`);
  }
});

test('control characters are stripped from text fields', () => {
  const s = normalizeSettings({ ...munichExample(), event: { ...munichExample().event, title: 'Prayer\r\nBEGIN:VEVENT' } }, { requireLocation: true });
  assert.equal(s.event.title, 'Prayer  BEGIN:VEVENT');
  assert.ok(!/[\r\n]/.test(s.event.title));
});

test('workday days are de-duplicated and sorted', () => {
  const s = normalizeSettings({ ...munichExample(), work: { ...munichExample().work, days: [5, 1, 1, 3] } }, { requireLocation: true });
  assert.deepEqual(s.work.days, [1, 3, 5]);
});
