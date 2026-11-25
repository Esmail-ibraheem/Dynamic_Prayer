// Main page controller: the setup form, live preview, and feed management.
import { api, ApiError, savedKey, keyFromHash } from './api.js';
import { h, $, $$, clear, debounce, toast, copyText } from './dom.js';
import { placeSearch, locateMe, describePlace } from './places.js';
import { band, hourAxis, dateLabel, hm, REASONS, ARABIC, transitionText, yearChart } from './sky.js';

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const DRAFT = 'waqt:draft';

const state = {
  meta: null,
  settings: null,
  mode: 'create',
  key: null,
  feed: null,
  saved: null,
  revision: null,
  previewFrom: null,
  preview: null,
  selected: null,
  tab: 'days',
  yearKey: null,
  tripPlace: null,
};

const form = $('#settings-form');
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  let t = o;
  for (const k of ks.slice(0, -1)) t = t[k];
  t[ks[ks.length - 1]] = v;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const dirty = () => state.mode === 'manage' && JSON.stringify(state.settings) !== state.saved;

// ------------------------------------------------------------------ form

function buildPrayerRows() {
  const body = $('#prayer-rows');
  for (const p of PRAYERS) {
    const label = state.meta.prayers[p];
    body.append(h('tr', {},
      h('th', { scope: 'row' }, h('span', { class: 'p-name' }, label), h('span', { class: 'p-ar', lang: 'ar', dir: 'rtl' }, ARABIC[p])),
      h('td', {}, h('label', { class: 'switch switch-only' }, h('input', { type: 'checkbox', 'data-path': `prayers.${p}.enabled`, 'data-type': 'bool', 'aria-label': `Block ${label}` }), h('span', {}))),
      h('td', {}, h('span', { class: 'num' }, h('input', { type: 'number', min: -60, max: 120, 'data-path': `prayers.${p}.offset`, 'data-type': 'int', 'aria-label': `${label} start, minutes after adhan` }), h('span', { class: 'unit' }, 'min'))),
      h('td', {}, h('span', { class: 'num' }, h('input', { type: 'number', min: 5, max: 180, 'data-path': `prayers.${p}.duration`, 'data-type': 'int', 'aria-label': `${label} length in minutes` }), h('span', { class: 'unit' }, 'min'))),
    ));
  }
}

function buildMethods() {
  const sel = $('#method');
  for (const m of state.meta.methods) sel.append(h('option', { value: m.id }, m.label));
  const tz = $('#tz-list');
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  for (const z of zones) tz.append(h('option', { value: z }));
}

function renderForm() {
  const st = state.settings;
  for (const el of $$('[data-path]', form)) {
    const v = getPath(st, el.dataset.path);
    if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.dataset.type === 'days') el.checked = v.includes(Number(el.value));
    else if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v === null || v === undefined ? '' : String(v);
  }
  renderLocation();
  renderTrips();
  updateVisibility();
}

function updateVisibility() {
  const st = state.settings;
  for (const el of $$('[data-show-if]')) {
    const [, path, op, val] = el.dataset.showIf.match(/^([\w.]+)(!=|=)(.*)$/);
    const cur = String(getPath(st, path));
    el.hidden = op === '=' ? cur !== val : cur === val;
  }
  const m = state.meta.methods.find((x) => x.id === st.method);
  $('#method-note').textContent = m ? `${m.angles}. Used in ${m.region}.` : '';
  $('#overnight-note').hidden = !(st.work.end <= st.work.start);
  for (const b of $$('#title-chips button')) b.setAttribute('aria-pressed', String(b.dataset.title === st.event.title));
  const submit = $('#submit-btn');
  if (state.mode === 'manage') {
    submit.textContent = 'Save changes';
    submit.disabled = !dirty();
    $('#submit-hint').textContent = dirty() ? 'You have unsaved changes. Calendars pick up saved changes at their next refresh.' : 'All changes saved. Your calendar picks up changes at its next refresh (usually within a few hours).';
  }
}

