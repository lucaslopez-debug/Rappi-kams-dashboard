# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Next.js 14 (App Router) dashboard that shows weekly KAM (Key Account Manager) performance metrics for Rappi — orders and markdown/GMV, week-over-week comparisons, and top/bottom brand rankings. Data lives in Supabase (`kams` and `weekly_data` tables) and is refreshed by a standalone sync script that pulls from a Google Sheet via a Google service-account.

There are effectively two halves to this repo:
- **The web app** (`app/`, `components/`, `lib/`) — reads from Supabase and renders the dashboard.
- **The sync pipeline** (`Scripts/`) — a set of one-off Node scripts (run manually, not from the web app) that push data from Google Sheets into Supabase.

## Commands

```bash
npm run dev      # start Next.js dev server
npm run build    # production build
npm run start    # run production build
npm run sync     # run Scripts/sync-sheets.js — pulls the Google Sheet and upserts weekly_data into Supabase
```

Other scripts are run directly with Node, not through npm:
```bash
node Scripts/insert-kams.js   # (re)seeds the kams table from the hardcoded KAMS list
node test.js                  # sanity-checks .env.local vars and the Supabase connection
```

Note: `package.json`'s `sync` script points at `scripts/sync-sheets.js` (lowercase) while the directory on disk is `Scripts/` (capital S). This only works because Windows filesystems are case-insensitive — keep that in mind if this project is ever built/deployed on a case-sensitive filesystem (Linux CI, Vercel, etc.).

There is no test suite or linter configured in this project.

## Architecture

**Data flow:** Google Sheet ("dashboard weekly" tab) → `Scripts/sync-sheets.js` (Google Sheets API, service-account auth) → Supabase `weekly_data` table → Next.js app (`app/page.js`, client-side fetch via `lib/supabase.js`) → `components/KamDashboard.js` (all filtering/aggregation/rendering).

**Sync script specifics** (`Scripts/sync-sheets.js`): the sheet has a fixed, position-based layout that the script depends on — row 8 (index 7) holds week-ending dates, data rows start at row 10 (index 9), columns G–N hold `orders` per week, columns P–W hold `markdown` per week, column F holds the KAM's email, column B the brand name. The script only recognizes KAMs present in the hardcoded `KAMS_MAP`/`KAMS` objects (duplicated between `sync-sheets.js` and `insert-kams.js` — update both if the KAM roster changes). Only aggregated `TOTAL_KAM` rows are written per sync (existing `TOTAL_KAM` rows are deleted and reinserted); per-brand detail rows come from elsewhere/manually.

**Snowflake syncs** (`npm run sync:snowflake [availability|compensation|brandsWithMd]` → `Scripts/sync-snowflake.js`, connection in `lib/snowflakeClient.js`): one Snowflake connection runs all syncs, so browser login is approved once. Rappi's Snowflake is IP-restricted — it only works on the Rappi VPN ("IP ... is not allowed to access Snowflake" otherwise). These replaced every manual Excel import (no import buttons remain); the header shows a stacked sync-time chip per source instead.

**Cadence.** The main tabs compare week vs week, so the full sync (`npm run sync:snowflake`) runs only on Mondays 10:00 (Windows task "Rappi KAMs - Sync Snowflake"). Tue–Fri 10:00 the task "Rappi KAMs - Avances semanales" runs `npm run sync:snowflake avances`, which only writes the daily photo (`snapshotOnly`) for the Avances semanales tab and never touches the main tables. Both call `sync-snowflake-task.ps1` (log in `logs/snowflake-sync.log`). Any other mid-week full sync only when explicitly requested.

