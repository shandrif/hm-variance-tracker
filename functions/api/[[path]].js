/* HM Variance Tracker — API (Cloudflare Pages Function + D1)
   Bindings (Pages → Settings): D1 database "DB" = hm-variance-db
   Secrets: VIEW_PASSWORD (team password to open the dashboard)
            ADMIN_PASSCODE (upload / delete / mapping / read remarks) */

const CHUNK = 700 * 1024;          // D1 rows are size-limited, so reports are stored in pieces
const MAX_REPORTS = 12;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const fail = (msg, status = 400) => json({ error: msg }, status);

function same(a, b) {              // compare without leaking length/timing hints
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function roleOf(req, env) {
  const p = req.headers.get('X-Pass') || '';
  if (!p) return null;
  if (env.ADMIN_PASSCODE && same(p, env.ADMIN_PASSCODE)) return 'admin';
  if (env.VIEW_PASSWORD && same(p, env.VIEW_PASSWORD)) return 'viewer';
  return null;
}
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export async function onRequest({ request: req, env, params }) {
  if (!env.DB) return fail('Database is not connected (bind D1 as "DB").', 500);
  if (!env.VIEW_PASSWORD || !env.ADMIN_PASSCODE) return fail('Passwords are not set up yet (VIEW_PASSWORD / ADMIN_PASSCODE).', 500);

  const path = [].concat(params.path || []);
  const [res, id] = path;
  const m = req.method;
  const role = roleOf(req, env);
  if (!role) return fail('Invalid password', 401);
  const admin = role === 'admin';
  const needAdmin = () => fail('Invalid passcode — admin only', 403);

  try {
    /* who am I */
    if (res === 'auth' && m === 'GET') return json({ role });

    /* reports */
    if (res === 'reports') {
      if (m === 'GET' && !id) {
        const { results } = await env.DB.prepare(
          'SELECT id,label,from_date,to_date,file_name,row_count,meta,uploaded_at FROM reports ORDER BY from_date DESC').all();
        return json(results.map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })));
      }
      if (m === 'GET' && id) {
        const { results } = await env.DB.prepare(
          'SELECT data FROM report_chunks WHERE report_id=? ORDER BY idx').bind(id).all();
        if (!results.length) return fail('Report not found', 404);
        const parts = results.map(r => new Uint8Array(r.data));
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return new Response(out, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
      }
      if (m === 'POST') {
        if (!admin) return needAdmin();
        const u = new URL(req.url);
        const from = u.searchParams.get('from'), to = u.searchParams.get('to');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return fail('Missing report dates');
        const rid = `${from}_${to}`;
        const meta = clean(u.searchParams.get('meta'), 4000);
        const body = new Uint8Array(await req.arrayBuffer());
        if (!body.length) return fail('Empty upload');
        if (body.length > 20 * 1024 * 1024) return fail('Upload too large');
        const { results: cnt } = await env.DB.prepare('SELECT COUNT(*) n FROM reports WHERE id<>?').bind(rid).all();
        if (cnt[0].n >= MAX_REPORTS) return fail(`Report limit reached (${MAX_REPORTS}). Delete an old report first.`, 409);
        const stmts = [
          env.DB.prepare('DELETE FROM report_chunks WHERE report_id=?').bind(rid),
          env.DB.prepare(`INSERT INTO reports(id,label,from_date,to_date,file_name,row_count,meta,uploaded_at)
            VALUES(?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(id) DO UPDATE SET label=excluded.label,file_name=excluded.file_name,row_count=excluded.row_count,meta=excluded.meta,uploaded_at=excluded.uploaded_at`)
            .bind(rid, clean(u.searchParams.get('label'), 80) || rid, from, to,
                  clean(u.searchParams.get('file'), 200), +u.searchParams.get('rows') || 0, meta || null)
        ];
        for (let i = 0, k = 0; i < body.length; i += CHUNK, k++)
          stmts.push(env.DB.prepare('INSERT INTO report_chunks(report_id,idx,data) VALUES(?,?,?)').bind(rid, k, body.slice(i, i + CHUNK)));
        await env.DB.batch(stmts);
        return json({ id: rid, saved_at: new Date().toISOString() });
      }
      if (m === 'DELETE' && id) {
        if (!admin) return needAdmin();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM report_chunks WHERE report_id=?').bind(id),
          env.DB.prepare('DELETE FROM reports WHERE id=?').bind(id)
        ]);
        return json({ deleted: id });
      }
    }

    /* branch → AM → RM mapping */
    if (res === 'mapping') {
      if (m === 'GET') {
        const r = await env.DB.prepare('SELECT rows,source,updated_at FROM mapping WHERE id=1').first();
        return json(r ? { rows: JSON.parse(r.rows), source: r.source, updated_at: r.updated_at } : null);
      }
      if (m === 'PUT') {
        if (!admin) return needAdmin();
        const b = await req.json();
        if (!Array.isArray(b.rows) || !b.rows.length) return fail('No mapping rows');
        const rows = b.rows.slice(0, 500).map(r => ({ code: clean(r.code, 12), branch: clean(r.branch, 80), am: clean(r.am, 80), rm: clean(r.rm, 80) }))
          .filter(r => r.code);
        await env.DB.prepare(`INSERT INTO mapping(id,rows,source,updated_at) VALUES(1,?,?,datetime('now'))
          ON CONFLICT(id) DO UPDATE SET rows=excluded.rows,source=excluded.source,updated_at=excluded.updated_at`)
          .bind(JSON.stringify(rows), clean(b.source, 200)).run();
        return json({ saved: rows.length });
      }
      if (m === 'DELETE') {
        if (!admin) return needAdmin();
        await env.DB.prepare('DELETE FROM mapping WHERE id=1').run();
        return json({ reset: true });
      }
    }

    /* remarks: anyone with the team password can add; only admin can read / close / delete */
    if (res === 'remarks') {
      if (m === 'POST') {
        const b = await req.json();
        const author = clean(b.author, 80), remark = clean(b.remark, 1000), branch = clean(b.branch, 80);
        if (!author || !remark || !branch) return fail('Name, branch and remark are required');
        await env.DB.prepare('INSERT INTO remarks(report_id,branch,item,author,remark) VALUES(?,?,?,?,?)')
          .bind(clean(b.report_id, 40) || null, branch, clean(b.item, 160) || null, author, remark).run();
        return json({ saved: true });
      }
      if (!admin) return needAdmin();
      if (m === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM remarks ORDER BY created_at DESC LIMIT 1000').all();
        return json(results);
      }
      if (m === 'PATCH' && id) {
        const b = await req.json();
        await env.DB.prepare('UPDATE remarks SET status=? WHERE id=?').bind(b.status === 'resolved' ? 'resolved' : 'open', +id).run();
        return json({ updated: +id });
      }
      if (m === 'DELETE' && id) {
        await env.DB.prepare('DELETE FROM remarks WHERE id=?').bind(+id).run();
        return json({ deleted: +id });
      }
    }
    return fail('Not found', 404);
  } catch (e) {
    return fail('Server error: ' + (e && e.message || e), 500);
  }
}
