# Waqt — dynamic prayer-time calendar blocker

A small web app that gives you a **calendar subscription link** (`webcal://…/cal/<token>.ics`) for Outlook, Google Calendar or Apple Calendar. The feed blocks your prayers as **Busy** during working hours. Every day is recalculated from your coordinates and your IANA timezone, so the blocks stay right after every clock change (CET ↔ CEST, GMT ↔ BST, EST ↔ EDT…) and when you travel. Your work account never grants this app any access (no OAuth).

It implements the proposal in [`dynamic_prayer_time_calendar_blocker_proposal.md`](dynamic_prayer_time_calendar_blocker_proposal.md).

## Run it

Requires **Node.js 22.12+** (it uses the built-in `node:sqlite`, so there are no native modules to compile).

```powershell
npm install
npm start            # http://127.0.0.1:8787
```

On this Windows machine Node 22 lives in nvm, so use the wrappers, which put it on the PATH:

```powershell
scripts\dev.cmd      # auto-restarts when src/ changes
```

```powershell
scripts\start.cmd
```

Then open <http://localhost:8787>. Click **Start from the Munich example**, or search for your city, then **Create my calendar feed**.

### Subscribing for real

Google Calendar and Outlook on the web fetch the feed **from their own servers**, so the app must be reachable on a public `https://` address. On `localhost`, Apple Calendar, Outlook desktop on the same computer and the `.ics` download work; the page tells you when this applies.

To go public, deploy it (Docker below) and set `PUBLIC_BASE_URL`. For a quick try without a server: `cloudflared tunnel --url http://localhost:8787` and start the app with `TRUST_PROXY=1`. Quick-tunnel URLs change on every restart, so subscriptions made through one stop working.

## What it does

| Feature | How |
| --- | --- |
| Location & authority | Offline city search (64,719 places from GeoNames, incl. alternate and Arabic names like `ميونخ`), raw `lat, lon`, or browser geolocation. 14 methods (MWL, ISNA, Moonsighting Committee, Egyptian, Karachi, Umm al-Qura, Dubai, Kuwait, Qatar, MUIS, Diyanet, Tehran, UOIF, custom angles), Shafi'i or Hanafi Asr, high-latitude rule, per-prayer minute adjustments. |
| DST | Each day is computed on its own: adhan's solar times → that date's offset in the IANA zone (Luxon/ICU). Coordinates → timezone via `tz-lookup`. |
| Durations & buffers | Per prayer: on/off, start offset from the adhan (negative = earlier), length. |
| Work-hours filter | Start/end, workdays, and a fit rule (whole block inside / starts inside / any overlap). Overnight shifts (e.g. 22:00–06:00) work. On days off: nothing, or every enabled prayer. |
| Jumu'ah | Replaces Dhuhr on Fridays: relative to Dhuhr, a fixed time, or separate **summer-time/winter-time** slots (summer = DST at that place, so it also works in the southern hemisphere). |
| Privacy & status | Custom title, or the prayer name, or both. `TRANSP:OPAQUE` (Busy) or Free, `CLASS:PRIVATE`, Outlook busy-status hints, optional reminder, notes none/generic/detailed. |
| Travel | Planned trips (date range + place) are calculated in that place's timezone ahead of time. A phone-friendly **travel link** adds "until Friday" trips or moves your home location. The subscription URL never changes. |
| Feed | RFC 5545, CRLF, 75-octet folding (UTF-8 safe), stable UIDs, `SEQUENCE` = settings revision, `REFRESH-INTERVAL`/`X-PUBLISHED-TTL` = 12 h, ETag/304. Times as **UTC** (default, works the same everywhere) or **TZID + VTIMEZONE**. |
| Feed window | 7 days back to 90 days ahead by default (configurable). |
| Sync status | The manage page shows which calendar app last fetched the feed and when. |

### VTIMEZONE generation

In TZID mode each zone used gets a VTIMEZONE derived from the live tz database. When the zone's transitions follow a yearly rule, the compact form Outlook prefers is used (for example `RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU` for Europe). That rule is derived from, and verified against, every real transition within about 400 days of the feed window. Irregular zones fall back to explicit observances. The tests parse the output with Mozilla's `ical.js` and check that TZID and UTC feeds resolve to identical instants across clock changes in Berlin, New York, Sydney and Jerusalem.

## The proposal's Munich example, computed

Munich (48.1351 N, 11.5820 E, `Europe/Berlin`), MWL, 09:00–18:00. Dhuhr and Asr: 20 min, starting 5 min after the adhan. Maghrib: 15 min at the adhan. Jumu'ah: 60 min, 13:15 in summer time and 12:15 in winter time.

| Day (2026) | Waqt output | Proposal text |
| --- | --- | --- |
| Mon 15 Jun (CEST) | Dhuhr **13:20–13:40**, Asr **17:35–17:55**, Maghrib 21:16 omitted | 13:20–13:40, 17:25–17:45, Maghrib 21:17 omitted |
| Fri 23 Oct (CEST) | **Jumu'ah 13:15–14:15** (summer slot), Asr 15:45–16:05, Maghrib 18:10 omitted | Dhuhr 12:59–13:19, Asr 15:52–16:12, Maghrib 18:12 omitted |
| Mon 26 Oct (CET) | Dhuhr **12:04–12:24**, Asr **14:41–15:01**, **Maghrib 17:05–17:20 included** | 11:59–12:19, 14:48–15:08, 17:06–17:21 |
| Fri 30 Oct (CET) | **Jumu'ah 12:15–13:15** (winter slot) | 12:15–13:15 |