function readInput(el) {
  const t = el.dataset.type;
  if (el.type === 'radio') return el.checked ? el.value : undefined;
  if (t === 'days') return $$('[data-type="days"]', form).filter((x) => x.checked).map((x) => Number(x.value));
  if (t === 'bool') return el.checked;
  if (t === 'int' || t === 'float') {
    if (el.value === '' || Number.isNaN(Number(el.value))) return undefined;
    return t === 'int' ? Math.round(Number(el.value)) : Number(el.value);
  }
  if (el.type === 'time' && !el.value) return undefined;
  return el.value;
}

form.addEventListener('input', onField);
form.addEventListener('change', onField);
function onField(e) {
  const el = e.target;
  if (!el.dataset || !el.dataset.path) return;
  const v = readInput(el);
  if (v === undefined) return;
  if (JSON.stringify(getPath(state.settings, el.dataset.path)) === JSON.stringify(v)) return;
  setPath(state.settings, el.dataset.path, v);
  changed();
}

function changed({ preview = true } = {}) {
  updateVisibility();
  if (state.mode === 'create') {
    try { localStorage.setItem(DRAFT, JSON.stringify(state.settings)); } catch { /* ignore */ }
  }
  hideIssues();
  if (preview) schedulePreview();
}

$('#title-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-title]');
  if (!b) return;
  state.settings.event.title = b.dataset.title;
  $('#ev-title').value = b.dataset.title;
  changed();
});

// ------------------------------------------------------------- location

function zoneNow(tz) {
  try {
    const part = (locale, style) => new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
    // Prefer a real abbreviation (CET, EST, BST); en-US and en-GB each know different ones.
    const name = ['en-US', 'en-GB'].map((l) => part(l, 'short')).find((n) => n && !/^(GMT|UTC)([+-]|$)/.test(n)) || '';
    const offs = part('en-GB', 'longOffset').replace('GMT', 'UTC') || 'UTC';
    return name ? `${name}, ${offs}` : offs;
  } catch {
    return '';
  }
}

function renderLocation() {
  const loc = state.settings.location;
  const box = clear($('#chosen-place'));
  if (!loc) {
    box.append(h('p', { class: 'muted' }, 'No location yet. Search for the city you work in.'));
    suggestFromBrowser(box);
  } else {
    box.append(
      h('p', { class: 'chosen-name' }, describePlace(loc)),
      h('p', { class: 'chosen-meta' },
        h('span', {}, `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`),
        h('span', {}, `${loc.timezone}${zoneNow(loc.timezone) ? ` (now ${zoneNow(loc.timezone)})` : ''}`)),
    );
  }
  for (const el of $$('[data-loc]')) {
    if (document.activeElement === el) continue;
    el.value = loc ? String(loc[el.dataset.loc]) : '';
  }
}

async function suggestFromBrowser(box) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz || !tz.includes('/')) return;
  const city = tz.split('/').pop().replace(/_/g, ' ');
  try {
    const { results } = await api(`/api/geo/search?q=${encodeURIComponent(city)}`);
    const r = results.find((x) => x.timezone === tz);
    if (!r || state.settings.location) return;
    box.append(h('button', { type: 'button', class: 'btn btn-small', onclick: () => setLocation(r) }, `Use ${r.name}, ${r.country}`));
  } catch { /* optional */ }
}

function setLocation(loc) {
  state.settings.location = { name: loc.name, admin: loc.admin || '', country: loc.country || '', cc: loc.cc || '', lat: loc.lat, lon: loc.lon, timezone: loc.timezone };
  state.previewFrom = null;
  renderLocation();
  changed();
}

