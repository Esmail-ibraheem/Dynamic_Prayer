// Visualisations. A "band" is one local day drawn as its real sky: the colour
// stops come from that day's Fajr, sunrise, Maghrib and Isha, so the
// gradient itself is data. Prayer blocks sit on it as tiles; the workday is
// the bracket underneath.
import { h, s } from './dom.js';

export const ARABIC = { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء', jumuah: 'الجمعة' };
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const REASONS = {
  'outside-hours': 'outside working hours',
  'day-off': 'not a workday',
  disabled: 'turned off',
};

/** "HH:MM" from an ISO string with offset (local wall time). */
export const hm = (iso) => (iso ? iso.slice(11, 16) : '–');

const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

/** Hours since local midnight of `date` (may be <0 or >24 for neighbouring days). */
export function hourOn(iso, date) {
  return (dayNum(iso.slice(0, 10)) - dayNum(date)) * 24 + Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
}

const pct = (hours) => `${(Math.max(0, Math.min(24, hours)) / 24) * 100}%`;

export function dateLabel(iso, { long = false } = {}) {
  const d = new Date(`${iso}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  return long
    ? `${WEEKDAY_LONG[wd]} ${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]}`
    : `${WEEKDAY[wd]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

export function skyGradient(day) {
  const t = day.times;
  if (!t.sunrise || !t.maghrib) return 'var(--sky-day)';
  const f = t.fajr ? hourOn(t.fajr, day.date) : hourOn(t.sunrise, day.date) - 1.5;
  const sr = hourOn(t.sunrise, day.date);
  const ss = hourOn(t.maghrib, day.date);
  const is = t.isha ? hourOn(t.isha, day.date) : ss + 1.5;
  const stops = [
    ['--sky-night', 0], ['--sky-night', f], ['--sky-twilight', (f + sr) / 2], ['--sky-dawn', sr],
    ['--sky-day', sr + 0.9], ['--sky-day', ss - 0.9], ['--sky-dusk', ss], ['--sky-twilight', (ss + is) / 2],
    ['--sky-night', is], ['--sky-night', 24],
  ];
  let last = 0;
  const parts = stops.map(([c, hr]) => {
    const p = Math.max(last, Math.min(24, hr));
    last = p;
    return `var(${c}) ${((p / 24) * 100).toFixed(2)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export function describeDay(day) {
  const on = day.blocks.filter((b) => b.included).map((b) => `${b.label} ${hm(b.start)} to ${hm(b.end)}`);
  return `${dateLabel(day.date, { long: true })}, ${day.abbr}. ${on.length ? `Blocked: ${on.join(', ')}.` : 'Nothing blocked.'}`;
}

/**
 * One day as a sky band.
 * @param {any} day  engine day
 * @param {{labels?: boolean, size?: 'sm'|'md'|'lg', minLabelGap?: number}} [opts]  minLabelGap: hours between labels before staggering
 */
export function band(day, { labels = false, size = 'md', minLabelGap = 2.2 } = {}) {
  let lastLabel = -Infinity;
  let lastRaised = false;
  const el = h('span', { class: `band band-${size}`, role: 'img', 'aria-label': describeDay(day) });
  el.style.background = skyGradient(day);
  for (const key of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    if (day.times[key]) el.append(h('span', { class: 'adhan', style: { left: pct(hourOn(day.times[key], day.date)) } }));
  }
  for (const w of day.windows) {
    const a = hourOn(w.start, day.date);
    const b = hourOn(w.end, day.date);
    el.append(h('span', { class: `work${a < 0 ? ' work-cont' : ''}${b > 24 ? ' work-more' : ''}`, style: { left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` } }));
  }
  for (const b of day.blocks) {
    if (b.reason === 'disabled') continue;
    const a = hourOn(b.start, day.date);
    const z = hourOn(b.end, day.date);
    const title = `${b.label} ${hm(b.start)}–${hm(b.end)} ${day.abbr}${b.included ? '' : `, not blocked (${REASONS[b.reason] || b.reason})`}`;
    const tile = h('span', { class: `tile ${b.included ? 'on' : 'off'} tile-${b.prayer}`, style: { left: pct(a), width: `calc(${pct(z)} - ${pct(a)})` }, title });
    if (labels && b.included) {
      // Stagger a label upwards when it would collide with the previous one.
      const raise = a - lastLabel < minLabelGap && !lastRaised;
      tile.append(h('span', { class: `tile-label${raise ? ' up' : ''}` }, hm(b.start)));
      lastLabel = a;
      lastRaised = raise;
    }
    el.append(tile);
  }
  return el;
}

/** Hour ruler drawn under a stack of bands. */
export function hourAxis() {
  const el = h('div', { class: 'hour-axis', 'aria-hidden': 'true' });
  for (const hr of [0, 3, 6, 9, 12, 15, 18, 21, 24]) {
    el.append(h('span', { style: { left: pct(hr) } }, String(hr).padStart(2, '0')));
  }
  return el;
}

/** Short sentence for a DST change (e.g. clocks go back one hour). */
export function transitionText(tr) {
  const toMin = (o) => (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6)));
  const diff = toMin(tr.toOffset) - toMin(tr.fromOffset);
  const amount = Math.abs(diff) === 60 ? 'one hour' : `${Math.abs(diff)} minutes`;
  return `Clocks go ${diff < 0 ? 'back' : 'forward'} ${amount} (${tr.fromAbbr} to ${tr.toAbbr})`;
}

// ---------------------------------------------------------------- year chart

