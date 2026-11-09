import OpenAI from 'openai';

// Reads OPENAI_API_KEY from the environment — same key used by /api/chat.
const client = new OpenAI();

// whisper-1 by default — well-established, stable Russian transcription. Override
// with OPENAI_TRANSCRIBE_MODEL in Vercel env vars without touching code.
const MODEL_ID = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

// base64 of a short voice message. Vercel serverless functions cap the request body
// at 4.5MB, so this stays well under that (base64 inflates size by ~33%) — still
// generous for a spoken product query, which rarely runs more than 15-20 seconds.
const MAX_BASE64_CHARS = 3_000_000;
const REQUEST_TIMEOUT_MS = 20000;

// Best-effort in-memory rate limiter, scoped to this endpoint only. Same caveat as the
// other two endpoints: not a hard guarantee across cold starts / multiple instances,
// just cheap protection against one warm instance getting hammered.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateLimitBuckets = new Map(); // ip -> { count, windowStart }

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

function pruneRateLimitBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateLimitBuckets.delete(ip);
  }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function newRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default async function handler(req, res) {
  const requestId = newRequestId();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);

  const log = (level, event, extra) => {
    const line = { requestId, event, elapsedMs: Date.now() - startedAt, ...extra };
    (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  };

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed', requestId });
    return;
  }

  const ip = getClientIp(req);
  if (Math.random() < 0.02) pruneRateLimitBuckets();
  if (!checkRateLimit(ip)) {
    log('warn', 'rate_limited', { ip });
    res.status(429).json({ error: 'Too many requests, slow down', requestId });
    return;
  }

  const { audio, mimeType } = req.body || {};
  if (typeof audio !== 'string' || !audio.length || audio.length > MAX_BASE64_CHARS) {
    res.status(400).json({ error: 'Invalid audio payload', requestId });
    return;
  }

  try {
    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([buffer], `voice.${ext}`, { type: mimeType || 'audio/webm' });

    const result = await client.audio.transcriptions.create(
      {
        file,
        model: MODEL_ID,
        language: 'ru',
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    log('info', 'transcribe_completed', { model: MODEL_ID, audioBytes: buffer.length });

    res.status(200).json({ text: result.text || '' });
  } catch (err) {
    const isTimeout = err?.name === 'APIConnectionTimeoutError' || /timeout/i.test(err?.message || '');
    log('error', isTimeout ? 'upstream_timeout' : 'upstream_error', { message: err?.message, name: err?.name });
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'Upstream transcription timed out' : 'Upstream transcription error',
      requestId,
    });
  }
}
