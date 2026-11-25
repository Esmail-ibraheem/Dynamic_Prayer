// Builds data/cities.json — an offline city index (GeoNames, CC BY 4.0) so
// location search never sends the user's query to a third party.
//
//   node scripts/build-cities.mjs            (cities with population >= 5000)
//   node scripts/build-cities.mjs 15000      (smaller file)
import { writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const size = ['500', '1000', '5000', '15000'].includes(process.argv[2]) ? process.argv[2] : '5000';
const BASE = 'https://download.geonames.org/export/dump/';

async function get(name) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader: returns the named entry (deflate or stored). */
function unzip(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted) {
      const lnlen = buf.readUInt16LE(local + 26);
      const lelen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`${wanted} not in zip`);
}

const SCRIPT_OK = /^[\p{Script=Latin}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{Zs}\p{M}]+$/u;
const norm = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

console.log(`Downloading GeoNames cities${size} …`);
const [zip, admin1Raw, countryRaw] = await Promise.all([get(`cities${size}.zip`), get('admin1CodesASCII.txt'), get('countryInfo.txt')]);
const tsv = unzip(zip, `cities${size}.txt`).toString('utf8');

const admin1 = new Map();
for (const line of admin1Raw.toString('utf8').split('\n')) {
  const [code, name] = line.split('\t');
  if (code && name) admin1.set(code, name);
}
const countries = new Map();
for (const line of countryRaw.toString('utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const f = line.split('\t');
  countries.set(f[0], f[4]);
}

const cities = [];
for (const line of tsv.split('\n')) {
  if (!line) continue;
  const f = line.split('\t');
  const [, name, ascii, alt, lat, lon, , fcode, cc, , a1] = f;
  const pop = Number(f[14]) || 0;
  const tz = f[17];
  if (!tz || fcode === 'PPLX' || fcode === 'PPLH' || fcode === 'PPLQ' || fcode === 'PPLW') continue;
  const own = new Set([norm(name), norm(ascii)]);
  // Keep short alternate names (München, Muenchen, ميونخ …) for search only.
  // Latin, Arabic, Cyrillic and Greek scripts cover our users; CJK etc. are dropped to keep the file small.
  const all = [...new Set((alt || '').split(',').map((a) => a.trim())
    .filter((a) => a && a.length <= 32 && !/^https?:/.test(a) && SCRIPT_OK.test(a))
    .map(norm))]
    .filter((a) => a && a.length > 2 && !own.has(a));
  const arabic = all.filter((a) => /\p{Script=Arabic}/u.test(a)).slice(0, 8);
  const other = all.filter((a) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(a)).slice(0, 4);
  const latin = all.filter((a) => !arabic.includes(a) && !other.includes(a) && !/[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(a)).slice(0, 32);
  const alts = [...latin, ...arabic, ...other];
  cities.push([name, admin1.get(`${cc}.${a1}`) || '', cc, Number(lat), Number(lon), tz, pop, alts.join('|')]);
}
cities.sort((a, b) => b[6] - a[6]);

await mkdir(path.join(root, 'data'), { recursive: true });
const out = {
  source: `GeoNames cities${size} (https://www.geonames.org, CC BY 4.0)`,
  built: new Date().toISOString().slice(0, 10),
  fields: ['name', 'admin1', 'cc', 'lat', 'lon', 'timezone', 'population', 'alternates'],
  countries: Object.fromEntries(countries),
  cities,
};
await writeFile(path.join(root, 'data', 'cities.json'), JSON.stringify(out));
console.log(`Wrote data/cities.json with ${cities.length} places.`);
