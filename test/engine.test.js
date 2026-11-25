import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { computeDay, computeRange, feedWindow, nextTransition } from '../src/engine.js';
import { munich, settings, PLACES, hhmm, minutes } from './helpers.js';

const block = (day, prayer) => day.blocks.find((b) => b.prayer === prayer);

describe('proposal scenario: Munich engineer, 09:00–18:00, MWL', () => {
  const s = munich();

  test('15 June (CEST): Dhuhr and Asr blocked, Maghrib omitted after work', () => {
    const d = computeDay(s, '2026-06-15');
    assert.equal(d.offset, '+02:00');
    assert.equal(d.abbr, 'CEST');
    const dhuhr = block(d, 'dhuhr');
    assert.equal(hhmm(dhuhr.start), '13:20', 'Dhuhr starts 5 min after a 13:15 adhan');
    assert.equal(hhmm(dhuhr.end), '13:40');
    assert.ok(dhuhr.included);
    assert.ok(block(d, 'asr').included);
    const maghrib = block(d, 'maghrib');
    assert.equal(hhmm(maghrib.adhan), '21:16');
    assert.equal(maghrib.included, false);
    assert.equal(maghrib.reason, 'outside-hours');
  });

  test('23 October (Friday, still CEST): Jumu\'ah uses the summer slot, Maghrib still omitted', () => {
    const d = computeDay(s, '2026-10-23');
    assert.equal(d.offset, '+02:00');
    assert.equal(block(d, 'dhuhr'), undefined, 'Dhuhr is replaced by Jumu\'ah on Fridays');
    const j = block(d, 'jumuah');
    assert.equal(hhmm(j.start), '13:15');
    assert.equal(hhmm(j.end), '14:15');
    assert.ok(j.included);
    const maghrib = block(d, 'maghrib');
    assert.ok(minutes(hhmm(maghrib.adhan)) >= minutes('18:00'), 'sunset is after the workday ends');
    assert.equal(maghrib.included, false);
  });

  test('26 October (first Monday of CET): everything shifts an hour and Maghrib joins the workday', () => {
    const d = computeDay(s, '2026-10-26');
    assert.equal(d.offset, '+01:00');
    assert.equal(d.abbr, 'CET');
    assert.equal(hhmm(block(d, 'dhuhr').adhan), '11:59');
    const maghrib = block(d, 'maghrib');
    assert.ok(maghrib.included, 'Maghrib is now inside 09:00–18:00');
    assert.equal(maghrib.start, maghrib.adhan, 'Maghrib starts at the adhan');
    assert.equal(maghrib.minutes, 15);
    assert.deepEqual(d.blocks.filter((b) => b.included).map((b) => b.prayer), ['dhuhr', 'asr', 'maghrib']);
  });

  test('30 October (Friday, CET): Jumu\'ah moves to the winter slot', () => {
    const j = block(computeDay(s, '2026-10-30'), 'jumuah');
    assert.equal(hhmm(j.start), '12:15');
    assert.equal(hhmm(j.end), '13:15');
    assert.match(j.rule, /winter/);
  });

  test('Fajr and Isha are switched off and never blocked', () => {
    for (const d of computeRange(s, '2026-01-01', 365)) {
      for (const p of ['fajr', 'isha']) {
        const b = block(d, p);
        assert.equal(b.included, false);
        assert.equal(b.reason, 'disabled');
      }
    }
  });
});