const CURVES = [
  { key: 'dhuhr', label: 'Dhuhr', cls: 'c-dhuhr' },
  { key: 'asr', label: 'Asr', cls: 'c-asr' },
  { key: 'maghrib', label: 'Maghrib', cls: 'c-maghrib' },
];

/**
 * A year of adhan times in local clock time, with the workday as a band.
 * @param {any} data  /api/year response
 * @param {{work?: {start:string,end:string}|null, recurring?: string|null, readout?: HTMLElement}} opts
 */
export function yearChart(data, { work = null, recurring = null, readout = null } = {}) {
  const W = 760;
  const H = 380;
  const m = { l: 48, r: 70, t: 22, b: 30 };
  const days = data.days;
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const vals = days.flatMap((d) => CURVES.map((c) => d.t[c.key]).filter((v) => v !== null));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (work) { lo = Math.min(lo, toMin(work.start)); hi = Math.max(hi, toMin(work.end)); }
  lo = Math.floor((lo - 30) / 60) * 60;
  hi = Math.ceil((hi + 30) / 60) * 60;
  const x = (i) => m.l + (i / (days.length - 1)) * (W - m.l - m.r);
  const y = (min) => m.t + ((min - lo) / (hi - lo)) * (H - m.t - m.b);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'year-chart', role: 'img', 'aria-label': `Prayer times through ${data.year} in local clock time for ${data.zone}` });

  for (let hr = lo; hr <= hi; hr += 60) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(hr), y2: y(hr), class: 'grid' }));
    svg.append(s('text', { x: m.l - 8, y: y(hr) + 4, class: 'axis-y' }, `${String(hr / 60).padStart(2, '0')}:00`));
  }
  if (work && toMin(work.end) > toMin(work.start)) {
    svg.append(s('rect', { x: m.l, width: W - m.l - m.r, y: y(toMin(work.start)), height: y(toMin(work.end)) - y(toMin(work.start)), class: 'work-band' }));
    svg.append(s('text', { x: W - m.r + 6, y: y(toMin(work.start)) + 12, class: 'work-label' }, 'Workday'));
  }
  days.forEach((d, i) => {
    if (d.date.endsWith('-01')) {
      svg.append(s('line', { x1: x(i), x2: x(i), y1: H - m.b, y2: H - m.b + 4, class: 'tick' }));
      svg.append(s('text', { x: x(i) + 3, y: H - m.b + 18, class: 'axis-x' }, MONTH[Number(d.date.slice(5, 7)) - 1]));
    }
  });
  if (recurring) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(toMin(recurring)), y2: y(toMin(recurring)), class: 'recurring' }));
    svg.append(s('text', { x: m.l + 6, y: y(toMin(recurring)) + 15, class: 'recurring-label' }, `A recurring ${recurring} event`));
  }

  // Clock changes: amber markers where the UTC offset jumps.
  days.forEach((d, i) => {
    if (i && d.offset !== days[i - 1].offset) {
      svg.append(s('line', { x1: x(i), x2: x(i), y1: m.t - 6, y2: H - m.b, class: 'dst-line' }));
      svg.append(s('text', { x: x(i), y: m.t - 9, class: 'dst-label' }, `${days[i - 1].abbr} to ${d.abbr}`));
    }
  });

  for (const c of CURVES) {
    let dpath = '';
    days.forEach((d, i) => {
      const v = d.t[c.key];
      if (v === null) return;
      const jump = i === 0 || d.offset !== days[i - 1].offset || days[i - 1].t[c.key] === null;
      dpath += `${jump ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    svg.append(s('path', { d: dpath, class: `curve ${c.cls}` }));
    const last = [...days].reverse().find((d) => d.t[c.key] !== null);
    svg.append(s('text', { x: W - m.r + 6, y: y(last.t[c.key]) + 4, class: `curve-label ${c.cls}` }, c.label));
  }

  // Hover / keyboard readout.
  const cursor = s('line', { x1: 0, x2: 0, y1: m.t, y2: H - m.b, class: 'cursor', visibility: 'hidden' });
  const dots = CURVES.map((c) => s('circle', { r: 3.5, class: `dot ${c.cls}`, visibility: 'hidden' }));
  svg.append(cursor, ...dots);
  const show = (i) => {
    const d = days[Math.max(0, Math.min(days.length - 1, i))];
    const idx = days.indexOf(d);
    cursor.setAttribute('x1', x(idx));
    cursor.setAttribute('x2', x(idx));
    cursor.setAttribute('visibility', 'visible');
    CURVES.forEach((c, k) => {
      if (d.t[c.key] === null) return;
      dots[k].setAttribute('cx', x(idx));
      dots[k].setAttribute('cy', y(d.t[c.key]));
      dots[k].setAttribute('visibility', 'visible');
    });
    if (readout) {
      const f = (v) => (v === null ? '–' : `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`);
      readout.textContent = `${dateLabel(d.date, { long: true })} (${d.abbr}): Dhuhr ${f(d.t.dhuhr)}, Asr ${f(d.t.asr)}, Maghrib ${f(d.t.maghrib)}`;
    }
    return idx;
  };
  let current = -1;
  const hit = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'hit', tabindex: '0', 'aria-label': 'Move through the year with the arrow keys' });
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    current = show(Math.round(((px - m.l) / (W - m.l - m.r)) * (days.length - 1)));
  });
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    current = show((current < 0 ? 0 : current) + (e.key === 'ArrowRight' ? (e.shiftKey ? 7 : 1) : (e.shiftKey ? -7 : -1)));
  });
  hit.addEventListener('focus', () => { current = show(current < 0 ? 0 : current); });
  svg.append(hit);
  return svg;
}
