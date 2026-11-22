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
The mapping is read every morning at **8:00 (Riyadh)** from the SharePoint file **Master_Location_Mapping.xlsx**
and saved for everyone, so filtering and sorting by area manager and ROM always follow the latest file.
Admins can also run it any time: **Update data → Sync store mapping from SharePoint** (the last result is shown there).

- Columns are found by name: store/branch code, store/branch name, *Area Manager* (or AM), *ROM* (or Regional…).
  An *AOM / Area Operations Manager* column, if the file ever has one, adds an extra filter level.
- Safety: if the file suddenly lists less than half the stores it had before, it is not applied (the admin can apply it anyway).
  If the download fails, the previous mapping stays.
- Fallbacks: **Upload store mapping file** (same columns) or the built-in list in `data/default-mapping.js`.
- Storages are linked to branches by their B-code, or by the name list in `STORAGE_ALIASES`.

### SharePoint sync setup (one time, Cloudflare dashboard → Worker → Settings → Variables and Secrets)
1. Add a **Secret** `SP_FILE_URL` = the share link of Master_Location_Mapping.xlsx.
   (Kept as a secret because this repository is public.)
2. The link must be shared as **Anyone with the link can view**. If company policy only allows links for
   signed-in staff, ask IT for an Azure app registration with application permission *Files.Read.All*
   (or *Sites.Read.All*) and add three more secrets: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.
3. Open the dashboard as admin → **Update data → Sync store mapping from SharePoint** to test it.

## Files
- `public/` – the website (HTML, CSS, JS, logo, mapping, libraries)
- `src/worker.js` – Cloudflare Worker: sends `/api/*` to `src/api.js`, everything else to `public/`
- `src/api.js` – reports, mapping and remarks stored in D1
- `src/sharepoint.js` – daily SharePoint download of the store mapping (cron in `wrangler.toml`)
- `public/span-parse.js` – reads the mapping workbook (used by the browser upload and the daily sync)
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
