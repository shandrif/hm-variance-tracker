/* HM Variance Tracker — reads the store mapping workbook (Master_Location_Mapping.xlsx or the Span of Control).
   Shared by the browser (manual upload) and the Worker (SharePoint sync), so both read the file the same way.
   Input: rows of cells (array of arrays). Output: [{code, branch, am, aom, rm}]. */
(function (g) {
  'use strict';
  // same fixes as the Wastage Tracker sync
  const CODE_FIXES = { 'TAIF SHIFA': 'B118', 'SAUDI INVESTMENT BANK': 'B11', 'AL RAJHI BANK': 'B05', 'ABHA DABAB': 'B74', 'AL AHSA 2': 'B76' };
  const normCode = c => { const m = String(c || '').toUpperCase().match(/^B0*(\d+)$/); return m ? 'B' + m[1] : String(c || '').toUpperCase(); };
  const tidy = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  /* column finders — works for the Span of Control sheet and for Master_Location_Mapping.xlsx */
  const isCode = x => /^(B\s*)?CODE$|^(BRANCH|STORE|LOCATION|SITE)\s*(CODE|NO\.?|NUMBER|#)$|^B[- ]?CODE$/.test(x);
  const isName = x => !isCode(x) && /^(BRANCH|STORE|LOCATION|SITE)(\s*NAME)?\b/.test(x) && !/MANAGER|TYPE|STATUS|FORMAT|CITY|REGION/.test(x);
  const isAm = x => x.startsWith('AREA MANAGER') || x === 'AM' || x === 'AREA MGR';
  const isAom = x => /\bAOM\b/.test(x) || x.includes('AREA OPERATION');
  const isRom = x => /\bROM\b/.test(x) || x.includes('REGIONAL');

  function parseSpan(aoa) {
    let h = -1, hdr;
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const r = (aoa[i] || []).map(x => tidy(x).toUpperCase());
      if (r.some(isAm) && (r.some(isName) || r.some(isCode))) { h = i; hdr = r; break; }
    }
    if (h < 0) throw new Error('Could not find the branch/store and “Area Manager” columns.');
    const ci = f => hdr.findIndex(f);
    const cB = ci(isName), cA = ci(isAm), cO = ci(isAom), cR = ci(isRom), cC = ci(isCode);
    const rows = [], seen = new Set();
    for (const r of aoa.slice(h + 1)) {
      if (!r) continue;
      const name = cB >= 0 ? tidy(r[cB]) : '';
      let code = cC >= 0 ? tidy(r[cC]) : '';
      if (!name && !code) continue;
      if (/^\d{1,3}$/.test(code)) code = 'B' + code;            // "48" → B48
      if (!/^B\s*0*\d{1,3}$/i.test(code)) { const m = (name.match(/^B\s*0*(\d{1,3})\b/i) || code.match(/\bB\s*0*(\d{1,3})\b/i)); code = m ? 'B' + m[1] : ''; }
      const branch = name.replace(/^B\s*\d+\s*[-–,]?\s*/i, '').trim() || code;
      code = normCode(CODE_FIXES[branch.toUpperCase()] || code.replace(/\s+/g, ''));
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push({ code, branch, am: tidy(r[cA]), aom: cO >= 0 ? tidy(r[cO]) : '', rm: cR >= 0 ? tidy(r[cR]) : '' });
    }
    if (!rows.length) throw new Error('No branch rows found.');
    return rows;
  }
  /* try the sheet called "New" first, then every other sheet */
  function parseSpanWorkbook(XLSX, wb) {
    let err = null, best = null;
    for (const n of wb.SheetNames) {
      try {
        const rows = parseSpan(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }));
        if (n.toLowerCase() === 'new') return { rows, sheet: n };
        if (!best || rows.length > best.rows.length) best = { rows, sheet: n };
      } catch (e) { err = e; }
    }
    if (best) return best;
    throw err || new Error('The workbook has no sheets.');
  }
  g.HMSpan = { parseSpan, parseSpanWorkbook, normCode, CODE_FIXES };
})(typeof globalThis !== 'undefined' ? globalThis : window);
