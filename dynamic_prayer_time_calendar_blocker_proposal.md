# Project Proposal: Dynamic Prayer Time Calendar Blocker

## 1. Problem Statement

Observant professionals need dedicated daily time blocks for prayers during working hours. Because Islamic prayer times are calculated astronomically based on solar position and geographic coordinates, they shift by several minutes every day and jump abruptly by a full hour during Daylight Saving Time (DST) transitions (such as the European switch between **CEST** in summer and **CET** in winter) or business travel. Standard recurring calendar events (e.g., "Daily at 1:00 PM") quickly become inaccurate, leading to double-bookings, scheduling conflicts with teammates, or tedious manual calendar maintenance.

## 2. Proposed Solution

A lightweight, privacy-first web platform that generates a dynamic, customizable **iCalendar (`.ics`) subscription feed** (`webcal://`) tailored to the user's location, IANA timezone, and workplace schedule preferences. Instead of importing a static file or granting invasive third-party read/write access to a corporate account, users subscribe to a live URL in their enterprise calendar (Google Workspace, Microsoft Outlook, or Apple Calendar) that automatically updates daily prayer blocks, seamlessly adapts to winter/summer time shifts, and sets their availability status to **Busy**.

## 3. Core Features & Configuration

* **Location & Calculation Authority:** Users input their city or GPS coordinates and select their regional calculation method (e.g., Muslim World League, ISNA, Umm al-Qura) and juristic school (Standard/Shafi'i or Hanafi for Asr).

* **Automatic DST & Winter/Summer Time Handling (e.g., CET $\leftrightarrow$ CEST):** Automatically resolves coordinates to an IANA timezone (e.g., `Europe/Berlin`, `Europe/London`, `America/New_York`). When clocks fall back or spring forward, the generated `.ics` feed dynamically recalculates each day's UTC offset so events never drift by an hour across DST boundaries.

* **Per-Prayer Duration & Buffers:** Customizable duration for each prayer to account for preparation (*Wudu*) and congregation time, plus optional pre/post buffers (e.g., start 5 minutes after *Adhan*, last 20 minutes).

* **Work-Hours Filtering:** Ability to sync only prayers that fall within working hours (e.g., 09:00–17:30) so non-work prayers (*Fajr*, *Isha*, or late summer *Maghrib*) do not clutter the corporate calendar, while automatically bringing *Maghrib* and *Asr* into view during short winter days.

* **Jumu'ah (Friday) Override with Seasonal Rules:** Dedicated configuration for Friday midday prayer, supporting either a fixed local time, a solar-relative time (e.g., +15 minutes after Friday *Dhuhr*), or dual **Summer (CEST) / Winter (CET)** fixed times to match local mosques that shift their Friday sermon by an hour in winter.

* **Privacy & Status Controls:** Users can customize the event title (e.g., "Prayer", "Personal Block", or "Focus Time") and set calendar transparency to `OPAQUE` (shows as **Busy** to teammates).

* **Travel / Timezone Quick-Switch:** Ability to update location via a simple personal link without changing the underlying `webcal://` URL installed in the work calendar.

## 4. Concrete Usage Example (Including EU CEST $\rightarrow$ CET Transition)

**User Profile:** Software engineer based in Munich, working 09:00–18:00 local time.

* **Configuration:**

  * **Location & Timezone:** Munich, Germany ($48.1351^\circ\text{ N}, 11.5820^\circ\text{ E}$ — `Europe/Berlin`)

  * **Calculation Method:** Muslim World League (MWL)

  * **Dhuhr & Asr:** 20 minutes each (starts 5 minutes after *Adhan*)

  * **Maghrib:** 15 minutes (starts at *Adhan*)

  * **Jumu'ah (Friday Override):** 60 minutes — **13:15–14:15 in Summer (CEST)** / **12:15–13:15 in Winter (CET)**

  * **Visibility:** Event Title = `Focus / Personal Block`, Status = `Busy`

* **Resulting Calendar Feed Output Across Seasons & DST Boundary:**

  * **June 15 (Peak Summer — CEST / UTC+2):**
    * Blocks `13:20–13:40` (Dhuhr) and `17:25–17:45` (Asr).
    * *Maghrib* occurs at `21:17 CEST` and is **automatically omitted** because it falls outside the 09:00–18:00 workday window.

  * **October 23 (Late Summer Time, Just Before DST Ends — CEST / UTC+2):**
    * Blocks `12:59–13:19` (Dhuhr) and `15:52–16:12` (Asr).
    * *Maghrib* has now crept earlier into the workday at `18:12 CEST` (still just outside 18:00, so omitted).

  * **October 26 (First Monday of Winter Time — CET / UTC+1):**
    * Clocks have fallen back 1 hour over the weekend. The feed seamlessly shifts with `Europe/Berlin` (`CET`):
    * Blocks `11:59–12:19` (Dhuhr), `14:48–15:08` (Asr), and **automatically activates `17:06–17:21` (Maghrib)** because sunset now falls inside working hours.
    * Friday *Jumu'ah* automatically shifts to the winter slot (`12:15–13:15 CET`).

## 5. Competitive Landscape & How We Differentiate

Existing solutions fall into two categories, each with a critical flaw for enterprise users:

1. **OAuth-based Apps (e.g., Fajr Calendar, SalahSync):** Require users to grant read/write API access to their corporate Google or Microsoft accounts. **Enterprise IT security policies frequently block unverified third-party OAuth apps**, making these unusable in many companies.

2. **Basic `.ics` Generators (e.g., Salatak, Prayer-Calendar):** Generate simple subscription links or static files, bypassing IT blocks, but **lack workplace-specific and DST-aware logic** (they dump all 5 daily prayers into the calendar, suffer from 1-hour timezone drift across CEST/CET boundaries if generated with fixed UTC offsets, lack seasonal Friday *Jumu'ah* overrides, or fail to mark time as `Busy`).

### Feature Comparison Matrix

| Feature / Capability | **Our Proposed Platform** | **Fajr Calendar** (`fajrcalendar.com`) | **SalahSync** (`salahsync.app`) | **Salatak** (Open Source `.ics`) | **Prayer-Calendar** (`prayer-calendar.com`) |
| ----- | ----- | ----- | ----- | ----- | ----- |
| **Delivery Method** | Dynamic `.ics` Feed (`webcal://`) | OAuth API Sync | OAuth API Sync | Dynamic `.ics` Feed | Dynamic `.ics` Feed |
| **Bypasses Corporate IT OAuth Blocks** | **Yes** (Zero permissions needed) | No (Requires read/write OAuth) | No (Requires Google OAuth) | Yes | Yes |
| **Platform Compatibility** | **All** (Outlook, Google, Apple) | Google & Outlook | Google Only | All | All |
| **Native DST / Winter Time Handling (CET/CEST)** | **Yes** (Per-day IANA `TZID` + seasonal Jumu'ah) | Yes | Yes | Partial (Can drift if static UTC offset used) | Partial |
| **Custom Duration *Per Prayer*** | **Yes** (e.g., 20m Dhuhr, 15m Maghrib) | Yes | Limited | No (Fixed global duration) | No (Fixed global duration) |
| **Work-Hours Window Filtering** | **Yes** (Auto-includes winter Maghrib, hides summer) | Yes | Partial | No (Syncs all 5 prayers) | Partial (Manual toggle) |
| **Jumu'ah (Friday) Custom Override** | **Yes** (Summer/Winter mosque schedule support) | Basic | No | No | No |
| **Workplace Privacy Titles & `OPAQUE` Busy Flag** | **Yes** (Custom title + Busy status) | Yes | Yes | Basic ("Prayer Name" only) | Basic |
| **Dynamic Location Update (Same URL)** | **Yes** (Tokenized URL parameters) | Yes | Yes | Requires generating new URL | Requires generating new URL |

### Key Differentiators (Our Unique Value Proposition)

1. **Zero-Trust Enterprise Compatibility:** By using a standard `webcal://` RFC 5545 feed instead of OAuth, employees at strict corporations (banks, automotive, defense, enterprise tech) can use the tool immediately without requesting IT admin approval or exposing corporate calendar data.

2. **Flawless Winter/Summer Time (CET/CEST) Transitions:** Many basic `.ics` scripts calculate prayer times using a static UTC offset at the moment of generation, causing future events after the last Sunday of October or March to be off by 1 hour. Our engine computes each future day's astronomical solar time independently against the IANA timezone database (`Europe/Berlin`, etc.) and supports dual winter/summer *Jumu'ah* schedules to match European mosque practices.

3. **Smart Seasonal Workday Filtering:** In central and northern Europe, winter days are short—*Dhuhr*, *Asr*, and *Maghrib* all compress into a ~5-hour afternoon window (`12:00–17:00 CET`) inside the standard workday. Our engine automatically brings *Maghrib* into the corporate calendar during winter time (CET) and drops it off during summer time (CEST) without any manual intervention.

4. **Asymmetric Prayer Durations & Offsets:** Recognizes that *Dhuhr* and *Asr* (4 *Rak'ahs*) or *Jumu'ah* require different time commitments than *Maghrib* (3 *Rak'ahs*), and allows offsets to match local mosque *Iqamah* times.

5. **Stateful URL for Travelers:** Users receive a persistent subscription token (e.g., `https://api.ourapp.com/cal/u_89234a.ics`). If they travel from Munich (`CET`) to London (`GMT`) or New York (`EST`), they update their city in a lightweight web dashboard, and the existing calendar feed updates automatically.

## 6. Technical Architecture & Standards

* **Calendar Protocol:** RFC 5545 (iCalendar specification). Events include `TRANSP:OPAQUE` (marks time as Busy) and `STATUS:CONFIRMED`.

* **Timezone & DST Precision (`VTIMEZONE` / UTC):**
  * Each day in the rolling 90-day window is calculated using the local date and the target IANA timezone (e.g., `Europe/Berlin`).
  * Timestamps in the `.ics` output are emitted either in strict UTC (`DTSTART:20261026T105900Z`) calculated per-day *after* applying that specific date's DST rule (UTC+1 for CET vs. UTC+2 for CEST), or with explicit `TZID=Europe/Berlin` accompanied by a standard RFC 5545 `VTIMEZONE` block defining the `DAYLIGHT` (CEST) and `STANDARD` (CET) transition rules (`RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU`). This guarantees Outlook, Google Calendar, and Apple Calendar render the exact local time even across the March/October clock-change weekends.

* **Delivery Mechanism & Caching:** A token-backed HTTP endpoint returning `Content-Type: text/calendar; charset=utf-8` with `REFRESH-INTERVAL;VALUE=DURATION:PT12H` and `X-PUBLISHED-TTL:PT12H` headers so enterprise calendar clients regularly poll for updates.

## 7. Recommended Data Sources & Libraries

* **Astronomical Calculation Libraries (`batoulapps/adhan`):** Open-source, offline astronomical calculation libraries available in JavaScript (`adhan-js`), Python (`adhan-python`), Go, Swift, and Kotlin. Using this directly on our server eliminates external API latency and third-party rate limits.

* **Timezone Resolution (`tz-lookup` / `Luxon` / `zoneinfo`):** Maps GPS coordinates to IANA timezone identifiers (e.g., `48.1351, 11.5820` $\rightarrow$ `Europe/Berlin`) and accurately resolves historical and future CET/CEST transition dates.

* **AlAdhan REST API (`aladhan.com/prayer-times-api`):** Free REST API providing prayer timings by coordinates or city, supporting 20+ calculation authorities and automatic IANA timezone alignment—useful for rapid prototyping or geocoding fallback.

* **iCalendar Generators:** `ical-generator` (Node.js/TypeScript) or `icalendar` (Python) with `@touch4it/ical-timezones` for compliant RFC 5545 `VTIMEZONE` feed generation.