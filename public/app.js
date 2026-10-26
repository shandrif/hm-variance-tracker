/* HM Variance Tracker — static front end (Cloudflare Pages + D1 via /api) */
'use strict';
const $ = id => document.getElementById(id);
const API = '/api';
const DAY = 86400000;

/* ---------- formatting ---------- */
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const sar = v => (v < 0 ? '−' : v > 0 ? '+' : '') + nf0.format(Math.abs(Math.round(v)));
const sarPlain = v => (v < 0 ? '−' : '') + nf0.format(Math.abs(Math.round(v)));
const qty = (v, u) => (v < 0 ? '−' : v > 0 ? '+' : '') + nf2.format(Math.abs(v)) + ' ' + (u || '');
const cls = v => v < 0 ? 'neg' : v > 0 ? 'pos' : '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayISO = d => new Date(d * DAY).toISOString().slice(0, 10);
const dayLabel = d => new Date(d * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekStart = d => d - ((new Date(d * DAY).getUTCDay() + 6) % 7);   // Monday
const CAT_NAMES = { 'COGS FOOD': 'Food', 'COGS PACKAGING': 'Packaging', 'MUG': 'Mugs & Retail', 'COGS WATER': 'Water', 'CONSUMABLE': 'Consumables', 'STAFF WATER': 'Staff Water' };
const catName = t => { const k = String(t || '').trim().toUpperCase(); return CAT_NAMES[k] || (k ? k.charAt(0) + k.slice(1).toLowerCase() : 'Other'); };

/* ---------- state ---------- */
const state = {
  pass: null, role: null, offline: false,
  reports: [],          // list from server [{id,label,from_date,to_date,meta}]
  cache: {},            // id -> parsed report
  local: null,          // freshly uploaded, not yet published
  sel: '',              // selected report id ('' = all)
  branches: [], branchByCode: {}, mapSource: 'built-in',
  recs: [],             // active records (enriched)
  limitOverride: null,
  tab: 'overview', charts: {}, sort: {}, remarks: []
};
const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

/* ---------- API ---------- */
async function api(path, opts = {}, pass = state.pass) {
  const r = await fetch(API + path, { ...opts, headers: { 'X-Pass': pass || '', ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch (e) {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r;
}
async function gz(str) { return new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); }
async function gunz(buf) { return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); }

/* ---------- branch mapping ---------- */
const normCode = c => { const m = String(c || '').toUpperCase().match(/^B0*(\d+)$/); return m ? 'B' + m[1] : String(c || '').toUpperCase(); };
function setMapping(rows, source) {
  state.branches = rows.map(r => ({ ...r, code: normCode(r.code) }));
  state.branchByCode = Object.fromEntries(state.branches.map(b => [b.code, b]));
  state.mapSource = source || 'built-in';
  $('mapInfo').textContent = `Mapping: ${state.mapSource} · ${state.branches.length} branches`;
  storageCache.clear();
}
const aliasMap = Object.fromEntries(Object.entries(window.STORAGE_ALIASES || {}).map(([k, v]) => [k.toLowerCase(), v]));
const storageCache = new Map();
function matchStorage(name) {
  if (storageCache.has(name)) return storageCache.get(name);
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  let code = null;
  const m = s.match(/(?:^|[^A-Za-z0-9])B0*(\d{1,3})(?!\d)/i);
  if (m) code = 'B' + m[1];
  else {
    const base = s.replace(/\s*main\s*storag\w*\s*$/i, '').replace(/\s*storage\s*$/i, '').trim().toLowerCase();
    code = aliasMap[base] || null;
    if (!code) {   // try branch names from the mapping file
      const b = state.branches.find(b => b.branch && (b.branch.toLowerCase() === base || base.includes(b.branch.toLowerCase())));
      if (b) code = b.code;
    }
  }
  if (code) code = normCode(code);
  const b = code && state.branchByCode[code];
  const res = b ? { code, branch: titleCase(b.branch), am: b.am || 'Unassigned', rm: b.rm || 'Unassigned', mapped: true }
    : { code: code || '—', branch: s.replace(/\s*main\s*storag\w*\s*$/i, '').trim() || s, am: 'Unassigned', rm: 'Unassigned', mapped: false };
  storageCache.set(name, res);
  return res;
}
function titleCase(s) { return String(s).toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (a, p, c) => p + c.toUpperCase()).replace(/\b(Pnu|Stc|Riy|Jed)\b/g, w => w.toUpperCase()); }

const CODE_FIXES = { 'TAIF SHIFA': 'B118', 'SAUDI INVESTMENT BANK': 'B11', 'AL RAJHI BANK': 'B05', 'ABHA DABAB': 'B74', 'AL AHSA 2': 'B76' };
function parseSpan(aoa) {
  let h = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const r = aoa[i].map(x => String(x || '').toUpperCase());
    if (r.some(x => x.includes('AREA MANAGER')) && r.some(x => x.includes('BRANCH'))) { h = i; break; }
  }
  if (h < 0) throw new Error('Could not find the “BRANCH” and “AREA MANAGER” columns.');
  const hdr = aoa[h].map(x => String(x || '').toUpperCase().trim());
  const ci = f => hdr.findIndex(f);
  const cB = ci(x => x.startsWith('BRANCH')), cA = ci(x => x.startsWith('AREA MANAGER')),
    cR = ci(x => x.includes('REGIONAL') || x === 'ROM'), cC = ci(x => x === 'CODE' || x === 'BRANCH CODE');
  const rows = [];
  for (const r of aoa.slice(h + 1)) {
    const name = String(r[cB] || '').trim(); if (!name) continue;
    let code = cC >= 0 ? String(r[cC] || '').trim() : '';
    if (!code) { const m = name.match(/^B\s*0*(\d{1,3})/i); code = m ? 'B' + m[1] : ''; }
    const branch = name.replace(/^B\s*\d+\s*[-–,]?\s*/i, '').replace(/\s+/g, ' ').trim();
    code = CODE_FIXES[branch.toUpperCase()] || code;   // same fixes as the Wastage Tracker sync
    if (!code || rows.some(x => x.code === normCode(code))) continue;
    rows.push({ code: normCode(code), branch, am: String(r[cA] || '').replace(/\s+/g, ' ').trim(), rm: String(cR >= 0 ? r[cR] || '' : '').replace(/\s+/g, ' ').trim() });
  }
  if (!rows.length) throw new Error('No branch rows found.');
  return rows;
}

/* ---------- report parsing ---------- */
const COLS = {
  type: ['type'], code: ['code'], item: ['stock list'], um: ['u/m'], qty: ['quantity in meas. units', 'quantity'],
  unit: ['unit cost, sar.', 'unit cost'], cost: ['accounting cost, sar.', 'accounting cost'], group: ['stock list group'],
  comment: ['document comment'], date: ['document date'], recv: ['receiving storage'], woff: ['write-off storage'], t2: ['type 2']
};
function toDay(v) {
  if (typeof v === 'number') return Math.floor(v) - 25569;
  if (v instanceof Date) return Math.floor(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) / DAY);
  const s = String(v || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return Math.floor(Date.UTC(+m[1], m[2] - 1, +m[3]) / DAY);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/); if (m) return Math.floor(Date.UTC(+m[3], m[2] - 1, +m[1]) / DAY);
  const d = new Date(s); return isNaN(d) ? null : Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
function parseReport(wb, fileName) {
  let sheet = null, aoa = null, h = -1;
  const names = wb.SheetNames.slice().sort((a, b) => (b.toLowerCase() === 'data') - (a.toLowerCase() === 'data'));
  for (const n of names) {
    const a = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
    for (let i = 0; i < Math.min(a.length, 25); i++) {
      const r = (a[i] || []).map(x => String(x || '').toLowerCase().trim());
      if (r.some(x => x.startsWith('accounting cost')) && r.some(x => x.includes('storage'))) { sheet = n; aoa = a; h = i; break; }
    }
    if (sheet) break;
  }
  if (!sheet) throw new Error('This file has no inventory reconciliation data (looked for “Accounting cost” and “storage” columns).');
  const hdr = aoa[h].map(x => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim());
  const idx = {}; const missing = [];
  for (const [k, alts] of Object.entries(COLS)) {
    idx[k] = hdr.findIndex(x => alts.includes(x));
    if (idx[k] < 0 && k !== 'type') idx[k] = hdr.findIndex(x => alts.some(a => x.startsWith(a)));
    if (idx[k] < 0 && ['item', 'qty', 'cost', 'date'].includes(k)) missing.push(alts[0]);
  }
  if (missing.length) throw new Error('Missing columns: ' + missing.join(', '));
  const stores = [], sIdx = new Map(), items = [], iIdx = new Map();
  const cols = { d: [], s: [], i: [], q: [], v: [], k: [] };
  const issues = { noStore: 0, noDate: 0, noCost: 0 };
  for (let r = h + 1; r < aoa.length; r++) {
    const row = aoa[r]; if (!row) continue;
    const name = row[idx.item]; const v = +row[idx.cost];
    if (name == null && row[idx.cost] == null) continue;
    if (!isFinite(v)) { issues.noCost++; continue; }
    const d = toDay(row[idx.date]); if (d == null) { issues.noDate++; continue; }
    const type = String(row[idx.type] || '').toLowerCase();
    const recv = idx.recv >= 0 ? row[idx.recv] : null, woff = idx.woff >= 0 ? row[idx.woff] : null;
    const st = String((type.startsWith('receipt') ? recv || woff : woff || recv) || '').replace(/\s+/g, ' ').trim();
    if (!st) { issues.noStore++; continue; }
    if (!sIdx.has(st)) { sIdx.set(st, stores.length); stores.push(st); }
    const code = String(row[idx.code] ?? '').trim(), nm = String(name || '').replace(/\s+/g, ' ').trim();
    const key = code || nm;
    if (!iIdx.has(key)) {
      iIdx.set(key, items.length);
      items.push({ c: code, n: nm, u: idx.um >= 0 ? String(row[idx.um] || '') : '', g: idx.group >= 0 ? String(row[idx.group] || '').trim() : '', t: catName(idx.t2 >= 0 ? row[idx.t2] : '') });
    }
    const cm = String(idx.comment >= 0 ? row[idx.comment] || '' : '');
    const weekly = /week/i.test(cm) ? 1 : /dail|day/i.test(cm) ? 0 : (new Date(d * DAY).getUTCDay() === 1 ? 1 : 0);
    cols.d.push(d); cols.s.push(sIdx.get(st)); cols.i.push(iIdx.get(key));
    cols.q.push(+(+row[idx.qty] || 0).toFixed(4)); cols.v.push(+v.toFixed(2)); cols.k.push(weekly);
  }
  if (!cols.d.length) throw new Error('No variance lines found in the file.');
  const from = Math.min(...cols.d), to = Math.max(...cols.d);
  return { v: 1, file: fileName, sheet, from: dayISO(from), to: dayISO(to), stores, items, cols, issues, rows: cols.d.length };
}

/* ---------- build active records ---------- */
function expand(rep) {
  const out = [], c = rep.cols;
  for (let j = 0; j < c.d.length; j++) {
    const it = rep.items[c.i[j]];
    out.push({ d: c.d[j], st: rep.stores[c.s[j]], ic: it.c || it.n, n: it.n, u: it.u, g: it.g, cat: it.t, q: c.q[j], v: c.v[j], k: c.k[j] });
  }
  return out;
}
function activeReports() {
  if (state.local) return [state.local];
  if (state.sel) return state.cache[state.sel] ? [state.cache[state.sel]] : [];
  return state.reports.map(r => state.cache[r.id]).filter(Boolean);
}
function buildRecords() {
  const reps = activeReports();
  let recs = [];
  // combine reports, dropping duplicate days per storage if periods overlap
  const seen = new Set();
  for (const rep of reps) {
    const ex = expand(rep), days = new Set();
    for (const r of ex) { const key = r.st + '|' + r.d; if (seen.has(key)) continue; days.add(key); recs.push(r); }
    days.forEach(k => seen.add(k));
  }
  for (const r of recs) Object.assign(r, matchStorage(r.st), { wk: weekStart(r.d) });
  flagRecords(recs);
  state.all = recs;
  const cats = [...new Set(recs.map(r => r.cat))].sort();
  fillSelect($('catSelect'), cats, 'All categories');
  fillSelect($('bzCat'), cats, 'All categories');
  fillManagers();
}
/* typo + large-entry + reversal flags */
function flagRecords(recs) {
  const byItem = new Map();
  for (const r of recs) { const a = Math.abs(r.q); if (!a) continue; (byItem.get(r.ic) || byItem.set(r.ic, []).get(r.ic)).push(a); }
  const med = new Map();
  for (const [k, arr] of byItem) { arr.sort((a, b) => a - b); med.set(k, arr[arr.length >> 1] || 1); }
  for (const r of recs) {
    const ratio = Math.abs(r.q) / (med.get(r.ic) || 1);
    r.ratio = ratio;
    r.typo = ratio >= 1000 && Math.abs(r.v) >= 10000;
    r.large = !r.typo && ratio >= 20 && Math.abs(r.v) >= 2000;
    r.rev = false;
  }
  // a big + and a similar − for the same item/branch within 3 days = count correction
  const grp = new Map();
  for (const r of recs) if (r.large || r.typo) { const k = r.st + '|' + r.ic; (grp.get(k) || grp.set(k, []).get(k)).push(r); }
  const all = new Map();
  for (const r of recs) { const k = r.st + '|' + r.ic; (all.get(k) || all.set(k, []).get(k)).push(r); }
  for (const [k, arr] of grp) for (const a of arr) {
    const b = all.get(k).find(x => x !== a && Math.sign(x.q) === -Math.sign(a.q) && Math.abs(x.d - a.d) <= 3 && Math.abs(Math.abs(x.q) - Math.abs(a.q)) <= 0.15 * Math.abs(a.q));
    if (b) { a.rev = true; a.revWith = b; }
  }
}

/* ---------- scope (filters) ---------- */
function scope({ ignoreBranch = false, ignoreMgr = false, ignoreCat = false } = {}) {
  const rm = $('rmSelect').value, am = $('amSelect').value, br = $('brSelect').value, cat = $('catSelect').value, kt = $('ktSelect').value;
  const inc = $('incTypos').checked;
  return state.all.filter(r => (inc || !r.typo) && (ignoreMgr || ((!rm || r.rm === rm) && (!am || r.am === am))) &&
    (ignoreBranch || !br || r.st === br) && (ignoreCat || !cat || r.cat === cat) && (kt === '' || r.k === +kt));
}
function fillSelect(sel, vals, allLabel, labels) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + vals.map((v, i) => `<option value="${esc(v)}">${esc(labels ? labels[i] : v)}</option>`).join('');
  if (vals.includes(cur)) sel.value = cur;
}
function fillManagers() {
  const rm = $('rmSelect').value, am = $('amSelect').value;
  const rms = [...new Set(state.all.map(r => r.rm))].sort();
  fillSelect($('rmSelect'), rms, 'All regional managers');
  const ams = [...new Set(state.all.filter(r => !rm || r.rm === rm).map(r => r.am))].sort();
  fillSelect($('amSelect'), ams, 'All area managers');
  const brs = new Map();
  state.all.filter(r => (!rm || r.rm === rm) && (!am || r.am === am)).forEach(r => brs.set(r.st, `${r.branch} (${r.code})`));
  const keys = [...brs.keys()].sort((a, b) => brs.get(a).localeCompare(brs.get(b)));
  fillSelect($('brSelect'), keys, 'All branches', keys.map(k => brs.get(k)));
  fillSelect($('bzBranch'), keys, 'All branches', keys.map(k => brs.get(k)));
}