placeSearch($('#place-input'), setLocation);
$('#locate-btn').addEventListener('click', async () => {
  const btn = $('#locate-btn');
  btn.disabled = true;
  btn.textContent = 'Finding you…';
  try {
    setLocation(await locateMe());
    toast('Location set from your device.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Use my current location';
  }
});

for (const el of $$('[data-loc]')) {
  el.addEventListener('change', async () => {
    const loc = state.settings.location ? { ...state.settings.location } : { name: '', admin: '', country: '', cc: '', lat: 0, lon: 0, timezone: 'UTC' };
    const k = el.dataset.loc;
    if (k === 'timezone') {
      try {
        new Intl.DateTimeFormat('en', { timeZone: el.value });
        loc.timezone = el.value;
      } catch {
        toast(`“${el.value}” is not a timezone. Pick one from the list, e.g. Europe/Berlin.`, 'error');
        return;
      }
      setLocation(loc);
      return;
    }
    const n = Number(el.value);
    if (!Number.isFinite(n)) return;
    loc[k] = n;
    try {
      const r = await api(`/api/geo/reverse?lat=${loc.lat}&lon=${loc.lon}`);
      setLocation(r.location);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- trips

function renderTrips() {
  const list = clear($('#trip-list'));
  const trips = state.settings.trips || [];
  if (!trips.length) list.append(h('li', { class: 'muted' }, 'No trips planned.'));
  trips.forEach((t, i) => {
    list.append(h('li', {},
      h('span', { class: 'trip-dates' }, `${dateLabel(t.from)} – ${dateLabel(t.to)}`),
      h('span', { class: 'trip-place' }, `${t.label ? `${t.label}: ` : ''}${describePlace(t.location)}`),
      h('span', { class: 'trip-tz' }, t.location.timezone),
      h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { state.settings.trips.splice(i, 1); renderTrips(); changed(); } }, 'Remove')));
  });
}

placeSearch($('#trip-place'), (loc) => {
  state.tripPlace = loc;
  $('#trip-picked').textContent = `${describePlace(loc)} (${loc.timezone})`;
  $('#trip-picked').classList.remove('muted');
});

$('#trip-save').addEventListener('click', () => {
  const from = $('#trip-from').value;
  const to = $('#trip-to').value || from;
  if (!state.tripPlace) return toast('Choose the place you are travelling to.', 'error');
  if (!from) return toast('Choose the first day of the trip.', 'error');
  if (to < from) return toast('The trip has to end on or after its first day.', 'error');
  state.settings.trips = [...(state.settings.trips || []), { id: `trip-${Date.now().toString(36)}`, label: $('#trip-label').value.trim(), from, to, location: state.tripPlace }]
    .sort((a, b) => a.from.localeCompare(b.from));
  state.tripPlace = null;
  $('#trip-place').value = '';
  $('#trip-label').value = '';
  $('#trip-picked').textContent = 'No place chosen.';
  $('#trip-picked').classList.add('muted');
  $('#trip-add').open = false;
  renderTrips();
  changed();
  state.previewFrom = from;
  $('#preview-from').value = from;
  toast('Trip added. The preview now starts on its first day.');
});

// -------------------------------------------------------------- preview

const schedulePreview = debounce(refreshPreview, 220);

async function refreshPreview() {
  const st = state.settings;
  const empty = $('#preview-empty');
  if (!st.location) {
    empty.hidden = false;
    clear($('#day-list'));
    clear($('#day-detail'));
    $('#preview-summary').textContent = '';
    return;
  }
  empty.hidden = true;
  try {
    const data = await api('/api/preview', { method: 'POST', body: { settings: st, from: state.previewFrom || undefined, days: 14 } });
    state.preview = data;
    if (!state.previewFrom) $('#preview-from').value = data.from;
    renderPreview();
    if (state.tab === 'year') refreshYear();
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) showIssues(err.issues);
    else toast(err.message, 'error');
  }
}

function renderPreview() {
  const data = state.preview;
  const list = clear($('#day-list'));
  if (!data.days.some((d) => d.date === state.selected)) state.selected = data.days.find((d) => d.blocks.some((b) => b.included))?.date || data.days[0].date;
  let prevTrip = null;
  for (const day of data.days) {
    if (day.transition) list.append(h('p', { class: 'dst-marker' }, `${dateLabel(day.date)}: ${transitionText(day.transition).replace(/^C/, 'c')}`));
    const tripId = day.trip ? day.trip.id : null;
    if (tripId !== prevTrip) {
      list.append(h('p', { class: 'trip-marker' }, day.trip ? `Trip to ${day.location.name} (${day.zone})` : `Back home in ${day.location.name}`));
      prevTrip = tripId;
    }
    const count = day.blocks.filter((b) => b.included).length;
    list.append(h('button', {
      type: 'button',
      class: `day-row${day.isWorkday ? '' : ' day-off'}`,
      'aria-pressed': String(day.date === state.selected),
      onclick: () => { state.selected = day.date; renderPreview(); },
    },
    h('span', { class: 'day-name' }, dateLabel(day.date)),
    h('span', { class: 'day-zone' }, day.abbr),
    band(day),
    h('span', { class: 'day-count', 'aria-hidden': 'true' }, count ? String(count) : '')));
  }
  list.append(h('div', { class: 'axis-row' }, h('span'), h('span'), hourAxis(), h('span')));
  renderDetail(data.days.find((d) => d.date === state.selected));

  const sum = data.summary;
  const hrs = Math.floor(sum.minutes / 60);
  const mins = sum.minutes % 60;
  const parts = [`${sum.days} days: ${sum.blocks} block${sum.blocks === 1 ? '' : 's'}, ${hrs ? `${hrs} h ` : ''}${mins} min shown as ${state.settings.event.busy ? 'Busy' : 'Free'}.`];
  const tr = data.nextTransition;
  if (tr) parts.push(`Next clock change at ${state.settings.location.name}: ${dateLabel(tr.date, { long: true })}, ${transitionText(tr).replace(/^Clocks/, 'clocks')}.`);
  $('#preview-summary').textContent = parts.join(' ');
  const jump = $('#jump-dst');
  jump.hidden = !tr;
  if (tr) jump.dataset.date = tr.date;
}

function renderDetail(day) {
  const box = clear($('#day-detail'));
  if (!day) return;
  box.append(h('h3', {}, `${dateLabel(day.date, { long: true })}`, h('span', { class: 'detail-zone' }, `${day.location.name}, ${day.abbr} (UTC${day.offset})`)));
  const ul = h('ul', { class: 'detail-list' });
  for (const b of day.blocks) {
    const status = b.included ? 'Blocked' : `Not blocked: ${REASONS[b.reason] || b.reason}`;
    ul.append(h('li', { class: b.included ? 'is-on' : 'is-off' },
      h('span', { class: 'd-name' }, b.label, h('span', { class: 'p-ar', lang: 'ar', dir: 'rtl' }, ARABIC[b.prayer])),
      h('span', { class: 'd-adhan' }, b.prayer === 'jumuah' ? (b.rule || '') : `adhan ${hm(b.adhan)}`),
      h('span', { class: 'd-time' }, `${hm(b.start)}–${hm(b.end)}`),
      h('span', { class: 'd-status' }, status)));
  }
  box.append(ul);
}

$('#preview-from').addEventListener('change', (e) => {
  state.previewFrom = e.target.value || null;
  refreshPreview();
});
$('#jump-today').addEventListener('click', () => {
  state.previewFrom = null;
  refreshPreview();
});
$('#jump-dst').addEventListener('click', (e) => {
  const d = new Date(`${e.currentTarget.dataset.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 3);
  state.previewFrom = d.toISOString().slice(0, 10);
  $('#preview-from').value = state.previewFrom;
  state.selected = e.currentTarget.dataset.date;
  refreshPreview();
});

// Tabs
function selectTab(name) {
  state.tab = name;
  for (const [tab, pane] of [['#tab-days', '#pane-days'], ['#tab-year', '#pane-year']]) {
    const on = tab === `#tab-${name}`;
    $(tab).setAttribute('aria-selected', String(on));
    $(tab).tabIndex = on ? 0 : -1;
    $(pane).hidden = !on;
  }
  if (name === 'year') refreshYear();
}
$('#tab-days').addEventListener('click', () => selectTab('days'));
$('#tab-year').addEventListener('click', () => selectTab('year'));
$('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = state.tab === 'days' ? 'year' : 'days';
  selectTab(next);
  $(`#tab-${next}`).focus();
});

async function refreshYear() {
  const st = state.settings;
  const host = $('#year-user');
  if (!st.location) {
    clear(host).append(h('p', { class: 'muted' }, 'Choose a location to see the year.'));
    return;
  }
  const key = JSON.stringify([st.location, st.method, st.madhab, st.adjustments, st.customAngles, st.highLatitudeRule, st.work, st.trips]);
  if (key === state.yearKey) return;
  state.yearKey = key;
  try {
    const data = await api('/api/year', { method: 'POST', body: { settings: st } });
    clear(host).append(yearChart(data, { work: st.work.filter ? st.work : null, readout: $('#year-user-readout') }));
  } catch (err) {
    state.yearKey = null;
    clear(host).append(h('p', { class: 'muted' }, err.message));
  }
}

// --------------------------------------------------------------- issues

function showIssues(issues) {
  const box = clear($('#issues'));
  box.append(h('p', {}, 'Some settings need a fix:'), h('ul', {}, issues.map((i) => h('li', {}, i))));
  box.hidden = false;
}
function hideIssues() {
  $('#issues').hidden = true;
}

// ------------------------------------------------------------ submit

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.settings.location) {
    showIssues(['Choose a location first: search for your city or use your current location.']);
    $('#place-input').focus();
    return;
  }
  const btn = $('#submit-btn');
  btn.disabled = true;
  try {
    if (state.mode === 'create') {
      btn.textContent = 'Creating…';
      const res = await api('/api/feeds', { method: 'POST', body: { settings: state.settings } });
      const key = res.urls.manageUrl.split('#k=')[1];
      savedKey.set(key);
      try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
      history.replaceState(null, '', `/manage#k=${key}`);
      enterManage(res, key, { justCreated: true });
    } else {
      btn.textContent = 'Saving…';
      const res = await api('/api/feed', { method: 'PUT', key: state.key, body: { settings: state.settings, revision: state.revision } });
      applyFeed(res);
      toast('Changes saved. Your calendar picks them up at its next refresh.');
    }
  } catch (err) {
    if (err.status === 409) {
      const box = clear($('#issues'));
      box.append(h('p', {}, err.message), h('button', { type: 'button', class: 'btn btn-small', onclick: () => location.reload() }, 'Reload latest settings'));
      box.hidden = false;
    } else if (err.issues && err.issues.length) showIssues(err.issues);
    else showIssues([err.message]);
  } finally {
    btn.disabled = false;
    if (state.mode === 'create') btn.textContent = 'Create my calendar feed';
    updateVisibility();
  }
});

