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

## Branch → AM → RM
Built in from SharePoint *UPDATED Span of control (Store Level)* (sheet **New**), in
`data/default-mapping.js`. To refresh: **Update data → Upload Span of Control** (admin passcode).
Storages are linked to branches by their B-code, or by the name list in `STORAGE_ALIASES`.

## Cloudflare setup (one time)
1. D1 database **hm-variance-db** already exists with the tables from `schema.sql`.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick this repo.
   Build command: *(none)* · Build output directory: `/`
3. Project → **Settings → Bindings → Add → D1 database**: variable name `DB`, database `hm-variance-db`.
4. Project → **Settings → Variables and Secrets** (type *Secret*):
   - `VIEW_PASSWORD` – team password to open the dashboard
   - `ADMIN_PASSCODE` – admin passcode (upload, delete, mapping, read remarks)
5. **Deployments → Retry deployment** so the binding and secrets take effect.