/* ---------- aggregation helpers ---------- */
function agg(recs, keyFn) {
  const m = new Map();
  for (const r of recs) {
    const k = keyFn(r);
    let a = m.get(k);
    if (!a) m.set(k, a = { key: k, net: 0, short: 0, surplus: 0, n: 0, q: 0, recs: [] });
    a.net += r.v; a.n++; a.q += r.q; if (r.v < 0) a.short += r.v; else a.surplus += r.v; a.recs.push(r);
  }
  return [...m.values()];
}
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function branchStats(recs) {
  const rows = agg(recs, r => r.st).map(a => {
    const r0 = a.recs[0], byCat = {};
    for (const r of a.recs) byCat[r.cat] = (byCat[r.cat] || 0) + r.v;
    return { ...a, st: a.key, branch: r0.branch, code: r0.code, am: r0.am, rm: r0.rm, byCat, days: new Set(a.recs.map(r => r.d)).size };
  });
  return rows;
}
/* control limits from all branches in the period (ignores manager/branch filter so limits don't move) */
function limits() {
  const base = scope({ ignoreBranch: true, ignoreMgr: true });
  const nets = branchStats(base).map(b => b.net);
  const m = mean(nets), s = sd(nets);
  const auto = Math.min(0, Math.round((m - 1.96 * s) / 100) * 100);
  return { mean: m, sd: s, breach: state.limitOverride ?? auto, auto, watch: Math.min(0, m - s), surplus: Math.max(0, m + 1.96 * s), base };
}
function statusOf(net, L) { return net <= L.breach ? 'breach' : net <= L.watch ? 'watch' : net >= L.surplus ? 'surplus' : 'ok'; }
const STATUS_LBL = { breach: 'Breach', watch: 'Watch', ok: 'Normal', surplus: 'High surplus' };