// ------------------------------------------------------------- manage

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function urlRow(label, value, { open = false } = {}) {
  const id = `u-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { id, type: 'text', readonly: true, value, spellcheck: 'false', onfocus: (e) => e.target.select() });
  return h('div', { class: 'url-row' },
    h('label', { for: id }, label),
    h('div', { class: 'url-box' },
      input,
      h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { if (await copyText(value)) toast(`${label} copied.`); } }, 'Copy'),
      open ? h('a', { class: 'btn btn-small btn-quiet', href: value }, 'Open') : null));
}

function renderFeedPanel({ justCreated = false } = {}) {
  const f = state.feed;
  const u = f.urls;
  const panel = clear($('#feed-panel'));
  panel.hidden = false;
  const sync = f.sync.fetchCount
    ? `Last fetched by ${f.sync.lastClient} ${timeAgo(f.sync.lastFetchAt)}, ${f.sync.fetchCount} time${f.sync.fetchCount === 1 ? '' : 's'} so far.`
    : 'No calendar has fetched this feed yet. Once you subscribe, this shows when your calendar last checked for updates.';
  panel.append(
    h('div', { class: 'feed-main' },
      h('h3', { tabindex: '-1', id: 'feed-title' }, justCreated ? 'Your calendar feed is ready' : 'Your calendar feed'),
      h('p', { class: 'sync' }, sync),
      urlRow('Subscription link', u.feedUrl),
      h('div', { class: 'add-to' },
        h('a', { class: 'btn btn-primary', href: u.outlookWork, target: '_blank', rel: 'noopener' }, 'Add to Outlook (work or school)'),
        h('a', { class: 'btn', href: u.outlookPersonal, target: '_blank', rel: 'noopener' }, 'Outlook.com'),
        h('a', { class: 'btn', href: u.google, target: '_blank', rel: 'noopener' }, 'Google Calendar'),
        h('a', { class: 'btn', href: u.webcalUrl }, 'Apple Calendar'),
        h('a', { class: 'btn btn-quiet', href: u.downloadUrl }, 'Download .ics')),
      f.publicReachable ? null : h('p', { class: 'note' }, 'This server is running on your own computer, so Google and Outlook on the web can’t reach the link yet. Apple Calendar and Outlook on this computer, and the download, work now. To subscribe from anywhere, run it on a public https address and set PUBLIC_BASE_URL (see the README).'),
      h('details', { class: 'more' },
        h('summary', {}, 'Subscribe by hand'),
        h('ul', { class: 'manual' },
          h('li', {}, h('strong', {}, 'Outlook (desktop or web): '), 'Calendar, then Add calendar, then Subscribe from web. Paste the subscription link.'),
          h('li', {}, h('strong', {}, 'Google Calendar: '), 'Settings, then Add calendar, then From URL. Paste the subscription link.'),
          h('li', {}, h('strong', {}, 'Apple Calendar: '), 'File, then New Calendar Subscription. Paste the subscription link and choose an auto-refresh interval.')))),
    h('div', { class: 'feed-private' },
      h('h3', {}, 'Private links'),
      h('p', {}, 'Bookmark the manage link. Anyone who has it can change this feed, and it can’t be recovered if lost.'),
      urlRow('Manage link', u.manageUrl),
      urlRow('Travel link', u.travelUrl, { open: true }),
      h('p', { class: 'hint' }, 'The travel link opens a small page for your phone: pick where you are and the feed follows, with the same subscription link.')),
  );
  if (justCreated) {
    panel.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    $('#feed-title').focus({ preventScroll: true });
  }
}

function applyFeed(res) {
  state.feed = res;
  state.settings = clone(res.settings);
  state.saved = JSON.stringify(state.settings);
  state.revision = res.revision;
  renderForm();
  renderFeedPanel();
}

function enterManage(res, key, { justCreated = false } = {}) {
  state.mode = 'manage';
  state.key = key;
  document.body.classList.add('is-manage');
  $('#build-title').textContent = 'Your settings';
  $('#build-sub').textContent = 'Change anything below and save. The subscription link in your calendar stays the same.';
  $('#manage-extra').hidden = false;
  $('#nav-manage').hidden = false;
  $('#nav-manage').href = `/manage#k=${key}`;
  applyFeed(res);
  renderFeedPanel({ justCreated });
  refreshPreview();
}

