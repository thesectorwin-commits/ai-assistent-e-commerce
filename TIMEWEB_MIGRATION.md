# Self-hosting on a Timeweb VPS (access from Russia without VPN)

Why: Vercel, Netlify and Cloudflare Pages were unreachable from Russian mobile networks, so the site runs on a
Moscow VPS. OpenAI rejects Russian IPs (`unsupported_country_region_territory`), so API calls go through a relay.

```
Browser (RU) -> nginx (HTTPS) -> Express (selfhost/server.js, systemd) -> Deno Deploy relay -> api.openai.com
```

Vercel keeps working unchanged: the root `package.json` has no `express`; the server lives in `selfhost/` with its own
`package.json`, which Vercel never reads.

## Layout

| Piece | Where |
|---|---|
| Express entry | `selfhost/server.js` (mounts the same `api/*.js` handlers, serves `index.html` and `images/` only) |
| Express dependency | `selfhost/package.json` (+ lockfile) |
| OpenAI relay code | `cf-relay/worker.js` is the Cloudflare variant (does NOT work: CF forwards the client country); the live relay is a Deno Deploy playground, code below |
| Server app dir | `/opt/market-ai` (needs `npm ci --omit=dev` in the root AND in `selfhost/`) |
| Service | `market-ai.service` (systemd, user `app`, `ExecStart=/usr/bin/node selfhost/server.js`) |
| Secrets/env | `/etc/market-ai.env`: `PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (root, mode 600) |
| nginx | `/etc/nginx/sites-available/` (one vhost per site), certificates via `certbot --nginx` |

## Deno relay (Deno Deploy playground)

`OPENAI_BASE_URL=https://<app>.<org>.deno.net/<RELAY_SECRET>/v1`. The first path segment must equal the
`RELAY_SECRET` env var of the playground; anything else returns 404. The key itself is never stored in the relay: it
arrives in the `Authorization` header from our server.

```ts
const STRIP = ['host','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','forwarded','cf-connecting-ip','cf-ipcountry','true-client-ip'];
Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const secret = Deno.env.get('RELAY_SECRET');
  if (!secret || parts[1] !== secret) return new Response('Not found', { status: 404 });
  url.pathname = '/' + parts.slice(2).join('/');
  url.protocol = 'https:'; url.hostname = 'api.openai.com'; url.port = '';
  const headers = new Headers(request.headers);
  for (const k of STRIP) headers.delete(k);
  const init: any = { method: request.method, headers, body: request.body, duplex: 'half' };
  return fetch(url, init);
});
```

Check from the server: `curl https://<relay>/<secret>/v1/models` must answer `401 Missing bearer authentication`
(= reached OpenAI). A `403 unsupported_country...` means the relay is blocked.

## Manual deploy (until CI/CD exists)

```bash
cd <repo> && tar czf - index.html images api selfhost/server.js selfhost/package.json selfhost/package-lock.json package.json \
  | ssh -i ~/.ssh/timeweb_ed25519 root@<IP> 'tar xzf - -C /opt/market-ai && cd /opt/market-ai && npm install --omit=dev --no-audit --no-fund && (cd selfhost && npm ci --omit=dev --no-audit --no-fund) && chown -R app:app /opt/market-ai && systemctl restart market-ai'
```

## Adding another site on the same IP

1. Create a free name at duckdns.org (up to 5) pointing to the server IP.
2. Start the new app as its own systemd service on a free port (3001, 3002, ...).
3. Add an nginx vhost (`server_name <name>`, `proxy_pass http://127.0.0.1:<port>`), `nginx -t && systemctl reload nginx`.
4. `certbot --nginx -d <name> --redirect`.
RAM is the limit (about 900 MB total; the Node app uses about 80 MB).

## Hardening already applied

SSH is key-only (`/etc/ssh/sshd_config.d/00-hardening.conf`: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`),
ufw allows only SSH/HTTP/HTTPS, fail2ban is active.

## Gotchas

- OpenAI billing is prepaid; when credits reach 0 the chat answers "model did not respond".
- A VPN on the admin machine can swallow traffic to the server; add a direct route to the server IP if needed.
- The rate limiter reads `x-forwarded-for`; nginx sets it, so limits are per visitor.
