-- HM Variance Tracker — Cloudflare D1 schema (database: hm-variance-db)

-- One row per uploaded variance report (a date range, e.g. 1–24 Oct 2026)
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,          -- "2026-10-01_2026-10-24"
  label       TEXT NOT NULL,
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,
  file_name   TEXT,
  row_count   INTEGER,
  meta        TEXT,                      -- JSON summary (totals, stores, …)
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The parsed report, gzip-compressed and split into chunks (D1 rows are size-limited)
CREATE TABLE IF NOT EXISTS report_chunks (
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  data      BLOB NOT NULL,
  PRIMARY KEY (report_id, idx)
);

-- Branch → area manager → regional manager (from "UPDATED Span of control (Store Level)")
-- Empty table = the built-in mapping in data/default-mapping.js is used.
CREATE TABLE IF NOT EXISTS mapping (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  rows       TEXT NOT NULL,              -- JSON array [{code, branch, am, rm}]
  source     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Area manager follow-up remarks on a branch / item (visible to admin)
CREATE TABLE IF NOT EXISTS remarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  TEXT,
  branch     TEXT NOT NULL,
  item       TEXT,
  author     TEXT NOT NULL,
  remark     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open', -- open | resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS remarks_branch ON remarks(branch);
