// Offline geocoding: city search + coordinates -> IANA timezone / nearest city.
// Nothing here talks to the network, so location queries never leave the server.
import { readFileSync, existsSync } from 'node:fs';
import tzlookup from '@photostructure/tz-lookup';
import { IANAZone } from 'luxon';

let index = null;

const norm = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Load data/cities.json once. Returns false if the dataset is missing. */
export function loadCities(file) {
  if (index) return true;
  if (!existsSync(file)) {
    index = { cities: [], countries: {}, source: null };
    return false;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const cities = raw.cities.map(([name, admin, cc, lat, lon, timezone, pop, alts], i) => ({
    id: i,
    name, admin, cc, lat, lon, timezone, pop,
    n: norm(name),
    alts: alts ? alts.split('|') : [],
  }));
  index = { cities, countries: raw.countries || {}, source: raw.source };
  return true;
}

export const datasetInfo = () => ({ places: index?.cities.length || 0, source: index?.source || null });

function view(c, extra = {}) {
  return { name: c.name, admin: c.admin, country: index.countries[c.cc] || c.cc, cc: c.cc, lat: c.lat, lon: c.lon, timezone: c.timezone, population: c.pop, ...extra };
}

/** Timezone at a coordinate (falls back to a fixed Etc/GMT zone at sea). */
export function timezoneAt(lat, lon) {
  try {
    const tz = tzlookup(lat, lon);
    if (tz && IANAZone.isValidZone(tz)) return tz;
  } catch { /* fall through */ }
  const h = Math.round(lon / 15);
  return h === 0 ? 'UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}

const toRad = (d) => (d * Math.PI) / 180;
export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Nearest known place to a coordinate (for labelling GPS positions). */
export function nearestCity(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const c of index?.cities || []) {
    if (Math.abs(c.lat - lat) > 3) continue; // cheap prefilter
    const d = distanceKm(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? view(best, { distanceKm: Math.round(bestD * 10) / 10 }) : null;
}

/** Resolve a coordinate to a location object usable in settings. */
export function reverse(lat, lon) {
  const timezone = timezoneAt(lat, lon);
  const near = nearestCity(lat, lon);
  const label = near && near.distanceKm <= 25 ? near.name : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return {
    location: { name: label, admin: near && near.distanceKm <= 25 ? near.admin : '', country: near ? near.country : '', cc: near ? near.cc : '', lat, lon, timezone },
    nearest: near,
  };
}

const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * Search cities by name. Supports "City", "City, Country", alternate and
 * Arabic names, and raw "lat, lon" coordinates.
 */
export function search(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  const m = q.match(COORD_RE);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const r = reverse(lat, lon);
      return [{ ...r.location, population: 0, coordinates: true }];
    }
  }
  const [cityPart, ...rest] = q.split(',');
  const nq = norm(cityPart);
  const filter = norm(rest.join(' '));
  if (!nq) return [];
  const scored = [];
  for (const c of index?.cities || []) {
    let s = 0;
    if (c.n === nq) s = 100;
    else if (c.n.startsWith(nq)) s = 70;
    else if (c.n.includes(` ${nq}`)) s = 45;
    else {
      for (const a of c.alts) {
        if (a === nq) { s = 80; break; }
        if (s < 40 && a.startsWith(nq)) s = 40;
      }
    }
    if (!s) continue;
    if (filter) {
      const country = norm(index.countries[c.cc] || '');
      const ok = country.startsWith(filter) || c.cc.toLowerCase() === filter || norm(c.admin).startsWith(filter);
      if (!ok) continue;
      s += 20;
    }
    scored.push([s + Math.log10(c.pop + 10) * 6, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, c]) => view(c));
}
