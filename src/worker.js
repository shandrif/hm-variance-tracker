/* HM Variance Tracker — Cloudflare Worker entry: /api/* goes to the API, everything else is the static site.
   The daily cron (wrangler.toml [triggers]) pulls the Span of Control from SharePoint. */
import { handleApi } from './api.js';
import { syncSharePoint, sharePointConfigured } from './sharepoint.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return handleApi(request, env, path);
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (!env.DB || !sharePointConfigured(env)) return;   // nothing to do until SharePoint is set up
    ctx.waitUntil(syncSharePoint(env).then(r => console.log('Span of Control sync:', r.message)));
  }
};
