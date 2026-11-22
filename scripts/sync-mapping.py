"""HM Variance Tracker — daily store mapping sync (run by a Claude scheduled task).

Reads the "UPDATED Span of control (Store Level)" sheet "New" as returned by the Microsoft 365
connector (tab-separated text) and rewrites public/data/default-mapping.js when Area Manager / ROM /
store names changed. Pushing that file to main redeploys the app on Cloudflare.

usage: python3 -I scripts/sync-mapping.py span.txt public/data/default-mapping.js
prints CHANGES: N (0 = file left untouched); REFUSED: ... and exit 2 when the input looks wrong."""
import json, re, sys
from datetime import datetime, timezone

def refuse(m): print("REFUSED: " + m); sys.exit(2)
def sheet_rows(text, sheet):
    m = re.search(r"^## Sheet: " + re.escape(sheet) + r"\b.*$", text, re.M)
    if not m: return None
    rows = []
    for line in text[m.end():].splitlines()[1:]:
        if line.startswith(("## Sheet:", "Formulas:", "[Sheets ")): break
        if line.strip(): rows.append([c.strip() for c in line.split("\t")])
    return rows
def col(h, *names):
    h = [re.sub(r"\s+", " ", x).upper().strip() for x in h]
    for n in names:
        if n in h: return h.index(n)

# same code fixes as the Wastage Tracker sync (rows whose B-code in the file is missing or wrong)
FIX = {"TAIF SHIFA": "B118", "SAUDI INVESTMENT BANK": "B11", "AL RAJHI BANK": "B05", "ABHA DABAB": "B74", "AL AHSA 2": "B76"}
norm = lambda c: "B" + str(int(c[1:])) if re.match(r"^B\d+$", c) else c   # B01 == B1
tidy = lambda s: re.sub(r"\s+", " ", (s or "").replace("‬", "").replace("‪", "")).strip()

if len(sys.argv) != 3: refuse("usage: sync-mapping.py SPAN.txt default-mapping.js")
span_path, js_path = sys.argv[1], sys.argv[2]
rows = sheet_rows(open(span_path, encoding="utf-8").read(), "New")
if not rows: refuse('sheet "New" not found in ' + span_path)
hdr = rows[0]
ib, ia, ir = col(hdr, "BRANCH NAME", "BRANCH"), col(hdr, "AREA MANAGER"), col(hdr, "REGIONAL MANAGER", "ROM")
if None in (ib, ia, ir): refuse("span headers changed: " + " | ".join(hdr))
new, seen, skipped = [], set(), []
for r in rows[1:]:
    r = r + [""] * (len(hdr) - len(r))
    name = tidy(r[ib])
    if not name: continue
    m = re.match(r"^B\s*(\d{1,3})\b", name, re.I)
    branch = re.sub(r"^B\s*\d+\s*[-–,]?\s*", "", name, flags=re.I).strip()
    code = FIX.get(branch.upper()) or ("B" + m.group(1) if m else "")   # kept as written, e.g. B01
    if not code: skipped.append(name); continue
    if norm(code) in seen: skipped.append(name + " (code listed twice)"); continue
    seen.add(norm(code))
    new.append({"code": code, "branch": branch, "am": tidy(r[ia]), "rm": tidy(r[ir])})
if len(new) < 50: refuse(f"only {len(new)} stores in the file (expected about 100)")

js = open(js_path, encoding="utf-8").read()
mb = re.search(r"^window\.DEFAULT_BRANCHES=(\[.*\]);?\s*$", js, re.M)
if not mb: refuse("DEFAULT_BRANCHES line not found in " + js_path)
old = {norm(x["code"]): x for x in json.loads(mb.group(1))}
if len(new) < 0.5 * len(old): refuse(f"file has {len(new)} stores, the app has {len(old)}")
changes = []
for x in new:
    o = old.get(norm(x["code"]))
    if not o: changes.append(f'{x["code"]} {x["branch"]}: new store (AM {x["am"]}, ROM {x["rm"]})'); continue
    for k, lbl in (("am", "Area Manager"), ("rm", "ROM"), ("branch", "name")):
        if (o.get(k) or "") != x[k]: changes.append(f'{x["code"]} {x["branch"]}: {lbl} {o.get(k) or "-"} -> {x[k]}')
gone = [f'{c} {o.get("branch", "")}' for c, o in old.items() if c not in seen]
changes += [f"{g}: no longer in the file (removed)" for g in gone]
print(f"STORES: {len(new)}")
print(f"CHANGES: {len(changes)}")
for c in changes: print("  " + c)
if skipped: print("SKIPPED ROWS (no store code): " + "; ".join(skipped))
if not changes: sys.exit(0)

now = datetime.now(timezone.utc)
header = ("/* Built from SharePoint \"UPDATED Span of control (Store Level)\" (sheet New), "
          + now.strftime("%d %b %Y") + " — updated automatically by the daily store mapping sync.\n"
          "   Code fixes (same as the Wastage Tracker sync): Taif Shifa B118, Saudi Investment Bank B11, Al Rajhi Bank B05, Abha Dabab B74, Al Ahsa 2 B76.\n"
          "   BRANCHES: branch code -> branch, area manager, regional manager (ROM).\n"
          "   STORAGE_ALIASES: storage names in the variance report that carry no B-code. */\n")
body = js[js.index("*/") + 3:] if js.startswith("/*") else js
body = re.sub(r"^window\.DEFAULT_MAPPING_DATE=.*\n", "", body, flags=re.M)
body = body.replace(mb.group(0), "window.DEFAULT_BRANCHES=" + json.dumps(new, ensure_ascii=False) + ";", 1)
body = "window.DEFAULT_MAPPING_DATE=" + json.dumps(now.strftime("%Y-%m-%dT%H:%M:%SZ")) + ";\n" + body.lstrip("\n")
open(js_path, "w", encoding="utf-8").write(header + body)
print("UPDATED " + js_path)
