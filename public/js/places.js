// Accessible place-search combobox backed by the offline city index.
import { api } from './api.js';
import { h, clear, debounce } from './dom.js';

let seq = 0;

export function describePlace(loc) {
  if (!loc) return '';
  return [loc.name, loc.admin && loc.admin !== loc.name ? loc.admin : null, loc.country].filter(Boolean).join(', ');
}

/**
 * @param {HTMLInputElement} input
 * @param {(loc: any) => void} onPick
 */
export function placeSearch(input, onPick) {
  const id = `places-${++seq}`;
  const list = h('ul', { class: 'place-list', id, role: 'listbox', hidden: true });
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const pick = (i) => {
    const r = results[i];
    if (!r) return;
    close();
    input.value = '';
    onPick({ name: r.name, admin: r.admin, country: r.country, cc: r.cc, lat: r.lat, lon: r.lon, timezone: r.timezone });
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${id}-${i}`);
  };

  const render = () => {
    clear(list);
    if (!results.length) {
      list.append(h('li', { class: 'place-empty', role: 'option', 'aria-disabled': 'true' }, 'No matching place. Try the nearest city or type coordinates like 48.14, 11.58.'));
    }
    results.forEach((r, i) => {
      list.append(h('li', {
        id: `${id}-${i}`,
        role: 'option',
        'aria-selected': 'false',
        onmousedown: (e) => { e.preventDefault(); pick(i); },
      },
      h('span', { class: 'place-name' }, r.name),
      h('span', { class: 'place-meta' }, [r.admin && r.admin !== r.name ? r.admin : null, r.country].filter(Boolean).join(', ')),
      h('span', { class: 'place-tz' }, r.timezone)));
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(results.length ? 0 : -1);
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    try {
      const data = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      results = data.results;
      render();
    } catch {
      close();
    }
  }, 160);

  input.addEventListener('input', run);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(active + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { close(); }
  });
}

/** Ask the browser for the current position and resolve it to a place. */
export function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share its location. Search for your city instead.'));
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await api(`/api/geo/reverse?lat=${pos.coords.latitude.toFixed(5)}&lon=${pos.coords.longitude.toFixed(5)}`);
          resolve(r.location);
        } catch (err) {
          reject(err);
        }
      },
      (err) => reject(new Error(err.code === 1 ? 'Location access was declined. Search for your city instead.' : 'Your location is not available right now. Search for your city instead.')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });
}
