import { normalizeSettings, munichExample, defaultSettings } from '../src/settings.js';

export const PLACES = {
  munich: { name: 'Munich', admin: 'Bavaria', country: 'Germany', cc: 'DE', lat: 48.1351, lon: 11.582, timezone: 'Europe/Berlin' },
  london: { name: 'London', admin: 'England', country: 'United Kingdom', cc: 'GB', lat: 51.5074, lon: -0.1278, timezone: 'Europe/London' },
  newYork: { name: 'New York', admin: 'New York', country: 'United States', cc: 'US', lat: 40.7128, lon: -74.006, timezone: 'America/New_York' },
  sydney: { name: 'Sydney', admin: 'New South Wales', country: 'Australia', cc: 'AU', lat: -33.8688, lon: 151.2093, timezone: 'Australia/Sydney' },
  makkah: { name: 'Makkah', admin: 'Makkah', country: 'Saudi Arabia', cc: 'SA', lat: 21.4225, lon: 39.8262, timezone: 'Asia/Riyadh' },
  jerusalem: { name: 'Jerusalem', admin: '', country: 'Israel', cc: 'IL', lat: 31.7683, lon: 35.2137, timezone: 'Asia/Jerusalem' },
  tromso: { name: 'Tromsø', admin: 'Troms', country: 'Norway', cc: 'NO', lat: 69.6496, lon: 18.956, timezone: 'Europe/Oslo' },
};

/** Normalised settings: defaults, then a deep-ish merge of overrides. */
export function settings(overrides = {}, base = defaultSettings()) {
  const s = structuredClone(base);
  for (const [k, v] of Object.entries(overrides)) {
    s[k] = v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object' ? { ...s[k], ...v } : v;
  }
  if (!s.location) s.location = PLACES.munich;
  return normalizeSettings(s, { requireLocation: true });
}

export const munich = (overrides = {}) => settings(overrides, munichExample());

export const hhmm = (iso) => iso.slice(11, 16);
export const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