describe('DST correctness', () => {
  test('across the October change the wall clock jumps an hour but the sun does not', () => {
    const s = munich();
    const fri = computeDay(s, '2026-10-23');
    const mon = computeDay(s, '2026-10-26');
    const asrFri = DateTime.fromISO(block(fri, 'asr').adhan, { setZone: true });
    const asrMon = DateTime.fromISO(block(mon, 'asr').adhan, { setZone: true });
    // Local clock: about one hour earlier (plus a few minutes of seasonal drift).
    const localDelta = minutes(asrMon.toFormat('HH:mm')) - minutes(asrFri.toFormat('HH:mm'));
    assert.ok(localDelta <= -60 && localDelta >= -75, `local delta ${localDelta}`);
    // Solar (UTC) time: only the seasonal drift.
    const utcDelta = minutes(asrMon.toUTC().toFormat('HH:mm')) - minutes(asrFri.toUTC().toFormat('HH:mm'));
    assert.ok(Math.abs(utcDelta) <= 15, `utc delta ${utcDelta}`);
  });

  test('every block\'s UTC instant matches its local time and that day\'s offset', () => {
    for (const place of ['munich', 'london', 'newYork', 'sydney']) {
      const s = settings({ location: PLACES[place], work: { filter: false } });
      for (const d of computeRange(s, '2026-01-01', 365)) {
        for (const b of d.blocks) {
          const local = DateTime.fromISO(b.start, { setZone: true });
          assert.equal(local.toUTC().toISO({ suppressMilliseconds: true, suppressSeconds: true }), b.startUtc);
          assert.equal(local.setZone(d.zone).toFormat('HH:mm'), hhmm(b.start), `${place} ${d.date} ${b.prayer} printed in that day's zone`);
        }
      }
    }
  });

  test('transition days are detected with exact instants', () => {
    const s = munich();
    const back = computeDay(s, '2026-10-25').transition;
    assert.deepEqual({ at: back.at, from: back.fromOffset, to: back.toOffset, fromAbbr: back.fromAbbr, toAbbr: back.toAbbr }, { at: '2026-10-25T01:00Z', from: '+02:00', to: '+01:00', fromAbbr: 'CEST', toAbbr: 'CET' });
    const fwd = computeDay(s, '2026-03-29').transition;
    assert.equal(fwd.at, '2026-03-29T01:00Z');
    assert.equal(fwd.toDST, true);
    assert.equal(computeDay(s, '2026-10-26').transition, null);
  });

  test('nextTransition finds the next clock change', () => {
    const s = munich();
    const t = nextTransition(s, DateTime.fromISO('2026-11-25T10:00:00Z'));
    assert.equal(t.date, '2027-03-28');
    assert.equal(t.toDST, true);
  });

  test('New York and Sydney flip in their own months (incl. southern hemisphere)', () => {
    const ny = settings({ location: PLACES.newYork });
    assert.equal(computeDay(ny, '2026-03-07').offset, '-05:00');
    assert.equal(computeDay(ny, '2026-03-09').offset, '-04:00');
    assert.equal(computeDay(ny, '2026-11-02').offset, '-05:00');
    const syd = settings({ location: PLACES.sydney });
    assert.equal(computeDay(syd, '2026-04-04').offset, '+11:00');
    assert.equal(computeDay(syd, '2026-04-06').offset, '+10:00');
    assert.equal(computeDay(syd, '2026-10-05').offset, '+11:00');
  });
});

describe('workday filter', () => {
  test('weekends are skipped by default and included with offDays=all', () => {
    const sat = '2026-06-13';
    const skip = computeDay(munich(), sat);
    assert.ok(skip.blocks.every((b) => !b.included));
    assert.equal(block(skip, 'dhuhr').reason, 'day-off');
    const all = computeDay(munich({ work: { offDays: 'all' } }), sat);
    assert.deepEqual(all.blocks.filter((b) => b.included).map((b) => b.prayer), ['dhuhr', 'asr', 'maghrib']);
  });

  test('fit modes: within, start and overlap', () => {
    // 15 June: Asr block 17:35–17:55. Workday ends 17:45.
    const base = { work: { start: '09:00', end: '17:45' } };
    const asr = (fit) => block(computeDay(munich({ work: { ...base.work, fit } }), '2026-06-15'), 'asr');
    assert.equal(asr('within').included, false);
    assert.equal(asr('start').included, true);
    assert.equal(asr('overlap').included, true);
    // Workday starting 17:50: the block only overlaps.
    const late = (fit) => block(computeDay(munich({ work: { start: '17:50', end: '23:00', fit } }), '2026-06-15'), 'asr');
    assert.equal(late('start').included, false);
    assert.equal(late('overlap').included, true);
  });

  test('turning the filter off blocks every enabled prayer every day', () => {
    const s = munich({ work: { filter: false }, prayers: { ...munich().prayers, fajr: { enabled: true, offset: 0, duration: 15 } } });
    const sun = computeDay(s, '2026-06-14');
    assert.deepEqual(sun.blocks.filter((b) => b.included).map((b) => b.prayer), ['fajr', 'dhuhr', 'asr', 'maghrib']);
  });

  test('overnight shifts (22:00–06:00) cover Isha and the next morning\'s Fajr', () => {
    const s = settings({ location: PLACES.munich, work: { start: '22:00', end: '06:00', days: [1, 2, 3, 4, 5] } });
    // Tuesday 15 Dec: Fajr ~06:0x is after 06:00 in deep winter, so check a June day instead.
    const tue = computeDay(s, '2026-06-16');
    assert.ok(block(tue, 'fajr').included, 'Fajr on Tuesday falls in Monday night\'s shift');
    assert.ok(block(tue, 'isha').included, 'Isha on Tuesday falls in Tuesday night\'s shift');
    assert.equal(block(tue, 'dhuhr').included, false);
    // Monday morning: Sunday is not a workday, so no shift covers Fajr.
    const mon = computeDay(s, '2026-06-15');
    assert.equal(block(mon, 'fajr').included, false);
    assert.equal(tue.windows.length, 2);
  });
});

