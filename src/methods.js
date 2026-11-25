// Calculation authorities offered to users. Each entry builds a fresh adhan
// CalculationParameters object, so callers can mutate it safely.
import { CalculationMethod, CalculationParameters } from 'adhan';

/** @typedef {{fajrAngle:number, ishaAngle:number, ishaInterval:number}} CustomAngles */

export const METHODS = [
  { id: 'MWL', label: 'Muslim World League', angles: 'Fajr 18° · Isha 17°', region: 'Europe, Far East, parts of the Americas', build: () => CalculationMethod.MuslimWorldLeague() },
  { id: 'ISNA', label: 'Islamic Society of North America (ISNA)', angles: 'Fajr 15° · Isha 15°', region: 'USA, Canada', build: () => CalculationMethod.NorthAmerica() },
  { id: 'MoonsightingCommittee', label: 'Moonsighting Committee Worldwide', angles: 'Fajr 18° · Isha 18° · seasonal', region: 'North America, UK', build: () => CalculationMethod.MoonsightingCommittee() },
  { id: 'Egyptian', label: 'Egyptian General Authority of Survey', angles: 'Fajr 19.5° · Isha 17.5°', region: 'Africa, Syria, Lebanon, Malaysia', build: () => CalculationMethod.Egyptian() },
  { id: 'Karachi', label: 'University of Islamic Sciences, Karachi', angles: 'Fajr 18° · Isha 18°', region: 'Pakistan, Bangladesh, India, Afghanistan', build: () => CalculationMethod.Karachi() },
  { id: 'UmmAlQura', label: 'Umm al-Qura University, Makkah', angles: 'Fajr 18.5° · Isha 90 min', region: 'Saudi Arabia', build: () => CalculationMethod.UmmAlQura() },
  { id: 'Dubai', label: 'Dubai (UAE)', angles: 'Fajr 18.2° · Isha 18.2°', region: 'United Arab Emirates', build: () => CalculationMethod.Dubai() },
  { id: 'Kuwait', label: 'Kuwait', angles: 'Fajr 18° · Isha 17.5°', region: 'Kuwait', build: () => CalculationMethod.Kuwait() },
  { id: 'Qatar', label: 'Qatar', angles: 'Fajr 18° · Isha 90 min', region: 'Qatar', build: () => CalculationMethod.Qatar() },
  { id: 'Singapore', label: 'Majlis Ugama Islam Singapura (MUIS)', angles: 'Fajr 20° · Isha 18°', region: 'Singapore, Malaysia, Indonesia', build: () => CalculationMethod.Singapore() },
  { id: 'Turkey', label: 'Diyanet İşleri Başkanlığı (Turkey)', angles: 'Fajr 18° · Isha 17°', region: 'Turkey, Turkish mosques in Europe', build: () => CalculationMethod.Turkey() },
  { id: 'Tehran', label: 'Institute of Geophysics, University of Tehran', angles: 'Fajr 17.7° · Isha 14° · Maghrib 4.5°', region: 'Iran', build: () => CalculationMethod.Tehran() },
  { id: 'UOIF', label: 'Union des Organisations Islamiques de France', angles: 'Fajr 12° · Isha 12°', region: 'France', build: () => withAngles(12, 12, 0) },
  { id: 'Custom', label: 'Custom angles', angles: 'Set your own Fajr / Isha angles', region: 'Match your local mosque', build: (/** @type {CustomAngles} */ c) => withAngles(c.fajrAngle, c.ishaAngle, c.ishaInterval) },
];

export const METHOD_IDS = METHODS.map((m) => m.id);

function withAngles(fajrAngle, ishaAngle, ishaInterval) {
  const p = new CalculationParameters('Other', fajrAngle, ishaAngle, ishaInterval || 0);
  return p;
}

/**
 * @param {string} id
 * @param {CustomAngles} [custom]
 */
export function buildMethodParams(id, custom) {
  const m = METHODS.find((x) => x.id === id) || METHODS[0];
  return m.build(custom || { fajrAngle: 18, ishaAngle: 17, ishaInterval: 0 });
}

/** Public, serialisable view of the catalogue (no functions). */
export function methodCatalog() {
  return METHODS.map(({ id, label, angles, region }) => ({ id, label, angles, region }));
}
