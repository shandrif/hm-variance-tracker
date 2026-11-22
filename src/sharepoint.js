/* HM Variance Tracker — reads the store mapping workbook (Master_Location_Mapping.xlsx) from SharePoint / OneDrive
   every morning and saves it as the branch → area manager → ROM mapping in D1.

   Cloudflare Worker secret (required):
     SP_FILE_URL   the share link to the workbook
   If the link is "Anyone with the link", that is all. If it only works for signed-in Half Million staff,
   also add an Azure app registration (application permission Files.Read.All or Sites.Read.All):
     MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
   (Alternative to SP_FILE_URL with the Azure app: SP_SITE = host:/sites/Name and SP_FILE = path in the site.) */
import * as XLSX from '../public/vendor/xlsx.full.min.js';
import '../public/span-parse.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const hasAzure = env => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
export const sharePointConfigured = env => !!(env.SP_FILE_URL || (hasAzure(env) && env.SP_SITE && env.SP_FILE));

/* "Anyone with the link" share → direct download URL */
function anonDownloadUrl(link) {
  const u = new URL(link.trim());
  const share = u.searchParams.get('share');
  if (share) {   // …/personal/<user>/_layouts/15/Doc.aspx?…&share=TOKEN
    const base = u.pathname.split('/_layouts/')[0].replace(/^\/:[a-z]:\/[a-z]/i, '');   // drop the /:x:/r prefix
    return `${u.origin}${base}/_layouts/15/download.aspx?share=${encodeURIComponent(share)}`;
  }
  if (/sharepoint\.com$/i.test(u.hostname)) u.searchParams.set('download', '1');   // …/:x:/g/personal/<user>/TOKEN
  return u.toString();
}
async function downloadAnon(link) {
  const r = await fetch(anonDownloadUrl(link), { redirect: 'follow' });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!r.ok || buf[0] !== 0x50 || buf[1] !== 0x4b)   // an .xlsx is a zip ("PK")
    throw new Error('SharePoint asked for a sign-in instead of sending the file. Either share the file as “Anyone with the link”, or add the Azure app secrets (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET).');
  const name = decodeURIComponent((link.match(/[?&]file=([^&]+)/) || [])[1] || 'Master_Location_Mapping.xlsx');
  return { buf, name, modified: r.headers.get('last-modified') };
}

async function token(env) {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || r.status).toString().split('\r\n')[0]);
  return j.access_token;
}
async function graph(path, tok) {
  const r = await fetch(GRAPH + path, { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`SharePoint (${r.status}): ${j.error && j.error.message || r.statusText}`);
  return j;
}
const enc = p => p.split('/').map(encodeURIComponent).join('/');

/* find the file, download it, return its rows */
export async function fetchSpan(env) {
  if (!hasAzure(env)) {
    const { buf, name, modified } = await downloadAnon(env.SP_FILE_URL);
    const { rows, sheet } = globalThis.HMSpan.parseSpanWorkbook(XLSX, XLSX.read(buf, { type: 'array' }));
    return { rows, sheet, name, modified };
  }
  const tok = await token(env);
  let item;
  if (env.SP_FILE_URL) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(env.SP_FILE_URL.trim())))
      .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    item = await graph(`/shares/u!${b64}/driveItem`, tok);
  } else {
    const [host, sitePath = ''] = env.SP_SITE.trim().replace(/^https?:\/\//, '').split(':');
    const site = await graph(`/sites/${host}:${enc(sitePath.startsWith('/') ? sitePath : '/' + sitePath)}`, tok);
    // SP_FILE may start with the library name ("Shared Documents/…" or "Documents/…"); the default library is the drive root
    const file = env.SP_FILE.trim().replace(/^\/+/, '').replace(/^(Shared Documents|Documents)\//i, '');
    item = await graph(`/sites/${site.id}/drive/root:/${enc(file)}`, tok);
  }
  const url = item['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('SharePoint did not return a download link for the file.');
  const buf = await (await fetch(url)).arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const { rows, sheet } = globalThis.HMSpan.parseSpanWorkbook(XLSX, wb);
  return { rows, sheet, name: item.name || 'Span of Control', modified: item.lastModifiedDateTime || null };
}

/* sync + save, refusing a file that suddenly has far fewer branches (half-edited file, wrong sheet…) */
export async function syncSharePoint(env, { force = false } = {}) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_status (id INTEGER PRIMARY KEY CHECK (id = 1),
    ok INTEGER, message TEXT, branches INTEGER, file_modified TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  const log = (ok, message, branches = null, modified = null) => env.DB.prepare(
    `INSERT INTO sync_status(id,ok,message,branches,file_modified,at) VALUES(1,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET ok=excluded.ok,message=excluded.message,branches=excluded.branches,file_modified=excluded.file_modified,at=excluded.at`)
    .bind(ok ? 1 : 0, message, branches, modified).run();
  try {
    if (!sharePointConfigured(env)) throw new Error('SharePoint sync is not set up yet: add the SP_FILE_URL secret in Cloudflare (see README).');
    const { rows, sheet, name, modified } = await fetchSpan(env);
    const cur = await env.DB.prepare('SELECT rows FROM mapping WHERE id=1').first();
    const before = cur ? JSON.parse(cur.rows).length : 0;
    if (!force && before && rows.length < before * 0.5)
      throw new Error(`The file now lists only ${rows.length} branches (was ${before}), so it was not applied. Check the file, or sync again with “apply anyway”.`);
    const source = `SharePoint · ${name} (sheet ${sheet})`;
    await env.DB.prepare(`INSERT INTO mapping(id,rows,source,updated_at) VALUES(1,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET rows=excluded.rows,source=excluded.source,updated_at=excluded.updated_at`)
      .bind(JSON.stringify(rows), source.slice(0, 200)).run();
    const withAom = rows.filter(r => r.aom).length;
    const msg = `${rows.length} branches synced`;
    await log(true, msg, rows.length, modified);
    return { ok: true, branches: rows.length, aom: withAom, source, modified, message: msg };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 500);
    await log(false, msg).catch(() => {});
    return { ok: false, message: msg };
  }
}

export async function syncStatus(env) {
  try { return await env.DB.prepare('SELECT ok,message,branches,file_modified,at FROM sync_status WHERE id=1').first(); }
  catch (e) { return null; }   // table not created yet = never synced
}
