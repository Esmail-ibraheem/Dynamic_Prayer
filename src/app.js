// HTTP application: JSON API, calendar feeds and the static dashboard.
// Plain node:http — no framework — so the whole request path is auditable.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DateTime } from 'luxon';
import { normalizeSettings, defaultSettings, munichExample, SettingsError, PRAYER_LABELS } from './settings.js';
import { computeRange, feedWindow, nextTransition, summarize, todayIn } from './engine.js';
import { buildCalendar } from './ics.js';
import { methodCatalog } from './methods.js';
import * as geo from './geo.js';

const MAX_BODY = 64 * 1024;
const MAX_STATELESS = 6000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Which calendar product fetched the feed (shown as "last synced by …"). */
export function detectClient(ua = '') {
  if (/Google-Calendar-Importer|Google/i.test(ua)) return 'Google Calendar';
  if (/Outlook|Exchange|Microsoft|MSFT|Office/i.test(ua)) return 'Microsoft Outlook';
  if (/dataaccessd|CalendarAgent|iCal|accountsd|remindd/i.test(ua) || /^(Mac OS X|iOS)\//.test(ua)) return 'Apple Calendar';
  if (/Thunderbird|Lightning/i.test(ua)) return 'Thunderbird';
  if (/Fantastical|Proton|Fastmail|Nextcloud|DAVx|Evolution/i.test(ua)) return ua.match(/Fantastical|Proton|Fastmail|Nextcloud|DAVx|Evolution/i)[0];
  if (/curl|wget|node|python|httpie/i.test(ua)) return 'Script';
  if (/Mozilla/i.test(ua)) return 'Web browser';
  return 'Calendar app';
}

/** Small fixed-window rate limiter keyed by client address. */
function rateLimiter() {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  }, 60_000).unref();
  return (key, limit, windowMs) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > limit) throw new HttpError(429, 'Too many requests — please slow down.', { retryAfter: Math.ceil((b.reset - now) / 1000) });
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./db.js').openDb>} deps.db
 * @param {object} deps.config
 */
