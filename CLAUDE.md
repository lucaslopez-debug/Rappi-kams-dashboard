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

**Supabase client:** `lib/supabase.js` exports a lazily-instantiated singleton (`getSupabase()` / `supabase`) using the `NEXT_PUBLIC_*` anon-key env vars, for use in client components. The `Scripts/` sync jobs instead use `SUPABASE_URL`/`SUPABASE_KEY` (service credentials) via `dotenv`, since they run outside the Next.js runtime.

**Frontend data loading:** `app/page.js` is a client component (`'use client'`) that fetches all `kams` and paginates through `weekly_data` in three chunked `.range()` queries (Supabase's default page size caps a single query around ~1000 rows) before merging and handing everything to `KamDashboard`.

**`KamDashboard.js`** owns essentially all dashboard logic — week selection, WoW % calculations, top/bottom-10 brand ranking, category filtering — as memoized derivations over the full `weeklyData` array passed down from `page.js` rather than via separate queries. Note it only ever operates on rows where `brand_name === 'TOTAL_KAM'` (the per-KAM aggregate written by the sync script); per-brand rows are read but not surfaced in the current UI except via the top/bottom brand tables. Valid week labels are hardcoded in a `fechaOrder` array (e.g. `'22 Jun'`) in two places in this file — extend that list when new weeks are added to the sheet.

## Environment variables

Required in `.env.local` (see `test.js` for a connectivity check against these):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — used by the Next.js app (`lib/supabase.js`)
- `SUPABASE_URL`, `SUPABASE_KEY` — used by the `Scripts/` sync jobs (service-role key)
- `GOOGLE_TYPE`, `GOOGLE_PROJECT_ID`, `GOOGLE_PRIVATE_KEY_ID`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_SHEETS_ID` — Google service-account credentials and target spreadsheet ID for `Scripts/sync-sheets.js`

**`.gitignore` currently only excludes `node_modules`** — `.env.local` (which holds live Supabase and Google service-account credentials) is not ignored. No commits exist yet in this repo, so nothing has leaked, but add `.env.local` to `.gitignore` before the first commit.