describe('Jumu\'ah modes', () => {
  const fri = '2026-06-19';
  test('relative: Dhuhr adhan plus an offset', () => {
    const d = computeDay(munich({ jumuah: { mode: 'relative', relativeOffset: 15, duration: 45 } }), fri);
    const j = block(d, 'jumuah');
    assert.equal(minutes(hhmm(j.start)) - minutes(hhmm(j.adhan)), 15);
    assert.equal(j.minutes, 45);
  });
  test('fixed: same local time all year', () => {
    const s = munich({ jumuah: { mode: 'fixed', fixedTime: '13:30', duration: 50 } });
    assert.equal(hhmm(block(computeDay(s, '2026-01-09'), 'jumuah').start), '13:30');
    assert.equal(hhmm(block(computeDay(s, '2026-07-10'), 'jumuah').start), '13:30');
  });
  test('off: Friday is a normal day with Dhuhr', () => {
    const d = computeDay(munich({ jumuah: { mode: 'off' } }), fri);
    assert.equal(block(d, 'jumuah'), undefined);
    assert.ok(block(d, 'dhuhr').included);
  });
  test('seasonal follows each hemisphere\'s DST, and no-DST zones use the winter slot', () => {
    const seasonal = { mode: 'seasonal', summerTime: '13:15', winterTime: '12:15', duration: 60 };
    const syd = settings({ location: PLACES.sydney, jumuah: seasonal, work: { start: '08:00', end: '18:00' } });
    assert.equal(hhmm(block(computeDay(syd, '2026-01-09'), 'jumuah').start), '13:15', 'January is summer time in Sydney');
    assert.equal(hhmm(block(computeDay(syd, '2026-07-10'), 'jumuah').start), '12:15');
    const mk = settings({ location: PLACES.makkah, method: 'UmmAlQura', jumuah: seasonal, work: { start: '08:00', end: '18:00' } });
    assert.equal(hhmm(block(computeDay(mk, '2026-07-10'), 'jumuah').start), '12:15');
  });
});

describe('trips and edge locations', () => {
  test('a trip switches coordinates and timezone for its days only', () => {
    const s = munich({ trips: [{ id: 't1', label: 'Client visit', from: '2026-11-30', to: '2026-12-02', location: PLACES.london }] });
    const days = computeRange(s, '2026-11-29', 5);
    assert.deepEqual(days.map((d) => d.zone), ['Europe/Berlin', 'Europe/London', 'Europe/London', 'Europe/London', 'Europe/Berlin']);
    assert.equal(days[1].trip.id, 't1');
    assert.equal(days[1].offset, '+00:00');
    assert.ok(days[1].blocks.filter((b) => b.included).length >= 2, 'work hours apply in local London time');
  });

  test('polar latitudes never produce invalid times', () => {
    const s = settings({ location: PLACES.tromso, work: { filter: false } });
    for (const d of computeRange(s, '2026-06-10', 20).concat(computeRange(s, '2026-12-10', 20))) {
      for (const b of d.blocks) {
        assert.ok(DateTime.fromISO(b.start).isValid, `${d.date} ${b.prayer}`);
        assert.ok(b.minutes > 0);
      }
    }
  });

  test('feed window spans daysBack … daysAhead around today in the home zone', () => {
    const s = munich({ feed: { daysAhead: 90, daysBack: 7 } });
    const w = feedWindow(s, DateTime.fromISO('2026-11-25T23:30:00Z')); // already 26 Nov in Berlin
    assert.equal(w.from, '2026-11-19');
    assert.equal(w.days, 98);
  });
});
