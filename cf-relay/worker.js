// Cloudflare Worker: pass-through relay to api.openai.com for hosts in regions OpenAI blocks.
// Auth: the first path segment must equal the RELAY_SECRET binding, e.g.
//   OPENAI_BASE_URL=https://<worker>.workers.dev/<RELAY_SECRET>/v1
// The OpenAI API key is NOT stored here — it arrives in the Authorization header from our server.
// Client-identifying headers are stripped so OpenAI sees the worker, not the blocked client region.
const STRIP = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-ipcountry', 'true-client-ip', 'forwarded', 'x-forwarded-proto', 'cf-ray', 'cf-visitor'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/'); // ['', secret, 'v1', ...]
    if (!env.RELAY_SECRET || parts[1] !== env.RELAY_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    url.pathname = '/' + parts.slice(2).join('/');
    url.protocol = 'https:';
    url.hostname = 'api.openai.com';
    url.port = '';
    const headers = new Headers(request.headers);
    for (const k of STRIP) headers.delete(k);
    return fetch(new Request(url, { method: request.method, headers, body: request.body }));
  },
};