Every behaviour in the proposal holds: Maghrib is dropped in summer and joins the workday after the clocks go back, and Jumu'ah moves to its winter slot. The minutes differ for three reasons:

- 23 Oct 2026 is a Friday, so Dhuhr becomes Jumu'ah.
- The proposal's own "+5 min after the adhan" wasn't applied to its Oct 26 Dhuhr (adhan 11:59, block 12:04).
- Its Asr numbers are a few minutes off. Our Asr is checked against an independent NOAA solar-position solve and is within 2 minutes on every reference day.

## Accuracy checks

`npm test` runs 93 tests (Node's built-in runner):

- **engine**: the proposal scenario above, DST jumps (local −60 min, UTC unchanged), exact transition instants, fit modes, overnight shifts, days off, every Jumu'ah mode (incl. Sydney and no-DST zones), trips, and polar days in Tromsø.
- **reference**: 22 days in Munich, London, New York, Sydney and Makkah, including days on each side of the clock changes, compared with the AlAdhan API (stored in `test/fixtures/aladhan.json`; refresh with `npm run data:reference`). Plus an independent Asr solve from the NOAA equations. Fajr and Isha are compared only below 45° latitude, because above that the services apply different high-latitude rules by design.
- **ics**: folding, escaping, headers, Busy/Free, reminders, UID stability, TZID vs UTC instant equality via `ical.js`, and VTIMEZONE rules for Berlin, New York and Riyadh.
- **api**: the whole lifecycle over real HTTP (create → subscribe → ETag 304 → travel → edit with conflict detection → rotate the feed address → delete), auth errors, validation, stateless links, geocoding, static files and security headers.

## Privacy & security model

- No accounts or e-mail. A feed has two capabilities:
  - the **feed token** (read-only; it goes into your calendar)
  - the **manage key** (edit). Only its SHA-256 hash is stored, so a copied database can't be used to edit feeds.
- The manage key travels in the URL **fragment** (`/manage#k=…`). Browsers never send fragments to the server, and the API receives it as a `Bearer` header.
- Logs redact feed tokens. City search runs on the server from a local dataset, so queries never go to a third party. Fonts are self-hosted.
- Strict CSP (`default-src 'self'`, no inline script or style), `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. Rate limits per IP. Request bodies are capped at 64 KB. Text fields are stripped of control characters so they can't inject iCalendar lines.
- "Issue new address" rotates the feed token if a link leaks. Delete removes the feed.
- A **stateless link** (`POST /api/stateless` → `/s/<base64>.ics`) encodes the settings in the URL and stores nothing, at the cost of a new link whenever settings change.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `PUBLIC_BASE_URL` | — | Public origin used in subscription links, e.g. `https://prayer.example.com` |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-*` (set `1` behind a reverse proxy or tunnel) |
| `DB_PATH` | `data/waqt.db` | SQLite file |
| `CITIES_PATH` | `data/cities.json` | City index (rebuild with `npm run data:cities`) |
| `LOG` | `1` | Request log (tokens redacted); `0` to disable |

## Deploy

```powershell
docker compose up -d --build
```

Put it behind HTTPS (Caddy, nginx or Cloudflare) and set `PUBLIC_BASE_URL` and `TRUST_PROXY=1` (see `.env.example`). Feeds live in the `waqt-data` volume, so back up `/data/waqt.db`. The Dockerfile is the standard `node:22-alpine` layout but hasn't been built on this machine, because the WSL Docker daemon wasn't running.

## API

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /cal/{feedToken}.ics` | feed token | The subscription feed (`?download=1` to save a file) |
| `GET /s/{payload}.ics` | — | Stateless feed |
| `POST /api/feeds` | — | Create `{settings}` → URLs + manage key |
| `GET/PUT/DELETE /api/feed` | `Bearer k_…` | Read / update (`{settings, revision}`, 409 on conflict) / delete |
| `POST /api/feed/travel` | `Bearer k_…` | `{mode: "trip"\|"home"\|"clear-trips", location, from?, to?}` |
| `POST /api/feed/rotate` | `Bearer k_…` | New feed token |
| `POST /api/preview` | — | `{settings, from?, days≤62}` → computed days |
| `POST /api/year` | — | `{settings, year?}` → daily times for the chart |
| `POST /api/stateless` | — | `{settings}` → stateless URLs |
| `GET /api/geo/search?q=` · `GET /api/geo/reverse?lat=&lon=` | — | Offline geocoding |
| `GET /api/meta` · `GET /healthz` | — | Methods, defaults, example · health |

## Project layout

```
src/        engine.js (scheduling), ics.js + vtimezone.js + tz.js (iCalendar), settings.js (validation),
            methods.js, geo.js, db.js (node:sqlite), app.js (HTTP), server.js (entry)
public/     index.html (setup + manage), travel.html, css/, js/ (no build step), fonts/
data/       cities.json (generated, committed), waqt.db (runtime, ignored)
scripts/    build-cities.mjs, fetch-reference.mjs, dev.cmd, start.cmd
test/       node:test suites + AlAdhan fixture
```

## Credits

- Prayer times: [adhan-js](https://github.com/batoulapps/adhan-js) (MIT).
- Timezones: [Luxon](https://moment.github.io/luxon/) (MIT) and [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup) (CC0).
- Places: [GeoNames](https://www.geonames.org/) (CC BY 4.0).
- Fonts: Instrument Sans and Noto Naskh Arabic (SIL OFL 1.1, see `public/fonts/LICENSE-fonts.txt`).

Always check the times against your local mosque and use the minute adjustments to match its timetable.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party data and fonts keep their own licenses, listed under Credits.