export function createApp({ db, config }) {
  const limit = rateLimiter();
  const publicDir = config.publicDir;
  const feedCache = new Map();

  const json = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  };

  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || 'unknown');

  const baseUrl = (req) => {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
    const proto = config.trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : (req.socket.encrypted ? 'https' : 'http');
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
  };

  const isLocalBase = (base) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[^/]+\.localhost)(:\d+)?$/i.test(base);

  function subscribeUrls(base, feedPath, name) {
    const feedUrl = `${base}${feedPath}`;
    const webcalUrl = feedUrl.replace(/^https?:\/\//, 'webcal://');
    return {
      feedUrl,
      webcalUrl,
      google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`,
      outlookPersonal: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}&name=${encodeURIComponent(name)}`,
      outlookWork: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}&name=${encodeURIComponent(name)}`,
      downloadUrl: `${feedUrl}?download=1`,
    };
  }

  function feedResponse(row, base, editToken) {
    const s = row.settings;
    return {
      settings: s,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sync: { lastFetchAt: row.last_fetch_at, lastClient: row.last_fetch_client, fetchCount: row.fetch_count },
      urls: {
        ...subscribeUrls(base, `/cal/${row.feed_token}.ics`, s.feed.name),
        ...(editToken ? { manageUrl: `${base}/manage#k=${editToken}`, travelUrl: `${base}/travel#k=${editToken}` } : {}),
      },
      publicReachable: !isLocalBase(base),
    };
  }

  async function readJson(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'Malformed JSON.');
    }
  }

  function requireEdit(req) {
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^Bearer\s+(k_[A-Za-z0-9_-]{16,64})$/);
    if (!m) throw new HttpError(401, 'Missing or malformed manage key.');
    const row = db.byEditToken(m[1]);
    if (!row) throw new HttpError(404, 'This manage link is not valid (the feed may have been deleted).');
    return { row, editToken: m[1] };
  }

  function renderFeed(settings, { feedId, revision = 1, updatedAt }) {
    const win = feedWindow(settings);
    const key = `${feedId}:${revision}:${win.from}:${win.days}:${updatedAt || ''}`;
    const hit = feedCache.get(key);
    if (hit) return hit;
    const days = computeRange(settings, win.from, win.days);
    const body = buildCalendar({ settings, days, feedId, revision, updatedAt, uidDomain: config.uidDomain });
    const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
    const out = { body, etag };
    feedCache.set(key, out);
    if (feedCache.size > 500) feedCache.delete(feedCache.keys().next().value);
    return out;
  }

  function sendCalendar(req, res, { body, etag }, filename, download) {
    const headers = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'public, max-age=900',
      ETag: etag,
      'X-Robots-Tag': 'noindex, nofollow',
      'Access-Control-Allow-Origin': '*',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveStatic(req, res, rel) {
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir)) throw new HttpError(404, 'Not found');
    let st;
    try {
      st = await stat(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Revalidate everything except fonts: assets are tiny and ETags make it a cheap 304.
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const data = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  function previewDays(settings, body) {
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 62);
    const from = typeof body.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.from) && DateTime.fromISO(body.from).isValid ? body.from : todayIn(settings);
    const list = computeRange(settings, from, days);
    return { from, days: list, summary: summarize(list), nextTransition: nextTransition(settings), today: todayIn(settings) };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const method = req.method;
    const ip = clientIp(req);

    if (p === '/healthz') return json(res, 200, { ok: true, feeds: db.count(), places: geo.datasetInfo().places });

    // ---- Calendar feeds -------------------------------------------------
    let m = p.match(/^\/cal\/(f_[A-Za-z0-9_-]{16,40})\.ics$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      limit(`feed:${ip}`, 600, 60_000);
      const row = db.byFeedToken(m[1]);
      if (!row) throw new HttpError(404, 'Unknown calendar feed.');
      const out = renderFeed(row.settings, { feedId: row.uid, revision: row.revision, updatedAt: row.updated_at });
      db.recordFetch(row.id, detectClient(String(req.headers['user-agent'] || '')));
      return sendCalendar(req, res, out, 'prayer-blocks.ics', url.searchParams.has('download'));
    }
    m = p.match(/^\/s\/([A-Za-z0-9_-]{10,})\.ics$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      limit(`feed:${ip}`, 600, 60_000);
      if (m[1].length > MAX_STATELESS) throw new HttpError(414, 'Configuration link too long.');
      let raw;
      try {
        raw = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      } catch {
        throw new HttpError(400, 'This configuration link is damaged.');
      }
      const settings = normalizeSettings(raw, { requireLocation: true });
      const feedId = createHash('sha1').update(m[1]).digest('hex').slice(0, 12);
      const out = renderFeed(settings, { feedId, revision: 1, updatedAt: DateTime.utc().startOf('day').toISO() });
      return sendCalendar(req, res, out, 'prayer-blocks.ics', url.searchParams.has('download'));
    }

    // ---- JSON API -------------------------------------------------------
    if (p.startsWith('/api/')) {
      if (p === '/api/meta' && method === 'GET') {
        const base = baseUrl(req);
        return json(res, 200, {
          version: '1.0.0',
          methods: methodCatalog(),
          prayers: PRAYER_LABELS,
          defaults: defaultSettings(),
          example: munichExample(),
          geo: geo.datasetInfo(),
          baseUrl: base,
          publicReachable: !isLocalBase(base),
        });
      }
      if (p === '/api/geo/search' && method === 'GET') {
        limit(`geo:${ip}`, 240, 60_000);
        const q = (url.searchParams.get('q') || '').slice(0, 80);
        return json(res, 200, { results: geo.search(q, 8) });
      }
      if (p === '/api/geo/reverse' && method === 'GET') {
        limit(`geo:${ip}`, 240, 60_000);
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'lat/lon out of range.');
        return json(res, 200, geo.reverse(Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5));
      }
      if (p === '/api/preview' && method === 'POST') {
        limit(`preview:${ip}`, 300, 60_000);
        const body = await readJson(req);
        const settings = normalizeSettings(body.settings, { requireLocation: true });
        return json(res, 200, previewDays(settings, body));
      }
      if (p === '/api/year' && method === 'POST') {
        limit(`preview:${ip}`, 300, 60_000);
        const body = await readJson(req);
        const settings = normalizeSettings(body.settings, { requireLocation: true });
        const year = Number.isInteger(body.year) && body.year >= 1970 && body.year <= 2100 ? body.year : DateTime.now().setZone(settings.location.timezone).year;
        const first = DateTime.utc(year, 1, 1);
        const list = computeRange(settings, first.toISODate(), first.endOf('year').ordinal);
        const mins = (iso) => {
          if (!iso) return null;
          const t = DateTime.fromISO(iso, { setZone: true });
          return t.hour * 60 + t.minute;
        };
        return json(res, 200, {
          year,
          zone: settings.location.timezone,
          days: list.map((d) => ({
            date: d.date,
            offset: d.offset,
            abbr: d.abbr,
            dst: d.isDST,
            workday: d.isWorkday,
            t: Object.fromEntries(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => [k, mins(d.times[k])])),
            b: d.blocks.filter((b) => b.included).map((b) => [b.prayer, mins(b.start), b.minutes]),
          })),
        });
      }
      if (p === '/api/stateless' && method === 'POST') {
        const body = await readJson(req);
        const settings = normalizeSettings(body.settings, { requireLocation: true });
        const payload = Buffer.from(JSON.stringify(settings)).toString('base64url');
        if (payload.length > MAX_STATELESS) throw new HttpError(413, 'Too many settings for a stateless link — save the feed instead.');
        return json(res, 200, subscribeUrls(baseUrl(req), `/s/${payload}.ics`, settings.feed.name));
      }
      if (p === '/api/feeds' && method === 'POST') {
        limit(`create:${ip}`, 30, 3_600_000);
        const body = await readJson(req);
        const settings = normalizeSettings(body.settings, { requireLocation: true });
        const { editToken, row } = db.create(settings);
        return json(res, 201, feedResponse(row, baseUrl(req), editToken));
      }
      if (p === '/api/feed') {
        limit(`manage:${ip}`, 240, 60_000);
        const { row, editToken } = requireEdit(req);
        if (method === 'GET') return json(res, 200, feedResponse(row, baseUrl(req), editToken));
        if (method === 'PUT') {
          const body = await readJson(req);
          if (body.revision !== undefined && body.revision !== row.revision) {
            throw new HttpError(409, 'This feed was changed elsewhere (for example from the travel page). Reload to see the latest settings.', { revision: row.revision });
          }
          const settings = normalizeSettings(body.settings, { requireLocation: true });
          db.update(row.id, settings);
          return json(res, 200, feedResponse(db.byFeedToken(row.feed_token), baseUrl(req), editToken));
        }
        if (method === 'DELETE') {
          db.remove(row.id);
          return json(res, 200, { deleted: true });
        }
      }
      if (p === '/api/feed/travel' && method === 'POST') {
        limit(`manage:${ip}`, 240, 60_000);
        const { row, editToken } = requireEdit(req);
        const body = await readJson(req);
        const next = structuredClone(row.settings);
        if (body.mode === 'trip') {
          const loc = body.location;
          const zone = loc && typeof loc.timezone === 'string' ? loc.timezone : next.location.timezone;
          const from = body.from || DateTime.now().setZone(zone).toISODate();
          next.trips = [...(next.trips || []), { id: `trip-${Date.now().toString(36)}`, label: body.label || '', from, to: body.to || from, location: loc }];
        } else if (body.mode === 'home') {
          next.location = body.location;
        } else if (body.mode === 'clear-trips') {
          next.trips = [];
        } else {
          throw new HttpError(400, 'mode must be "home", "trip" or "clear-trips".');
        }
        const settings = normalizeSettings(next, { requireLocation: true });
        db.update(row.id, settings);
        return json(res, 200, feedResponse(db.byFeedToken(row.feed_token), baseUrl(req), editToken));
      }
      if (p === '/api/feed/rotate' && method === 'POST') {
        limit(`manage:${ip}`, 30, 60_000);
        const { row, editToken } = requireEdit(req);
        db.rotateFeedToken(row.id);
        return json(res, 200, feedResponse(db.byEditToken(editToken), baseUrl(req), editToken));
      }
      throw new HttpError(404, 'Unknown API route.');
    }

    // ---- Pages & static assets ------------------------------------------
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (p === '/' || p === '/manage' || p === '/index.html') return serveStatic(req, res, 'index.html');
    if (p === '/travel') return serveStatic(req, res, 'travel.html');
    let rel;
    try {
      rel = decodeURIComponent(p).replace(/^\/+/, '');
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.includes('..')) throw new HttpError(404, 'Not found');
    return serveStatic(req, res, rel);
  }

  return async function handler(req, res) {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof SettingsError) json(res, 400, { error: 'Please check your settings.', issues: err.issues });
      else if (err instanceof HttpError) {
        const headers = err.extra.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
        const wantsJson = req.url.startsWith('/api/') || !String(req.headers.accept || '').includes('text/html');
        if (wantsJson) json(res, err.status, { error: err.message, ...err.extra }, headers);
        else {
          res.writeHead(err.status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
          res.end(err.message);
        }
      } else {
        console.error(err);
        json(res, 500, { error: 'Something went wrong on our side.' });
      }
    } finally {
      if (config.log) {
        // Tokens are capabilities: never write them to logs.
        const safe = req.url.replace(/f_[A-Za-z0-9_-]+/g, 'f_…').replace(/\/s\/[A-Za-z0-9_-]+/, '/s/…').split('?')[0];
        console.log(`${new Date().toISOString()} ${req.method} ${safe} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  };
}