$('#rotate-btn').addEventListener('click', async () => {
  if (!(await confirmDialog('Issue a new feed address?', 'The current subscription link stops working immediately. You will need to subscribe again with the new link in every calendar that uses it.', 'Issue new address'))) return;
  try {
    const res = await api('/api/feed/rotate', { method: 'POST', key: state.key });
    state.feed = res;
    state.revision = res.revision;
    renderFeedPanel();
    toast('New feed address issued. Subscribe again with the new link.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete this feed?', 'Your settings are removed from this server and calendars subscribed to it stop receiving blocks. This can’t be undone.', 'Delete feed'))) return;
  try {
    await api('/api/feed', { method: 'DELETE', key: state.key });
    savedKey.clear();
    location.href = '/';
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#forget-btn').addEventListener('click', () => {
  savedKey.clear();
  $('#nav-manage').hidden = true;
  toast('This browser no longer remembers your manage link. Keep your bookmark.');
});

function confirmDialog(title, body, ok) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

window.addEventListener('beforeunload', (e) => {
  if (dirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------ hero demos

async function renderSeasonDemo() {
  const ex = state.meta.example;
  const host = $('#season-rows');
  const dates = ['2026-06-15', '2026-10-23', '2026-10-26'];
  try {
    const results = await Promise.all(dates.map((from) => api('/api/preview', { method: 'POST', body: { settings: ex, from, days: 1 } })));
    clear(host);
    // Two labels need ~48px between them; convert that to hours for this band width.
    const minLabelGap = 48 / (Math.max(host.clientWidth, 200) / 24);
    results.forEach((r, i) => {
      const day = r.days[0];
      if (i === 2) host.append(h('p', { class: 'dst-marker' }, 'Sunday 25 October: clocks go back one hour (CEST to CET)'));
      const on = day.blocks.filter((b) => b.included);
      const off = day.blocks.filter((b) => !b.included && b.reason === 'outside-hours');
      host.append(h('div', { class: 'season-row' },
        h('p', { class: 'season-date' }, h('span', {}, dateLabel(day.date, { long: true })), h('span', { class: 'zone-chip' }, `${day.abbr}, UTC${day.offset}`)),
        band(day, { labels: true, size: 'lg', minLabelGap }),
        h('ul', { class: 'season-blocks' },
          on.map((b) => h('li', { class: 'is-on' }, h('span', {}, b.label), ` ${hm(b.start)}–${hm(b.end)}`)),
          off.map((b) => h('li', { class: 'is-off' }, h('span', {}, b.label), ` ${hm(b.adhan)}, after work`)))));
    });
    host.append(hourAxis());
  } catch (err) {
    clear(host).append(h('p', { class: 'muted' }, err.message));
  }
}

async function renderYearDemo() {
  const ex = state.meta.example;
  try {
    const data = await api('/api/year', { method: 'POST', body: { settings: ex, year: 2026 } });
    clear($('#year-demo')).append(yearChart(data, { work: ex.work, recurring: '13:00', readout: $('#year-demo-readout') }));
  } catch (err) {
    clear($('#year-demo')).append(h('p', { class: 'muted' }, err.message));
  }
}

$('#load-example').addEventListener('click', () => {
  if (state.mode === 'manage' && !confirm('Replace your current settings with the Munich example? Nothing is saved until you press Save changes.')) return;
  state.settings = clone(state.meta.example);
  state.previewFrom = '2026-10-19';
  $('#preview-from').value = state.previewFrom;
  state.selected = '2026-10-26';
  renderForm();
  changed();
  $('#build').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  toast('Loaded the Munich example. The preview shows the week of the October clock change.');
});

// On narrow screens the preview sits right after the Location step, so the
// blocks are visible as soon as a city is picked; on wide screens it is the
// sticky right-hand column.
const narrow = matchMedia('(max-width: 1080px)');
function placePreview() {
  const preview = $('#preview');
  if (narrow.matches) $('#step-location').after(preview);
  else $('.build-grid').append(preview);
}
narrow.addEventListener('change', placePreview);
placePreview();

// ------------------------------------------------------------------ boot

async function boot() {
  state.meta = await api('/api/meta');
  buildMethods();
  buildPrayerRows();

  const remembered = savedKey.get();
  if (remembered) {
    $('#nav-manage').hidden = false;
    $('#nav-manage').href = `/manage#k=${remembered}`;
  }

  renderSeasonDemo();
  renderYearDemo();

  const onManage = location.pathname === '/manage';
  const key = keyFromHash() || (onManage ? remembered : null);
  if (onManage && key) {
    try {
      const res = await api('/api/feed', { key });
      if (!keyFromHash()) history.replaceState(null, '', `/manage#k=${key}`);
      savedKey.set(key);
      enterManage(res, key);
      $('#build').scrollIntoView();
      return;
    } catch (err) {
      if (err.status === 404 && key === remembered) savedKey.clear();
      showIssues([err.message, 'You can set up a new feed below.']);
    }
  }

  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { /* ignore */ }
  state.settings = draft && draft.version === state.meta.defaults.version ? { ...clone(state.meta.defaults), ...draft } : clone(state.meta.defaults);
  renderForm();
  refreshPreview();
}

boot().catch((err) => {
  document.body.prepend(h('p', { class: 'boot-error', role: 'alert' }, `The app could not start: ${err.message}`));
});
