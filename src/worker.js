/* HM Variance Tracker — Cloudflare Worker entry: /api/* goes to the API, everything else is the static site */
import { handleApi } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return handleApi(request, env, path);
    }
    return env.ASSETS.fetch(request);
  }
};
