// Standalone Express entry point for self-hosting (Timeweb VPS / any Node host). Lives in selfhost/ with its own
// package.json so Vercel (which reads only the root package.json) never sees express and keeps its zero-config setup.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..'); // repo root: index.html, images/, api/
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' })); // /api/transcribe sends audio as base64

// The same four handlers Vercel runs as functions, unchanged.
for (const name of ['chat', 'extract', 'extract-intent', 'transcribe']) {
  const { default: handler } = await import(`../api/${name}.js`);
  app.all(`/api/${name}`, (req, res) => handler(req, res));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Serve only the page and images — never api/*.js sources, CLAUDE.md, package.json.
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.use('/images', express.static(path.join(root, 'images'), { maxAge: '7d' }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 413 ? 'Request too large' : 'Server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('listening on', port));