/* ---------- table helper ---------- */
function table(el, cols, rows, key, onRow) {
  const s = state.sort[key] || { i: cols.findIndex(c => c.sort) >= 0 ? cols.findIndex(c => c.sort) : 0, dir: cols.find(c => c.sort)?.sort || 1 };
  state.sort[key] = s;
  const c = cols[s.i];
  const val = c.val || (r => r[c.k]);
  const sorted = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * s.dir; });
  el.innerHTML = `<thead><tr>${cols.map((c, i) => `<th data-i="${i}" class="${i === s.i ? 'sorted' : ''} ${c.l ? 'l' : ''}">${esc(c.h)}${i === s.i ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
    <tbody>${sorted.length ? sorted.map((r, ri) => `<tr data-r="${ri}" class="${onRow ? 'click' : ''}">${cols.map(c => `<td class="${c.l ? 'l' : ''} ${c.cls ? c.cls(r) : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="l muted">Nothing to show for this selection.</td></tr>`}</tbody>`;
  el.querySelectorAll('th').forEach(th => th.onclick = () => { const i = +th.dataset.i; s.dir = s.i === i ? -s.dir : (cols[i].sort || -1); s.i = i; table(el, cols, rows, key, onRow); });
  if (onRow) el.querySelectorAll('tbody tr[data-r]').forEach(tr => tr.onclick = () => onRow(sorted[+tr.dataset.r]));
  el._export = () => sorted.map(r => Object.fromEntries(cols.map(c => [c.h, c.x ? c.x(r) : (c.val ? c.val(r) : r[c.k])])));
}
const money = (k, h) => ({ h, k, val: r => r[k], f: r => `<span class="${cls(r[k])}">${sar(r[k])}</span>`, x: r => Math.round(r[k]) });

/* ---------- charts ---------- */
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chart(id, cfg) { if (state.charts[id]) state.charts[id].destroy(); state.charts[id] = new Chart($(id), cfg); return state.charts[id]; }
function baseOpts(extra = {}) {
  const ink = css('--muted'), line = css('--line');
  Chart.defaults.font.family = css('--font'); Chart.defaults.color = ink;
  return { responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${sar(c.parsed.y ?? c.parsed.x)} SAR` } } },
    scales: { x: { grid: { color: line } }, y: { grid: { color: line } } }, ...extra };
}
const barLabels = { id: 'barLabels', afterDatasetsDraw(ch, a, o) {
  if (!o || !o.on) return; const { ctx } = ch; ctx.save(); ctx.font = '600 11px ' + css('--font'); ctx.fillStyle = css('--ink'); ctx.textAlign = 'center';
  ch.data.datasets.forEach((ds, di) => { if (ds.type === 'line') return; ch.getDatasetMeta(di).data.forEach((el, i) => { const v = ds.data[i]; if (!v) return; ctx.fillText(nf0.format(Math.round(Math.abs(v)) ), el.x, v < 0 ? el.y + 13 : el.y - 5); }); });
  ctx.restore(); } };
const limitLine = { id: 'limitLine', afterDatasetsDraw(ch, a, o) {
  if (!o || o.value == null) return; const x = ch.scales.x.getPixelForValue(o.value), { top, bottom } = ch.chartArea, ctx = ch.ctx;
  ctx.save(); ctx.strokeStyle = css('--high'); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore(); } };
Chart.register(barLabels, limitLine);

/* ---------- render ---------- */
function render() {
  const has = state.all && state.all.length;
  $('empty').hidden = !!has;
  document.querySelectorAll('.tab').forEach(t => t.hidden = !has || t.id !== 'tab-' + state.tab);
  if (!has) return;
  const sc = scope();
  const typos = state.all.filter(r => r.typo);
  $('scopeInfo').textContent = `${nf0.format(sc.length)} lines · ${new Set(sc.map(r => r.st)).size} branches` + (typos.length && !$('incTypos').checked ? ` · ${typos.length} suspected typo${typos.length > 1 ? 's' : ''} left out` : '');
  const reps = activeReports();
  const from = Math.min(...state.all.map(r => r.d)), to = Math.max(...state.all.map(r => r.d));
  $('period').textContent = `${dayLabel(from)} – ${dayLabel(to)} ${new Date(to * DAY).getUTCFullYear()}` + (state.local ? ' · preview (not published)' : reps.length > 1 ? ` · ${reps.length} reports combined` : '');
  try { ({ overview, branches, weekly, items, repeat, breaches, managers, checks, remarks })[state.tab](sc); }
  catch (e) { console.error(e); toast('Something went wrong drawing this tab: ' + e.message); }
}

function overview(sc) {
  const L = limits();
  const net = sc.reduce((s, r) => s + r.v, 0), short = sc.filter(r => r.v < 0).reduce((s, r) => s + r.v, 0), surplus = net - short;
  const br = branchStats(sc);
  const st = { breach: 0, watch: 0, ok: 0, surplus: 0 }; br.forEach(b => st[statusOf(b.net, L)]++);
  const typos = state.all.filter(r => r.typo), typoV = typos.reduce((s, r) => s + r.v, 0);
  const days = new Set(sc.map(r => r.d)).size || 1;
  $('kpis').innerHTML = [
    ['Net variance', sar(net) + ' <small>SAR</small>', `${net < 0 ? 'Net shortage' : 'Net surplus'} · ${sar(net / days)} per day`, cls(net)],
    ['Shortages', sar(short) + ' <small>SAR</small>', `${nf0.format(sc.filter(r => r.v < 0).length)} short lines`, 'neg'],
    ['Surpluses', sar(surplus) + ' <small>SAR</small>', `${nf0.format(sc.filter(r => r.v > 0).length)} over lines`, 'pos'],
    ['Branches in breach', `${st.breach} <small>/ ${br.length}</small>`, `limit ${sarPlain(L.breach)} SAR net`, st.breach ? 'neg' : ''],
    ['Avg per branch', sar(net / (br.length || 1)) + ' <small>SAR</small>', `${br.filter(b => b.net < 0).length} branches net short`, cls(net)],
    ['Suspected typos', `${typos.length}`, typos.length ? `${sar(typoV)} SAR ${$('incTypos').checked ? 'included' : 'left out'}` : 'none found', typos.length ? 'neg' : '']
  ].map(([l, v, s, c]) => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`).join('');

  // weekly trend
  const wks = agg(sc, r => r.wk).sort((a, b) => a.key - b.key);
  const minD = Math.min(...sc.map(r => r.d)), maxD = Math.max(...sc.map(r => r.d));
  const wkLbl = w => { const a = Math.max(w, minD), b = Math.min(w + 6, maxD); return `${dayLabel(a)} – ${dayLabel(b)}`; };
  chart('chTrend', { type: 'bar', data: { labels: wks.map(w => [wkLbl(w.key), 'Net ' + sar(w.net)]), datasets: [
    { label: 'Shortage', data: wks.map(w => Math.round(w.short)), backgroundColor: css('--high'), borderRadius: 6, stack: 's' },
    { label: 'Surplus', data: wks.map(w => Math.round(w.surplus)), backgroundColor: css('--teal'), borderRadius: 6, stack: 's' },
    { type: 'line', label: 'Net', data: wks.map(w => Math.round(w.net)), borderColor: css('--ink'), backgroundColor: css('--ink'), tension: .3, pointRadius: 4 }] },
    options: baseOpts({ plugins: { legend: { display: true, position: 'bottom' }, barLabels: { on: true }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${sar(c.parsed.y)} SAR` } } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: css('--line') } } } }) });

  // category
  const cats = agg(sc, r => r.cat).sort((a, b) => a.net - b.net);
  chart('chCat', { type: 'bar', data: { labels: cats.map(c => c.key), datasets: [{ data: cats.map(c => Math.round(c.net)), backgroundColor: cats.map(c => c.net < 0 ? css('--high') : css('--teal')), borderRadius: 6 }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => sar(c.parsed.x) + ' SAR' } } } }) });
  // status
  chart('chStatus', { type: 'doughnut', data: { labels: ['Breach', 'Watch', 'Normal', 'High surplus'], datasets: [{ data: [st.breach, st.watch, st.ok, st.surplus], backgroundColor: [css('--high'), css('--tan'), css('--teal'), '#8fb4d9'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom' } } } });
  // daily
  const dd = agg(sc, r => r.d).sort((a, b) => a.key - b.key);
  chart('chDay', { type: 'bar', data: { labels: dd.map(d => dayLabel(d.key)), datasets: [{ data: dd.map(d => Math.round(d.net)), backgroundColor: dd.map(d => d.net < 0 ? css('--high') : css('--teal')), borderRadius: 4 }] },
    options: baseOpts({ scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { grid: { color: css('--line') } } } }) });
  // worst branches
  const worst = br.sort((a, b) => a.net - b.net).slice(0, 12);
  chart('chBranches', { type: 'bar', data: { labels: worst.map(b => `${b.branch} (${b.code})`), datasets: [{ data: worst.map(b => Math.round(b.net)), backgroundColor: worst.map(b => b.net <= L.breach ? css('--high') : css('--tan')), borderRadius: 6 }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false }, limitLine: { value: L.breach }, tooltip: { callbacks: { label: c => sar(c.parsed.x) + ' SAR' } } } }) });
  const its = agg(sc, r => r.ic).sort((a, b) => a.net - b.net).slice(0, 12);
  chart('chItems', { type: 'bar', data: { labels: its.map(i => trunc(i.recs[0].n, 34)), datasets: [{ data: its.map(i => Math.round(i.net)), backgroundColor: css('--high'), borderRadius: 6 }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => sar(c.parsed.x) + ' SAR' } } } }) });
  state.charts.chBranches.options.onClick = (e, els) => els[0] && branchModal(worst[els[0].index].st);
  state.charts.chItems.options.onClick = (e, els) => els[0] && itemModal(its[els[0].index].key);
}
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

function branches(sc) {
  const L = limits();
  $('limitInput').value = Math.round(L.breach);
  $('limitNote').textContent = `Breach = net variance at or below ${sarPlain(L.breach)} SAR (${state.limitOverride != null ? 'set by you' : 'auto: average − 1.96 × spread of all branches'}). Watch = below ${sarPlain(L.watch)} SAR. High surplus = above ${sarPlain(L.surplus)} SAR — large gains usually mean a missed receipt or a counting error.`;
  const q = $('brSearch').value.toLowerCase(), f = $('brStatus').value;
  const cats = [...new Set(sc.map(r => r.cat))].sort((a, b) => sc.filter(r => r.cat === b).length - sc.filter(r => r.cat === a).length).slice(0, 4);
  const rows = branchStats(sc).map(b => ({ ...b, status: statusOf(b.net, L) }))
    .filter(b => (!q || `${b.branch} ${b.code} ${b.am} ${b.rm}`.toLowerCase().includes(q)) && (!f || b.status === f));
  table($('tblBranches'), [
    { h: 'Branch', k: 'branch', l: 1, f: r => `<b>${esc(r.branch)}</b> <span class="muted small">${esc(r.code)}</span>`, x: r => r.branch },
    { h: 'Code', k: 'code' }, { h: 'Area manager', k: 'am', l: 1 }, { h: 'Regional manager', k: 'rm', l: 1 },
    { ...money('net', 'Net SAR'), sort: 1 }, money('short', 'Shortage SAR'), money('surplus', 'Surplus SAR'),
    ...cats.map(c => ({ h: c, val: r => r.byCat[c] || 0, f: r => `<span class="${cls(r.byCat[c] || 0)}">${sar(r.byCat[c] || 0)}</span>`, x: r => Math.round(r.byCat[c] || 0) })),
    { h: 'Lines', k: 'n' }, { h: 'Status', k: 'status', val: r => ['breach', 'watch', 'ok', 'surplus'].indexOf(r.status), f: r => `<span class="chip ${r.status}">${STATUS_LBL[r.status]}</span>`, x: r => STATUS_LBL[r.status] }
  ], rows, 'branches', r => branchModal(r.st));
}

function weekly(sc) {
  const q = $('wkSearch').value.toLowerCase();
  const wks = [...new Set(sc.map(r => r.wk))].sort((a, b) => a - b);
  const minD = Math.min(...sc.map(r => r.d)), maxD = Math.max(...sc.map(r => r.d));
  const rows = branchStats(sc).filter(b => !q || `${b.branch} ${b.code} ${b.am}`.toLowerCase().includes(q)).map(b => {
    const w = {}; b.recs.forEach(r => w[r.wk] = (w[r.wk] || 0) + r.v);
    const last = w[wks[wks.length - 1]] || 0, prev = w[wks[wks.length - 2]] || 0;
    return { ...b, w, change: last - prev };
  });
  const maxAbs = Math.max(1, ...rows.flatMap(r => Object.values(r.w).map(Math.abs)));
  const cell = v => { if (!v) return '<span class="muted">–</span>'; const a = Math.min(1, Math.abs(v) / maxAbs) * .55 + .08; const col = v < 0 ? `rgba(194,86,74,${a})` : `rgba(108,198,175,${a})`; return `<span style="background:${col}">${sar(v)}</span>`; };
  table($('tblWeekly'), [
    { h: 'Branch', k: 'branch', l: 1, f: r => `<b>${esc(r.branch)}</b> <span class="muted small">${esc(r.code)}</span>`, x: r => r.branch },
    { h: 'Area manager', k: 'am', l: 1 },
    ...wks.map(w => ({ h: `${dayLabel(Math.max(w, minD))}–${dayLabel(Math.min(w + 6, maxD))}`, cls: () => 'c', val: r => r.w[w] || 0, f: r => cell(r.w[w] || 0), x: r => Math.round(r.w[w] || 0) })),
    { ...money('net', 'Total SAR'), sort: 1 },
    ...(wks.length > 1 ? [{ h: 'vs last week', k: 'change', f: r => r.change ? `<span class="${r.change < 0 ? 'trend-up' : 'trend-down'}">${r.change < 0 ? '▼ worse ' : '▲ better '}${sarPlain(Math.abs(r.change))}</span>` : '–', x: r => Math.round(r.change) }] : [])
  ], rows, 'weekly', r => branchModal(r.st));
}

function items(sc) {
  const q = $('itSearch').value.toLowerCase(), g = $('itGroup').value;
  const groups = [...new Set(sc.map(r => r.g).filter(Boolean))].sort();
  fillSelect($('itGroup'), groups, 'All stock groups');
  const rows = agg(sc.filter(r => !g || r.g === g), r => r.ic).map(a => {
    const r0 = a.recs[0], shortBr = new Set(), byBr = {};
    a.recs.forEach(r => byBr[r.st] = (byBr[r.st] || 0) + r.v);
    Object.entries(byBr).forEach(([k, v]) => v < 0 && shortBr.add(k));
    return { ...a, code: r0.ic, name: r0.n, u: r0.u, g: r0.g, cat: r0.cat, shortBr: shortBr.size, brs: Object.keys(byBr).length, avgShort: shortBr.size ? Object.values(byBr).filter(v => v < 0).reduce((s, v) => s + v, 0) / shortBr.size : 0 };
  }).filter(r => !q || `${r.name} ${r.code}`.toLowerCase().includes(q));
  table($('tblItems'), [
    { h: 'Item', k: 'name', l: 1, f: r => `<b>${esc(trunc(r.name, 48))}</b>`, x: r => r.name }, { h: 'Code', k: 'code' }, { h: 'Group', k: 'g', l: 1 }, { h: 'Category', k: 'cat', l: 1 },
    { h: 'Net qty', k: 'q', f: r => `<span class="${cls(r.q)}">${qty(r.q, r.u)}</span>`, x: r => +r.q.toFixed(3) }, { h: 'Unit', k: 'u' },
    { ...money('net', 'Net SAR'), sort: 1 }, money('short', 'Shortage SAR'), money('surplus', 'Surplus SAR'),
    { h: 'Branches short', k: 'shortBr', f: r => `${r.shortBr} <span class="muted small">/ ${r.brs}</span>` },
    { h: 'Avg per short branch', k: 'avgShort', f: r => `<span class="neg">${r.avgShort ? sar(r.avgShort) : '–'}</span>`, x: r => Math.round(r.avgShort) }
  ], rows, 'items', r => itemModal(r.key));
}

function repeat(sc) {
  const min = Math.max(2, +$('rpMin').value || 3), minSar = +$('rpSar').value || 0, q = $('rpSearch').value.toLowerCase();
  const rows = agg(sc.filter(r => r.v < 0 && !r.rev), r => r.st + '|' + r.ic).map(a => {
    const r0 = a.recs[0];
    return { ...a, branch: r0.branch, code: r0.code, am: r0.am, st: r0.st, ic: r0.ic, name: r0.n, u: r0.u, cat: r0.cat, times: new Set(a.recs.map(r => r.d)).size,
      weeks: new Set(a.recs.map(r => r.wk)).size, last: Math.max(...a.recs.map(r => r.d)) };
  }).filter(r => r.times >= min && -r.short >= minSar && (!q || `${r.branch} ${r.code} ${r.name}`.toLowerCase().includes(q)));
  table($('tblRepeat'), [
    { h: 'Branch', k: 'branch', l: 1, f: r => `<b>${esc(r.branch)}</b> <span class="muted small">${esc(r.code)}</span>`, x: r => r.branch }, { h: 'Area manager', k: 'am', l: 1 },
    { h: 'Item', k: 'name', l: 1, f: r => esc(trunc(r.name, 44)), x: r => r.name }, { h: 'Category', k: 'cat', l: 1 },
    { h: 'Times short', k: 'times' }, { h: 'Weeks', k: 'weeks' },
    { h: 'Qty short', k: 'q', f: r => `<span class="neg">${qty(r.q, r.u)}</span>`, x: r => +r.q.toFixed(3) },
    { ...money('short', 'SAR short'), sort: 1 }, { h: 'Last short', k: 'last', f: r => dayLabel(r.last), x: r => dayISO(r.last) }
  ], rows, 'repeat', r => itemModal(r.ic, r.st));
}

function breaches(sc) {
  const L = limits(), base = L.base;
  const brF = $('bzBranch').value, catF = $('bzCat').value;
  const rm = $('rmSelect').value, am = $('amSelect').value;
  const out = [];
  const cats = ['Total', ...[...new Set(base.map(r => r.cat))].sort()];
  for (const c of cats) {
    const recs = c === 'Total' ? base : base.filter(r => r.cat === c);
    const bs = branchStats(recs); if (bs.length < 5) continue;
    const m = mean(bs.map(b => b.net)), s = sd(bs.map(b => b.net));
    const lim = c === 'Total' ? L.breach : Math.min(0, m - 1.96 * s);
    for (const b of bs) if (b.net <= lim && b.net < 0) out.push({ ...b, cat: c, lim, over: b.net - lim, top: topItems(b.recs, 2) });
  }
  const rows = out.filter(r => (!brF || r.st === brF) && (!catF || r.cat === catF) && (!rm || r.rm === rm) && (!am || r.am === am));
  $('bzNote').textContent = `${rows.length} breach${rows.length === 1 ? '' : 'es'}. A branch is in breach for a category when its net variance is at or below that category's limit (average − 1.96 × spread across all branches). Sorted worst first.`;
  table($('tblBreaches'), [
    { h: 'Branch', k: 'branch', l: 1, f: r => `<b>${esc(r.branch)}</b> <span class="muted small">${esc(r.code)}</span>`, x: r => r.branch },
    { h: 'Area manager', k: 'am', l: 1 }, { h: 'Regional manager', k: 'rm', l: 1 }, { h: 'Variance type', k: 'cat', l: 1 },
    { ...money('net', 'Net SAR'), sort: 1 }, { h: 'Limit SAR', k: 'lim', f: r => sarPlain(r.lim), x: r => Math.round(r.lim) },
    { h: 'Beyond limit', k: 'over', f: r => `<span class="neg">${sar(r.over)}</span>`, x: r => Math.round(r.over) },
    { h: 'Main items short', k: 'top', l: 1, f: r => esc(r.top), x: r => r.top }
  ], rows, 'breaches', r => branchModal(r.st));
}
function topItems(recs, n) {
  return agg(recs, r => r.ic).sort((a, b) => a.net - b.net).filter(a => a.net < 0).slice(0, n).map(a => `${trunc(a.recs[0].n, 28)} (${sarPlain(a.net)})`).join(', ');
}

function managers(sc) {
  const L = limits();
  const mk = (keyFn, el, key, label) => {
    const rows = agg(sc, keyFn).map(a => {
      const bs = branchStats(a.recs);
      return { ...a, name: a.key, branches: bs.length, breach: bs.filter(b => statusOf(b.net, L) === 'breach').length, avg: a.net / (bs.length || 1), worst: bs.sort((x, y) => x.net - y.net)[0] };
    });
    table(el, [
      { h: label, k: 'name', l: 1, f: r => `<b>${esc(r.name)}</b>`, x: r => r.name }, { h: 'Branches', k: 'branches' },
      { ...money('net', 'Net SAR'), sort: 1 }, money('short', 'Shortage SAR'), money('surplus', 'Surplus SAR'), money('avg', 'Avg per branch'),
      { h: 'In breach', k: 'breach', f: r => r.breach ? `<span class="chip breach">${r.breach}</span>` : '0' },
      { h: 'Worst branch', k: 'worst', l: 1, val: r => r.worst?.net || 0, f: r => r.worst ? `${esc(r.worst.branch)} <span class="neg">${sar(r.worst.net)}</span>` : '', x: r => r.worst ? `${r.worst.branch} (${Math.round(r.worst.net)})` : '' }
    ], rows, key, r => { if (key === 'rm') { $('rmSelect').value = r.name; fillManagers(); } else { $('amSelect').value = r.name; } switchTab('branches'); });
  };
  mk(r => r.rm, $('tblRM'), 'rm', 'Regional manager');
  mk(r => r.am, $('tblAM'), 'am', 'Area manager');
}

function checks() {
  const all = state.all.filter(r => (!$('rmSelect').value || r.rm === $('rmSelect').value) && (!$('amSelect').value || r.am === $('amSelect').value) && (!$('brSelect').value || r.st === $('brSelect').value));
  const typos = all.filter(r => r.typo), large = all.filter(r => r.large), q = $('ckSearch').value.toLowerCase();
  const unm = [...new Set(state.all.filter(r => !r.mapped).map(r => r.st))];
  $('ckKpis').innerHTML = [
    ['Suspected typos', typos.length, `${sar(typos.reduce((s, r) => s + r.v, 0))} SAR`],
    ['Large entries', large.length, `${large.filter(r => r.rev).length} reversed within 3 days`],
    ['Unmatched storages', unm.length, unm.length ? 'not linked to a branch' : 'all matched']
  ].map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  const cols = extra => [
    { h: 'Branch', k: 'branch', l: 1, f: r => `<b>${esc(r.branch)}</b> <span class="muted small">${esc(r.code)}</span>`, x: r => r.branch },
    { h: 'Date', k: 'd', f: r => dayLabel(r.d), x: r => dayISO(r.d) }, { h: 'Item', k: 'n', l: 1, f: r => esc(trunc(r.n, 46)), x: r => r.n },
    { h: 'Qty entered', k: 'q', val: r => Math.abs(r.q), f: r => `<b class="${cls(r.q)}">${qty(r.q, r.u)}</b>`, x: r => r.q },
    { h: 'Usual qty', k: 'ratio', val: r => r.ratio, f: r => `${nf2.format(Math.abs(r.q) / r.ratio)} ${esc(r.u)} <span class="muted small">(×${nf0.format(r.ratio)})</span>`, x: r => +(Math.abs(r.q) / r.ratio).toFixed(3) },
    { h: 'SAR', k: 'v', val: r => Math.abs(r.v), sort: -1, f: r => `<span class="${cls(r.v)}">${sar(r.v)}</span>`, x: r => r.v }, ...extra ];
  table($('tblTypos'), cols([]), typos, 'typos', r => itemModal(r.ic, r.st));
  table($('tblLarge'), cols([{ h: 'Note', k: 'rev', l: 1, val: r => r.rev ? 1 : 0, f: r => r.rev ? `<span class="chip rev">Reversed ${dayLabel(r.revWith.d)}</span>` : '<span class="chip watch">Check</span>', x: r => r.rev ? 'Reversed' : 'Check' }]),
    large.filter(r => !q || `${r.branch} ${r.code} ${r.n}`.toLowerCase().includes(q)), 'large', r => itemModal(r.ic, r.st));
  $('unmappedTitle').hidden = $('unmappedWrap').hidden = !unm.length;
  if (unm.length) table($('tblUnmapped'), [{ h: 'Storage name in report', k: 'st', l: 1 }, money('net', 'Net SAR'), { h: 'Lines', k: 'n' }], branchStats(state.all.filter(r => !r.mapped)), 'unm');
}

/* ---------- remarks ---------- */
async function loadRemarks() {
  $('remMsg2').textContent = 'Loading…';
  try { state.remarks = await (await api('/remarks')).json(); $('remMsg2').textContent = ''; }
  catch (e) { $('remMsg2').textContent = 'Could not load remarks: ' + e.message; state.remarks = []; }
  if (state.tab === 'remarks') remarks();
}
function remarks() {
  const q = $('remSearch').value.toLowerCase(), f = $('remStatus').value;
  const rows = state.remarks.filter(r => (!q || `${r.author} ${r.branch} ${r.item} ${r.remark}`.toLowerCase().includes(q)) && (!f || r.status === f));
  table($('tblRemarks'), [
    { h: 'Date', k: 'created_at', sort: -1, f: r => esc(String(r.created_at).slice(0, 16)) }, { h: 'Name', k: 'author', l: 1 }, { h: 'Branch', k: 'branch', l: 1 },
    { h: 'Item', k: 'item', l: 1 }, { h: 'Remark', k: 'remark', l: 1, f: r => `<span style="white-space:normal;display:block;max-width:420px">${esc(r.remark)}</span>` },
    { h: 'Status', k: 'status', f: r => `<button class="btn small" data-tog="${r.id}">${r.status === 'resolved' ? '✓ Resolved' : 'Open'}</button>` },
    { h: '', k: 'id', f: r => `<button class="btn danger small" data-del="${r.id}">Delete</button>`, x: () => '' }
  ], rows, 'remarks');
  $('tblRemarks').querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const r = state.remarks.find(x => x.id === +b.dataset.tog); const ns = r.status === 'resolved' ? 'open' : 'resolved';
    try { await api('/remarks/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: ns }) }); r.status = ns; remarks(); } catch (e) { toast(e.message); } });
  $('tblRemarks').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this remark?')) return;
    try { await api('/remarks/' + b.dataset.del, { method: 'DELETE' }); state.remarks = state.remarks.filter(x => x.id !== +b.dataset.del); remarks(); toast('Remark deleted.'); } catch (e) { toast(e.message); } });
}
function remarkDialog(branchSt, item) {
  const brs = [...new Map(state.all.map(r => [r.st, `${r.branch} (${r.code})`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  openModal(`<h2>Add a remark</h2><p class="muted small">Explain a variance or the action taken. Remarks go to the operations admin.</p>
    <label>Your name</label><input id="rmAuthor" value="${esc(store.get('hmvName') || '')}" maxlength="80">
    <label>Branch</label><select id="rmBranch">${brs.map(([k, v]) => `<option value="${esc(k)}" ${k === branchSt ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <label>Item (optional)</label><input id="rmItem" value="${esc(item || '')}" maxlength="160">
    <label>Remark</label><textarea id="rmText" rows="4" maxlength="1000"></textarea>
    <div class="actions-row"><button class="btn primary" id="rmSave">Send remark</button><span id="rmMsg" class="small gate-msg"></span></div>`);
  $('rmSave').onclick = async () => {
    const author = $('rmAuthor').value.trim(), remark = $('rmText').value.trim(), st = $('rmBranch').value;
    if (!author || !remark) { $('rmMsg').textContent = 'Please fill in your name and the remark.'; return; }
    const b = state.all.find(r => r.st === st);
    $('rmSave').disabled = true;
    try { await api('/remarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author, remark, branch: b ? `${b.branch} (${b.code})` : st, item: $('rmItem').value.trim(), report_id: state.sel || null }) });
      store.set('hmvName', author); closeModal(); toast('✓ Remark sent.'); if (state.role === 'admin') loadRemarks(); }
    catch (e) { $('rmMsg').textContent = state.offline ? 'Remarks need the online dashboard.' : e.message; $('rmSave').disabled = false; }
  };
}

/* ---------- detail modals ---------- */
function branchModal(st) {
  const sc = scope({ ignoreBranch: true }).filter(r => r.st === st);
  if (!sc.length) return;
  const r0 = sc[0], L = limits(), net = sc.reduce((s, r) => s + r.v, 0), short = sc.filter(r => r.v < 0).reduce((s, r) => s + r.v, 0);
  const cats = agg(sc, r => r.cat).sort((a, b) => a.net - b.net);
  const its = agg(sc, r => r.ic).sort((a, b) => a.net - b.net);
  const row = a => `<tr class="click" data-ic="${esc(a.key)}"><td class="l">${esc(trunc(a.recs[0].n, 44))}</td><td class="${cls(a.q)}">${qty(a.q, a.recs[0].u)}</td><td class="${cls(a.net)}">${sar(a.net)}</td></tr>`;
  openModal(`<h2>${esc(r0.branch)} <span class="muted">${esc(r0.code)}</span></h2>
    <p class="muted">${esc(r0.am)} · ${esc(r0.rm)} · <span class="chip ${statusOf(net, L)}">${STATUS_LBL[statusOf(net, L)]}</span></p>
    <div class="kv"><div><span>Net</span><b class="${cls(net)}">${sar(net)}</b></div><div><span>Shortage</span><b class="neg">${sar(short)}</b></div><div><span>Surplus</span><b class="pos">${sar(net - short)}</b></div><div><span>Lines</span><b>${sc.length}</b></div></div>
    <h3>By category</h3><table><tbody>${cats.map(c => `<tr><td class="l">${esc(c.key)}</td><td class="${cls(c.net)}">${sar(c.net)}</td></tr>`).join('')}</tbody></table>
    <div class="chart" style="height:200px;margin-top:14px"><canvas id="chModal"></canvas></div>
    <h3>Biggest shortages</h3><table><thead><tr><th class="l">Item</th><th>Net qty</th><th>SAR</th></tr></thead><tbody>${its.filter(a => a.net < 0).slice(0, 12).map(row).join('')}</tbody></table>
    <h3>Biggest surpluses</h3><table><thead><tr><th class="l">Item</th><th>Net qty</th><th>SAR</th></tr></thead><tbody>${its.filter(a => a.net > 0).reverse().slice(0, 6).map(row).join('') || '<tr><td class="l muted">None</td></tr>'}</tbody></table>
    <div class="actions-row"><button class="btn" id="mRemark">✎ Add remark</button><button class="btn" id="mFilter">Show only this branch</button></div>`);
  const dd = agg(sc, r => r.d).sort((a, b) => a.key - b.key);
  chart('chModal', { type: 'bar', data: { labels: dd.map(d => dayLabel(d.key)), datasets: [{ data: dd.map(d => Math.round(d.net)), backgroundColor: dd.map(d => d.net < 0 ? css('--high') : css('--teal')), borderRadius: 4 }] }, options: baseOpts({ scales: { x: { grid: { display: false } }, y: {} } }) });
  $('modalBody').querySelectorAll('[data-ic]').forEach(tr => tr.onclick = () => itemModal(tr.dataset.ic, st));
  $('mRemark').onclick = () => remarkDialog(st);
  $('mFilter').onclick = () => { $('brSelect').value = st; closeModal(); render(); };
}
function itemModal(ic, st) {
  const sc = scope({ ignoreBranch: !!st }).filter(r => r.ic === ic && (!st || r.st === st));
  const all = st ? sc : sc;
  if (!all.length) return;
  const r0 = all[0];
  const lines = all.slice().sort((a, b) => a.d - b.d);
  const brs = agg(all, r => r.st).sort((a, b) => a.net - b.net);
  openModal(`<h2>${esc(r0.n)}</h2><p class="muted">${esc(r0.ic)} · ${esc(r0.g)} · ${esc(r0.cat)} · unit: ${esc(r0.u)}${st ? ` · <b>${esc(r0.branch)} (${esc(r0.code)})</b>` : ''}</p>
    <div class="kv"><div><span>Net qty</span><b class="${cls(lines.reduce((s, r) => s + r.q, 0))}">${qty(lines.reduce((s, r) => s + r.q, 0), r0.u)}</b></div><div><span>Net SAR</span><b class="${cls(lines.reduce((s, r) => s + r.v, 0))}">${sar(lines.reduce((s, r) => s + r.v, 0))}</b></div><div><span>Lines</span><b>${lines.length}</b></div></div>
    ${st ? `<h3>Every count</h3><table><thead><tr><th class="l">Date</th><th>Count</th><th>Qty</th><th>SAR</th><th></th></tr></thead><tbody>${lines.map(r => `<tr><td class="l">${dayLabel(r.d)}</td><td>${r.k ? 'Weekly' : 'Daily'}</td><td class="${cls(r.q)}">${qty(r.q, r.u)}</td><td class="${cls(r.v)}">${sar(r.v)}</td><td>${r.typo ? '<span class="chip typo">Typo?</span>' : r.rev ? '<span class="chip rev">Reversed</span>' : r.large ? '<span class="chip watch">Check</span>' : ''}</td></tr>`).join('')}</tbody></table>
      <div class="actions-row"><button class="btn" id="mRemark">✎ Add remark</button></div>`
    : `<h3>By branch</h3><table><thead><tr><th class="l">Branch</th><th class="l">Area manager</th><th>Qty</th><th>SAR</th></tr></thead><tbody>${brs.map(b => `<tr class="click" data-st="${esc(b.key)}"><td class="l">${esc(b.recs[0].branch)} <span class="muted small">${esc(b.recs[0].code)}</span></td><td class="l">${esc(b.recs[0].am)}</td><td class="${cls(b.q)}">${qty(b.q, r0.u)}</td><td class="${cls(b.net)}">${sar(b.net)}</td></tr>`).join('')}</tbody></table>`}`);
  $('modalBody').querySelectorAll('[data-st]').forEach(tr => tr.onclick = () => itemModal(ic, tr.dataset.st));
  if ($('mRemark')) $('mRemark').onclick = () => remarkDialog(st, r0.n);
}
let lastFocus = null;
function openModal(html) { lastFocus = document.activeElement; $('modalBody').innerHTML = html; $('modal').hidden = false; $('modalBox').scrollTop = 0; requestAnimationFrame(() => $('modal').classList.add('open')); $('modalBox').focus(); }
function closeModal() { $('modal').classList.remove('open'); $('modal').hidden = true; if (state.charts.chModal) { state.charts.chModal.destroy(); delete state.charts.chModal; } lastFocus && lastFocus.focus && lastFocus.focus(); }

/* ---------- breaches: copy / email ---------- */
function breachRows() { return ($('tblBreaches')._export || (() => []))(); }
async function copyBreaches() {
  const rows = breachRows(); if (!rows.length) { $('bzStatus').textContent = 'Nothing to copy.'; return; }
  const hdr = Object.keys(rows[0]);
  const html = `<table border="1" cellpadding="4" style="border-collapse:collapse;font-family:Arial;font-size:12px"><tr>${hdr.map(h => `<th style="background:#D4B38B">${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${hdr.map(h => `<td>${esc(typeof r[h] === 'number' ? nf0.format(r[h]) : r[h])}</td>`).join('')}</tr>`).join('')}</table>`;
  const tsv = [hdr.join('\t'), ...rows.map(r => hdr.map(h => r[h]).join('\t'))].join('\n');
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]); }
  catch (e) { try { await navigator.clipboard.writeText(tsv); } catch (x) { $('bzStatus').textContent = 'Copy blocked by the browser.'; return false; } }
  $('bzStatus').textContent = `✓ ${rows.length} rows copied — paste into the email.`; return true;
}
async function mailBreaches() {
  const rows = breachRows(); if (!rows.length) { $('bzStatus').textContent = 'No breaches to email.'; return; }
  await copyBreaches();
  const per = $('period').textContent.split(' · ')[0];
  const lines = rows.slice(0, 25).map(r => `• ${r['Branch']} — ${r['Variance type']}: ${nf0.format(r['Net SAR'])} SAR (limit ${nf0.format(r['Limit SAR'])})`).join('\n');
  const body = `Dear team,\n\nPlease find below the inventory variance breaches for ${per}.\n(The full table is copied — press Ctrl+V / Cmd+V here to paste it.)\n\n${lines}${rows.length > 25 ? `\n…and ${rows.length - 25} more` : ''}\n\nPlease review and add your remarks in the Variance Tracker.\n\nRegards`;
  location.href = `mailto:?subject=${encodeURIComponent('Inventory variance breaches — ' + per)}&body=${encodeURIComponent(body)}`;
}

/* ---------- Excel export of the current tab ---------- */
function exportExcel() {
  const map = { overview: ['tblBranches', 'Branches'], branches: ['tblBranches', 'Branches'], weekly: ['tblWeekly', 'Weekly by branch'], items: ['tblItems', 'Items'], repeat: ['tblRepeat', 'Repeat shortages'], breaches: ['tblBreaches', 'Breaches'], managers: ['tblAM', 'Area managers'], checks: ['tblTypos', 'Typo check'], remarks: ['tblRemarks', 'Remarks'] };
  if (state.tab === 'overview') { const t = state.tab; state.tab = 'branches'; branches(scope()); state.tab = t; }
  const wb = XLSX.utils.book_new();
  const add = (id, name) => { const rows = ($(id)._export || (() => []))(); if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31)); };
  const [id, name] = map[state.tab]; add(id, name);
  if (state.tab === 'managers') add('tblRM', 'Regional managers');
  if (state.tab === 'checks') add('tblLarge', 'Large entries');
  if (!wb.SheetNames.length) { toast('Nothing to download for this view.'); return; }
  XLSX.writeFile(wb, `HM Variance — ${name} — ${$('period').textContent.split(' · ')[0]}.xlsx`);
}

/* ---------- loading / publishing ---------- */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 5000); }
function notice(msg) { $('notice').hidden = !msg; $('notice').innerHTML = msg || ''; }
function setEmpty(title, text) { $('emptyTitle').textContent = title; $('emptyText').innerHTML = text; }

function renderReportSelect() {
  const sel = $('repSelect');
  const opts = state.local ? [`<option value="__local">${esc(rangeLabel(state.local.from, state.local.to))} (preview)</option>`] :
    [...(state.reports.length > 1 ? [`<option value="">All reports combined</option>`] : []),
     ...state.reports.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`)];
  sel.innerHTML = opts.join('') || '<option value="">No reports yet</option>';
  sel.value = state.local ? '__local' : state.sel;
  $('btnDeleteReport').hidden = !(state.role === 'admin' && state.sel && !state.local);
}
const rangeLabel = (a, b) => { const f = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); return `${f(a)} – ${f(b)}`; };

async function loadReport(id) {
  if (state.cache[id]) return state.cache[id];
  const buf = await (await api('/reports/' + encodeURIComponent(id))).arrayBuffer();
  return state.cache[id] = JSON.parse(await gunz(buf));
}
async function refreshAll() {
  setEmpty('Loading…', 'Fetching the published reports.');
  try {
    const [reps, map] = await Promise.all([api('/reports').then(r => r.json()), api('/mapping').then(r => r.json()).catch(() => null)]);
    if (map && map.rows && map.rows.length) setMapping(map.rows, (map.source || 'uploaded') + (map.updated_at ? ` (updated ${String(map.updated_at).slice(0, 10)})` : '')); else setMapping(window.DEFAULT_BRANCHES, 'built-in (Span of Control, 22 Oct 2026)');
    state.reports = reps;
    if (!reps.find(r => r.id === state.sel)) state.sel = reps[0] ? reps[0].id : '';
    renderReportSelect();
    if (!reps.length) { state.all = []; setEmpty('No reports published yet', state.role === 'admin' ? 'Use <b>Update data → Upload variance report</b> to add the first one.' : 'Ask the operations admin to upload the variance report.'); render(); return; }
    const ids = state.sel ? [state.sel] : reps.map(r => r.id);
    await Promise.all(ids.map(loadReport));
    buildRecords(); render();
  } catch (e) {
    if (e.status === 401) { lock('Password changed — please enter it again.'); return; }
    setEmpty('Could not load data', esc(e.message)); render();
  }
}
async function selectReport(id) {
  if (id === '__local') return;
  state.sel = id; renderReportSelect();
  try { await Promise.all((id ? [id] : state.reports.map(r => r.id)).map(loadReport)); buildRecords(); render(); }
  catch (e) { toast('Could not load that report: ' + e.message); }
}

async function handleReportFile(file) {
  toast('Reading ' + file.name + '…');
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    const rep = parseReport(wb, file.name);
    state.local = rep; renderReportSelect(); buildRecords(); render();
    const iss = rep.issues, skipped = iss.noStore + iss.noDate + iss.noCost;
    const unm = [...new Set(state.all.filter(r => !r.mapped).map(r => r.st))];
    const typos = state.all.filter(r => r.typo);
    notice(`Loaded <b>${esc(file.name)}</b>: ${nf0.format(rep.rows)} lines, ${rep.stores.length} storages, ${rangeLabel(rep.from, rep.to)}.` +
      (skipped ? ` ${skipped} lines skipped (${iss.noStore} without storage, ${iss.noDate} without date, ${iss.noCost} without cost).` : '') +
      (unm.length ? ` <b>${unm.length} storage${unm.length > 1 ? 's' : ''} not matched to a branch</b> — see Typo check.` : '') +
      (typos.length ? ` <b>${typos.length} suspected typo${typos.length > 1 ? 's' : ''}</b> left out of totals — see Typo check.` : ''));
    const overlap = state.reports.filter(r => r.from_date <= rep.to && r.to_date >= rep.from && r.id !== `${rep.from}_${rep.to}`);
    $('publishBar').hidden = state.offline;
    $('pubMsg').textContent = overlap.length ? `Note: overlaps ${overlap.map(r => r.label).join(', ')} — when combined, the newest upload is used for overlapping days.` : '';
    const saved = store.get('hmvAdmin');
    if (saved && !state.offline) publish(saved);
  } catch (e) { console.error(e); notice(''); toast('Could not read that file: ' + e.message); }
}
async function publish(auto) {
  const pass = typeof auto === 'string' ? auto : $('passcode').value.trim();
  if (!pass) { $('pubMsg').textContent = 'Enter the admin passcode.'; return; }
  const rep = state.local; if (!rep) return;
  $('btnPublish').disabled = true; $('pubMsg').textContent = 'Saving…';
  try {
    const body = await gz(JSON.stringify(rep));
    const meta = { stores: rep.stores.length, net: Math.round(rep.cols.v.reduce((s, v) => s + v, 0)) };
    const qs = new URLSearchParams({ from: rep.from, to: rep.to, label: rangeLabel(rep.from, rep.to), file: rep.file, rows: rep.rows, meta: JSON.stringify(meta) });
    const res = await (await api('/reports?' + qs, { method: 'POST', body }, pass)).json();
    store.set('hmvAdmin', pass);
    if (state.role !== 'admin') { state.role = 'admin'; adminUI(); }
    state.cache[res.id] = rep; state.local = null; state.sel = res.id;
    $('publishBar').hidden = true; $('passcode').value = '';
    toast('✓ Report published for everyone.');
    await refreshAll();
  } catch (e) {
    if (e.status === 401 || e.status === 403) { store.set('hmvAdmin', null); $('pubMsg').textContent = 'Wrong admin passcode.'; $('publishBar').hidden = false; }
    else $('pubMsg').textContent = 'Could not save: ' + e.message;
  } finally { $('btnPublish').disabled = false; }
}
async function adminPass() {
  let p = store.get('hmvAdmin') || (state.role === 'admin' ? state.pass : null);
  if (!p) p = prompt('Admin passcode'); if (!p) return null; return p;
}
async function deleteReport() {
  const r = state.reports.find(x => x.id === state.sel); if (!r) return;
  if (!confirm(`Delete the report ${r.label}? This cannot be undone.`)) return;
  const p = await adminPass(); if (!p) return;
  try { await api('/reports/' + encodeURIComponent(r.id), { method: 'DELETE' }, p); delete state.cache[r.id]; state.sel = ''; toast('Report deleted.'); refreshAll(); }
  catch (e) { toast('Could not delete: ' + e.message); }
}
async function handleMapFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    let rows = null, err = null;
    const names = wb.SheetNames.slice().sort((a, b) => (b.toLowerCase() === 'new') - (a.toLowerCase() === 'new'));
    for (const n of names) { try { rows = parseSpan(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })); break; } catch (e) { err = e; } }
    if (!rows) throw err;
    setMapping(rows, file.name); if (state.all) { buildRecords(); render(); }
    const p = state.offline ? null : await adminPass();
    if (p) { await api('/mapping', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, source: file.name }) }, p); store.set('hmvAdmin', p); toast(`✓ Mapping saved for everyone (${rows.length} branches).`); }
    else toast(`Mapping applied on this device (${rows.length} branches).`);
  } catch (e) { toast('Could not read mapping: ' + e.message); }
}
async function resetMapping() {
  const p = await adminPass(); if (!p) return;
  try { await api('/mapping', { method: 'DELETE' }, p); setMapping(window.DEFAULT_BRANCHES, 'built-in (Span of Control, 22 Oct 2026)'); buildRecords(); render(); toast('Back to the built-in mapping.'); }
  catch (e) { toast(e.message); }
}

/* ---------- gate ---------- */
function lock(msg) { document.body.classList.add('locked'); $('gate').hidden = false; $('gateMsg').textContent = msg || ''; $('gatePw').focus(); }
function adminUI() { $('tabRemarks').hidden = state.role !== 'admin'; renderReportSelect(); if (state.role === 'admin') loadRemarks(); }
async function unlock(pw) {
  $('gateBtn').disabled = true; $('gateMsg').textContent = '';
  try {
    const { role } = await (await api('/auth', {}, pw)).json();
    state.pass = pw; state.role = role; store.set('hmvPass', pw);
    if (role === 'admin') store.set('hmvAdmin', pw);
    document.body.classList.remove('locked'); $('gate').hidden = true; $('gatePw').value = '';
    adminUI(); await refreshAll();
  } catch (e) {
    if (e.status === 401) { store.set('hmvPass', null); lock(pw ? 'Wrong password.' : ''); }
    else if (e.status === 500) lock(e.message);
    else offlineMode();
  } finally { $('gateBtn').disabled = false; }
}
function offlineMode() {   // opened without the Cloudflare backend (e.g. as a local file): work on uploads only
  state.offline = true; state.role = 'admin';
  document.body.classList.remove('locked'); $('gate').hidden = true;
  setMapping(window.DEFAULT_BRANCHES, 'built-in'); renderReportSelect();
  setEmpty('Offline mode', 'The online database is not reachable, so nothing is shared. You can still upload a variance report to view it on this device.');
  render();
}

/* ---------- tabs + wiring ---------- */
function switchTab(t) {
  state.tab = t;
  document.querySelectorAll('#tabs button').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  if (t === 'remarks' && !state.remarks.length) loadRemarks();
  render();
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('gateBtn').onclick = () => unlock($('gatePw').value);
$('gatePw').onkeydown = e => { if (e.key === 'Enter') unlock($('gatePw').value); };
$('repSelect').onchange = e => selectReport(e.target.value);
$('rmSelect').onchange = () => { $('amSelect').value = ''; $('brSelect').value = ''; fillManagers(); render(); };
$('amSelect').onchange = () => { $('brSelect').value = ''; fillManagers(); render(); };
['brSelect', 'catSelect', 'ktSelect', 'incTypos', 'brStatus', 'bzBranch', 'bzCat', 'itGroup', 'remStatus'].forEach(id => $(id).onchange = render);
['brSearch', 'wkSearch', 'itSearch', 'rpSearch', 'rpMin', 'rpSar', 'ckSearch', 'remSearch'].forEach(id => $(id).oninput = () => { clearTimeout(render.t); render.t = setTimeout(render, 180); });
$('limitInput').onchange = () => { const v = +$('limitInput').value; state.limitOverride = isFinite(v) ? -Math.abs(v) : null; render(); };
$('limitAuto').onclick = () => { state.limitOverride = null; render(); };
$('fileReport').onchange = e => { const f = e.target.files[0]; e.target.value = ''; document.querySelector('details.more').open = false; f && handleReportFile(f); };
$('fileMap').onchange = e => { const f = e.target.files[0]; e.target.value = ''; document.querySelector('details.more').open = false; f && handleMapFile(f); };
$('btnMapReset').onclick = () => { document.querySelector('details.more').open = false; resetMapping(); };
$('btnDeleteReport').onclick = () => { document.querySelector('details.more').open = false; deleteReport(); };
$('btnPublish').onclick = () => publish();
$('passcode').onkeydown = e => { if (e.key === 'Enter') publish(); };
$('btnRemark').onclick = () => state.all && state.all.length ? remarkDialog($('brSelect').value) : toast('Load a report first.');
$('btnExport').onclick = () => state.all && state.all.length ? exportExcel() : toast('Load a report first.');
$('btnLogout').onclick = () => { store.set('hmvPass', null); store.set('hmvAdmin', null); location.reload(); };
$('bzCopy').onclick = copyBreaches; $('bzMail').onclick = mailBreaches;
$('remRefresh').onclick = loadRemarks;
$('modalClose').onclick = closeModal;
$('modal').onclick = e => e.target === $('modal') && closeModal();
document.addEventListener('keydown', e => e.key === 'Escape' && !$('modal').hidden && closeModal());
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', render);

/* start */
const savedPw = store.get('hmvPass');
if (savedPw) unlock(savedPw); else {
  // probe the backend so a local/offline copy still works
  fetch(API + '/auth').then(r => { if (r.status === 401 || r.status === 500) lock(r.status === 500 ? 'The dashboard is not fully set up yet (passwords / database).' : ''); else offlineMode(); }).catch(offlineMode);
}