**Daily availability warnings** (`lib/availabilityDailySync.js` → `brand_availability_daily`, UI `components/AvailabilityWarnings.js`): same Snowflake source as the weekly availability sync but grouped per brand per DAY (sums of AVAILABLE_ / SHOULD_BE_AVAILABLE, stores, stores at 0), rewriting the last 15 days on every run (Snowflake restates past days) and pruning > 60 days. Verified: summing the days reproduces `brand_availability_status` exactly. Runs Mondays in the full sync and Tue–Fri inside the `avances` job. The UI flags, for the chosen day (default: latest = yesterday), brands at 0% (new vs. already-at-0 with a streak counter; closed days with no configured hours don't break the streak) and drops ≥ 20 pts vs. the previous 7 days' average (`DROP_THRESHOLD_PTS`).

**Weekly snapshots / "Avances and warnings" tab** (`components/AvancesWarningsPanel.js`, warnings on top, weekly Brands with MD progress below): Snowflake compensation data is month-to-date and overwritten daily, so each compensation / brandsWithMd sync also upserts a dated photo into `brand_compensation_weekly` (per brand) and `brands_md_weekly` (per KAM), keyed by `snapshot_date` (run date, Argentina time; a same-day rerun replaces that day's photo). The tab compares the latest photo against the most recent Monday photo before it (Tue–Fri: week-to-date vs this Monday; Monday: vs the previous Monday) and lists brands that entered / left markdown (MD archie ≥ 80%). The 2026-09-21 photo was backfilled from the last Excel import (Luciano Gelmi's brand detail is missing 2 brands that day; the tab warns when brand detail doesn't add up to the official KAM total). Both tables have RLS on with public read-only policies; only the sync (service key) writes.

**Brands with Markdown sync** (`lib/brandsWithMdSync.js`): writes `brand_markdown_status` (per-KAM `brands_md_result` / `brands_md_target`, feeds the ranking and the Brands with Markdown card) from `RP_GOLD_DB_PROD.RESTAURANTES_GLOBAL_MDA.DATA_ACHIEVEMENT_MONTH_COMPENSATION_BYKAM_HISTORICO_V1_Q4` (`COMERCIAL` = KAM email, `BRANDS_WITH_MD_RESULT`, `BRAND_WITH_MD_TGT`, latest MONTH). Verified: the result equals the count of the KAM's brands with `MD_ACHI_BRAND >= 0.8` in the compensation table.

**Compensation sync** (`lib/compensationSync.js`): replaces the old "Importar Compensation" Excel (MD archie final, used by Accionar Urgente). Reads `RP_GOLD_DB_PROD.RESTAURANTES_GLOBAL_MDA.DATA_ACHIEVEMENT_COMPENSATION_MONTH_RECOVERY_HISTORICO_Q4`, latest MONTH (month-to-date, overwritten daily — no intra-month history), AR, owner email in `kams`, and only brands with `TARGET_MES_MD > 0 AND GMV_USD > 0` (same inclusion rule as the old report). `MD_ACHI_BRAND` = (MD_USD / GMV_USD) / TARGET_MES_MD as a fraction; "final" = capped at 2. Stored in `brand_compensation_status.md_archie_final_pct` always as percentage points (0–200). The old Excel import only scaled values ≤ 1, so 100–200% brands were stored as 1.x — don't reintroduce that. `brand_key` is `COUNTRY_BRAND_ID` (e.g. `AR65117`).

**Availability sync** (`lib/availabilitySync.js`): replaces the old manual "Importar Availability" Excel. Reads Snowflake `RP_SILVER_DB_PROD.GLOBAL_REST_CATALOG.PP_AVAILABILITY_DASH_AVAILABILITY_DATASET` (the source behind the Power BI availability dashboard), country AR, filtered by the emails in the `kams` table, last 2 weeks (current week is week-to-date). The query returns SUM(AVAILABLE_) / SUM(SHOULD_BE_AVAILABLE) separately and the ratio is computed in JS — dividing in Snowflake rounds to 6 decimals and breaks exact parity with Power BI. Writes `brand_availability_status` using weekly_data's brand_id/brand_name/kam_id (the UI joins availability by normalized brand name within the active KAM), then deletes rows not touched by the run. Auth: `SNOWFLAKE_AUTHENTICATOR=externalbrowser` (personal login, needs browser approval) or `SNOWFLAKE_PRIVATE_KEY_PATH` (service user key-pair, required before this can run as a Vercel cron).

**Supabase client:** `lib/supabase.js` exports a lazily-instantiated singleton (`getSupabase()` / `supabase`) using the `NEXT_PUBLIC_*` anon-key env vars, for use in client components. The `Scripts/` sync jobs instead use `SUPABASE_URL`/`SUPABASE_KEY` (service credentials) via `dotenv`, since they run outside the Next.js runtime.

**Frontend data loading:** `app/page.js` is a client component (`'use client'`) that fetches all `kams` and paginates through `weekly_data` in three chunked `.range()` queries (Supabase's default page size caps a single query around ~1000 rows) before merging and handing everything to `KamDashboard`.

**App structure (KAM → sections):** `app/page.js` owns the active KAM and the active section. The KAM filter is portaled into the second row of the header (`#header-kam-tabs` in `app/layout.js`) and applies to every section. Below it, section tabs (`SECTIONS` in `page.js`) switch between topics: `markdown` renders `KamDashboard` (everything built so far), `tarjetas` renders `components/TarjetasPanel.js` (placeholder, in progress). Each new topic migrated into the app should be added as a new entry in `SECTIONS` with its own component receiving the active KAM.

**`KamDashboard.js`** (the Markdown section) receives `activeKam`/`onSelectKam` as props and owns essentially all dashboard logic — week selection, WoW % calculations, top/bottom-10 brand ranking, category filtering — as memoized derivations over the full `weeklyData` array passed down from `page.js` rather than via separate queries. Note it only ever operates on rows where `brand_name === 'TOTAL_KAM'` (the per-KAM aggregate written by the sync script); per-brand rows are read but not surfaced in the current UI except via the top/bottom brand tables. Valid week labels are hardcoded in a `fechaOrder` array (e.g. `'22 Jun'`) in two places in this file — extend that list when new weeks are added to the sheet.

## Environment variables

Required in `.env.local` (see `test.js` for a connectivity check against these):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — used by the Next.js app (`lib/supabase.js`)
- `SUPABASE_URL`, `SUPABASE_KEY` — used by the `Scripts/` sync jobs (service-role key)
- `GOOGLE_TYPE`, `GOOGLE_PROJECT_ID`, `GOOGLE_PRIVATE_KEY_ID`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_SHEETS_ID` — Google service-account credentials and target spreadsheet ID for `Scripts/sync-sheets.js`

**`.gitignore` currently only excludes `node_modules`** — `.env.local` (which holds live Supabase and Google service-account credentials) is not ignored. No commits exist yet in this repo, so nothing has leaked, but add `.env.local` to `.gitignore` before the first commit.
