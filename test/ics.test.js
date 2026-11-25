import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { computeRange } from '../src/engine.js';
import { buildCalendar, foldLine, escapeText } from '../src/ics.js';
import { vtimezoneLines } from '../src/vtimezone.js';
import { munich, settings, PLACES } from './helpers.js';

const unfold = (text) => text.replace(/\r\n[ \t]/g, '');

function feed(s, from = '2026-10-19', days = 14) {
  return buildCalendar({ settings: s, days: computeRange(s, from, days), feedId: 'test01', revision: 4, updatedAt: '2026-10-01T08:00:00Z' });
}

function parse(text) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const vtz of comp.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(vtz);
  return comp;
}

describe('RFC 5545 formatting', () => {
  test('lines end in CRLF, are at most 75 octets and unfold losslessly (incl. UTF-8)', () => {
    const s = munich({ event: { title: 'صلاة · Prayer block for the whole team, please do not book over it', titleMode: 'both', description: 'detailed' } });
    const text = feed(s);
    assert.ok(text.endsWith('\r\n'));
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `too long: ${line}`);
    assert.ok(unfold(text).includes('SUMMARY:صلاة · Prayer block for the whole team\\, please do not book over it · Dhuhr'));
  });

  test('foldLine never splits a multi-byte character', () => {
    const line = `SUMMARY:${'ميونخ'.repeat(30)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      assert.ok(Buffer.byteLength(part) <= 75);
      assert.ok(!part.includes('�'));
    }
    assert.equal(folded.replace(/\r\n /g, ''), line);
  });

  test('text escaping', () => {
    assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });

  test('calendar headers ask clients to refresh every 12 hours', () => {
    const text = unfold(feed(munich()));
    for (const l of ['VERSION:2.0', 'METHOD:PUBLISH', 'CALSCALE:GREGORIAN', 'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H', 'X-WR-TIMEZONE:Europe/Berlin', 'X-WR-CALNAME:Prayer blocks']) {
      assert.ok(text.includes(`\r\n${l}\r\n`), l);
    }
  });

  test('events are Busy (OPAQUE), confirmed, private, with stable unique UIDs', () => {
    const comp = parse(feed(munich()));
    const events = comp.getAllSubcomponents('vevent');
    assert.ok(events.length > 20);
    const uids = events.map((e) => e.getFirstPropertyValue('uid'));
    assert.equal(new Set(uids).size, uids.length);
    for (const e of events) {
      assert.equal(e.getFirstPropertyValue('transp'), 'OPAQUE');
      assert.equal(e.getFirstPropertyValue('status'), 'CONFIRMED');
      assert.equal(e.getFirstPropertyValue('class'), 'PRIVATE');
      assert.equal(e.getFirstPropertyValue('x-microsoft-cdo-busystatus'), 'BUSY');
      assert.equal(e.getFirstPropertyValue('sequence'), 4);
      assert.equal(e.getFirstPropertyValue('summary'), 'Focus / Personal Block');
    }
    assert.ok(uids.includes('test01-20261026-maghrib@waqt.blocks'));
    assert.ok(!uids.includes('test01-20261023-maghrib@waqt.blocks'), 'summer Maghrib is outside work hours');
    assert.ok(uids.includes('test01-20261023-jumuah@waqt.blocks'));
  });

  test('free/transparent, prayer-name titles and reminders', () => {
    const s = munich({ event: { busy: false, private: false, titleMode: 'prayer', alarmMinutes: 10, description: 'none' } });
    const comp = parse(feed(s));
    const ev = comp.getAllSubcomponents('vevent')[0];
    assert.equal(ev.getFirstPropertyValue('transp'), 'TRANSPARENT');
    assert.equal(ev.getFirstPropertyValue('class'), 'PUBLIC');
    assert.equal(ev.getFirstPropertyValue('summary'), 'Dhuhr');
    assert.equal(ev.getFirstPropertyValue('description'), null);
    const alarm = ev.getFirstSubcomponent('valarm');
    assert.equal(alarm.getFirstPropertyValue('trigger').toString(), '-PT10M');
  });
});

describe('timezones', () => {
  test('UTC mode: the 26 Oct Dhuhr block is emitted at 11:04Z (12:04 CET)', () => {
    const text = unfold(feed(munich()));
    assert.match(text, /UID:test01-20261026-dhuhr@waqt\.blocks\r\n(?:.*\r\n){3}DTSTART:20261026T110400Z\r\nDTEND:20261026T112400Z/);
    assert.match(text, /UID:test01-20261023-jumuah@waqt\.blocks\r\n(?:.*\r\n){3}DTSTART:20261023T111500Z/, '13:15 CEST = 11:15Z');
  });

  for (const [name, loc, from] of [
    ['Europe/Berlin across October', PLACES.munich, '2026-10-19'],
    ['Europe/Berlin across March', PLACES.munich, '2026-03-23'],
    ['America/New_York across November', PLACES.newYork, '2026-10-28'],
    ['Australia/Sydney across April', PLACES.sydney, '2026-04-01'],
    ['Asia/Jerusalem across March', PLACES.jerusalem, '2026-03-23'],
  ]) {
    test(`TZID + VTIMEZONE resolves to the same instants as UTC: ${name}`, () => {
      const base = { location: loc, work: { filter: false }, jumuah: { mode: 'off' } };
      const utc = parse(feed(settings({ ...base, feed: { timeFormat: 'utc' } }), from, 14));
      const tz = parse(feed(settings({ ...base, feed: { timeFormat: 'tzid' } }), from, 14));
      const want = new Map(utc.getAllSubcomponents('vevent').map((e) => [e.getFirstPropertyValue('uid'), e.getFirstPropertyValue('dtstart').toJSDate().getTime()]));
      const events = tz.getAllSubcomponents('vevent');
      assert.equal(events.length, want.size);
      for (const e of events) {
        const ev = new ICAL.Event(e);
        assert.equal(ev.startDate.zone.tzid, loc.timezone);
        assert.equal(ev.startDate.toJSDate().getTime(), want.get(ev.uid), ev.uid);
      }
    });
  }

  test('a trip to another zone adds its own VTIMEZONE', () => {
    const s = munich({ feed: { timeFormat: 'tzid' }, trips: [{ id: 'ny', from: '2026-10-21', to: '2026-10-22', location: PLACES.newYork }] });
    const text = unfold(feed(s));
    assert.ok(text.includes('TZID:Europe/Berlin'));
    assert.ok(text.includes('TZID:America/New_York'));
    assert.match(text, /DTSTART;TZID=America\/New_York:20261021T/);
  });

  test('VTIMEZONE rules match the real-world DST rules', () => {
    const at = (zone) => vtimezoneLines(zone, Date.parse('2026-11-01'), Date.parse('2027-02-01')).join('\n');
    const berlin = at('Europe/Berlin');
    assert.match(berlin, /TZOFFSETFROM:\+0100\nTZOFFSETTO:\+0200\nTZNAME:CEST\nDTSTART:19700329T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);
    assert.match(berlin, /TZOFFSETFROM:\+0200\nTZOFFSETTO:\+0100\nTZNAME:CET\nDTSTART:19701025T030000\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/);
    const ny = at('America/New_York');
    assert.match(ny, /BYMONTH=3;BYDAY=2SU/);
    assert.match(ny, /BYMONTH=11;BYDAY=1SU/);
    const riyadh = at('Asia/Riyadh');
    assert.equal((riyadh.match(/BEGIN:STANDARD/g) || []).length, 1);
    assert.ok(!riyadh.includes('DAYLIGHT'));
    assert.match(riyadh, /TZOFFSETTO:\+0300/);
  });
});
