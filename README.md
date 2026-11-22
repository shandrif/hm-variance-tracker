# HM Variance Tracker

Inventory variance dashboard for Half Million Coffee. Upload the weekly/monthly
**Variance Report** (inventory reconciliation export, sheet `Data`) and see
shortages and surpluses by branch, area manager and regional manager.

Static front end (no build step) + Cloudflare Pages Functions + Cloudflare D1.

## What it does
- **Overview** – net variance, shortages, surpluses, branches in breach, weekly and daily charts, worst branches and items
- **Branches** – every branch with net / shortage / surplus / category split and a status (Breach, Watch, Normal, High surplus)
- **Weekly by branch** – week-by-week heat table with change vs last week
- **Items** – net qty (in its unit) and SAR per item, how many branches are short
- **Repeat shortages** – the same item short at the same branch again and again
- **Breaches** – branches beyond the limit per variance type; copy table / email via Outlook
- **Managers** – regional and area manager roll-ups
- **Typo check** – suspected typos (left out of totals), large entries, entries reversed within 3 days, unmatched storages
- **Remarks** – area managers add a remark per branch/item; only the admin can read them

Breach limit (auto) = average − 1.96 × spread of branch net variance in the period (can be overridden).
Suspected typo = quantity ≥ 1,000× the item's usual quantity **and** ≥ 10,000 SAR.

## Branch → Area manager → ROM (store mapping)
Every morning at **7:47 (Riyadh)** a Claude scheduled task (*Variance Tracker store mapping sync*) reads the SharePoint file
**UPDATED Span of control (Store Level)** (sheet *New*) with the Microsoft 365 connector and runs
`scripts/sync-mapping.py`. When an Area Manager, ROM or store changed, it updates `public/data/default-mapping.js`
and pushes it to `main`, and Cloudflare redeploys — so filtering and sorting by area manager and ROM follow the file.
On days with no change nothing is committed. A run stops without changing anything if the sheet's columns change,
fewer than 50 stores are found, or the file has less than half the stores the app has.

- The app uses the newest of: this daily mapping, or a mapping an admin uploaded (**Update data → Upload store mapping file**).
  **Use the daily SharePoint mapping** drops an uploaded one.
- Store codes are taken from the branch name ("B48 - MAAN PLAZA"); rows without a code (e.g. EVENT BR) are skipped.
  Same code fixes as the Wastage Tracker sync: Taif Shifa B118, Saudi Investment Bank B11, Al Rajhi Bank B05, Abha Dabab B74, Al Ahsa 2 B76.
- Storages in the variance report are linked to branches by their B-code, or by the name list in `STORAGE_ALIASES`.
- Optional, not needed: the Worker can also fetch a mapping file itself (`src/sharepoint.js`, cron in `wrangler.toml`)
  if a `SP_FILE_URL` secret is added in Cloudflare; without it, that part does nothing.

## Files
- `public/` – the website (HTML, CSS, JS, logo, mapping, libraries)
- `src/worker.js` – Cloudflare Worker: sends `/api/*` to `src/api.js`, everything else to `public/`
- `src/api.js` – reports, mapping and remarks stored in D1
- `src/sharepoint.js` – daily SharePoint download of the store mapping (cron in `wrangler.toml`)
- `public/span-parse.js` – reads a mapping workbook uploaded in the browser
- `scripts/sync-mapping.py` – daily sync: Span of Control text → `public/data/default-mapping.js`
- `wrangler.toml` – Worker name, static files folder and the D1 binding (`DB` → hm-variance-db)

## Cloudflare setup (one time)
1. D1 database **hm-variance-db** already exists with the tables from `schema.sql`.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
   Project name: `hm-variance-tracker` · Build command: *(empty)* · Deploy command: `npx wrangler deploy`
   (the D1 binding comes from `wrangler.toml` automatically).
3. Worker → **Settings → Variables and Secrets** → add two **Secrets**:
   - `VIEW_PASSWORD` – team password to open the dashboard
   - `ADMIN_PASSCODE` – admin passcode (upload, delete, mapping, read remarks)
4. Every push to `main` redeploys automatically.
