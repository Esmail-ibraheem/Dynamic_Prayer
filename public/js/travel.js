// Travel quick-switch: change location from a phone without touching the
// subscription URL installed in the work calendar.
import { api, keyFromHash, savedKey } from './api.js';
import { h, $, clear, toast } from './dom.js';
import { placeSearch, locateMe, describePlace } from './places.js';
import { band, dateLabel, hm, REASONS } from './sky.js';

const key = keyFromHash() || savedKey.get();
let feed = null;
let picked = null;

const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function fail(message) {
  const box = clear($('#travel-error'));
  box.append(h('p', {}, message), h('p', {}, h('a', { href: '/' }, 'Set up a feed')));
  box.hidden = false;
}

function renderNow() {
  const s = feed.settings;
  const today = todayIn(s.location.timezone);
  const trip = (s.trips || []).find((t) => t.from <= today && today <= t.to);
  const box = clear($('#now-box'));
  if (trip) {
    box.append(
      h('p', { class: 'now-place' }, `Now: ${describePlace(trip.location)}`),
      h('p', { class: 'muted' }, `Trip until ${dateLabel(trip.to, { long: true })}. Home is ${describePlace(s.location)}.`),
    );
  } else {
    box.append(h('p', { class: 'now-place' }, `Now: ${describePlace(s.location)}`), h('p', { class: 'muted' }, `Home location, ${s.location.timezone}.`));
  }
  const upcoming = (s.trips || []).filter((t) => t.to >= today);
  const host = clear($('#t-trips'));
  if (upcoming.length) {
    host.append(
      h('h2', {}, 'Trips in your feed'),
      h('ul', {}, upcoming.map((t) => h('li', {}, `${dateLabel(t.from)} – ${dateLabel(t.to)}: ${describePlace(t.location)}`))),
      h('button', { type: 'button', class: 'btn btn-small', onclick: clearTrips }, 'Remove all trips'),
    );
  }
}

function pick(loc) {
  picked = loc;
  const box = clear($('#t-picked'));
  box.append(describePlace(loc), h('small', {}, `${loc.timezone}`));
  box.hidden = false;
  $('#t-mode').hidden = false;
  $('#t-save').hidden = false;
  const until = $('#t-until');
  if (!until.value) {
    const d = new Date(`${todayIn(loc.timezone)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 4);
    until.value = d.toISOString().slice(0, 10);
  }
  until.min = todayIn(loc.timezone);
}

async function showToday(settings, loc) {
  const date = todayIn(loc.timezone);
  const r = await api('/api/preview', { method: 'POST', body: { settings, from: date, days: 1 } });
  const day = r.days[0];
  const host = clear($('#t-result'));
  host.append(
    h('h2', {}, `Today in ${day.location.name} (${day.abbr})`),
    band(day, { labels: true, size: 'lg', minLabelGap: 48 / (Math.max(host.clientWidth, 200) / 24) }),
    h('ul', {}, day.blocks.filter((b) => b.reason !== 'disabled').map((b) => h('li', { class: b.included ? 'is-on' : 'is-off' },
      h('span', {}, b.label),
      h('span', {}, b.included ? `${hm(b.start)}–${hm(b.end)}` : `${hm(b.adhan)}, ${REASONS[b.reason]}`)))),
  );
}

async function save() {
  if (!picked) return;
  const mode = document.querySelector('input[name="tmode"]:checked').value;
  const btn = $('#t-save');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const body = mode === 'trip'
      ? { mode, location: picked, from: todayIn(picked.timezone), to: $('#t-until').value || todayIn(picked.timezone) }
      : { mode, location: picked };
    if (mode === 'trip' && body.to < body.from) throw new Error('The last day of the trip can’t be before today.');
    feed = await api('/api/feed/travel', { method: 'POST', key, body });
    renderNow();
    await showToday(feed.settings, picked);
    toast(mode === 'trip' ? `Feed updated for your trip to ${picked.name}.` : `${picked.name} is now your home location.`);
  } catch (err) {
    toast(err.issues?.length ? err.issues.join('; ') : err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update my feed';
  }
}

async function clearTrips() {
  try {
    feed = await api('/api/feed/travel', { method: 'POST', key, body: { mode: 'clear-trips' } });
    renderNow();
    clear($('#t-result'));
    toast('All trips removed. Your feed uses your home location again.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function boot() {
  if (!key) return fail('This page needs your private travel link. Open it from the link you saved when you created your feed.');
  try {
    feed = await api('/api/feed', { key });
  } catch (err) {
    return fail(err.message);
  }
  if (!keyFromHash()) history.replaceState(null, '', `/travel#k=${key}`);
  $('#manage-link').href = `/manage#k=${key}`;
  $('#travel-app').hidden = false;
  renderNow();
  placeSearch($('#t-place'), pick);
  $('#t-save').addEventListener('click', save);
  $('#t-locate').addEventListener('click', async () => {
    try {
      pick(await locateMe());
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

boot();
