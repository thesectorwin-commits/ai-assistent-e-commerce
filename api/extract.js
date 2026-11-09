import OpenAI from 'openai';

// Reads OPENAI_API_KEY from the environment — same key used by /api/chat.
const client = new OpenAI();

// gpt-4o-mini by default — same override knob as /api/chat.
const MODEL_ID = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 2000;
// whole-conversation cap, not just per-message — same reasoning as /api/chat
const MAX_TOTAL_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 15000;

// Best-effort in-memory rate limiter, scoped to this endpoint only (each Vercel function
// file is its own module/instance, so this doesn't share a budget with /api/chat's — an
// acceptable simplification for a demo). Same caveat as /api/chat: not a hard guarantee
// across cold starts or multiple instances, just cheap protection for the common case.
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

// Dynamic slot filling: pull whatever ski-equipment parameters a free-text message
// already states, so the scripted flow only asks for what's still missing instead of
// re-asking a questionnaire the customer already answered in one sentence. The LLM only
// extracts values — every hard-filter decision (does size fit, is budget met, etc.)
// still happens in the deterministic frontend code that consumes this response.
const EXTRACT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ozon_slot_extract',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        category: { type: ['string', 'null'], enum: ['лыжи', 'ботинки', 'палки', 'шлем', 'маска', null] },
        style: { type: ['string', 'null'], enum: ['beg', 'mid', 'adv', null] },
        height_cm: { type: ['number', 'null'] },
        weight_kg: { type: ['number', 'null'] },
        shoesize: { type: ['number', 'null'] },
        budget_max: { type: ['number', 'null'] },
        color: { type: ['string', 'null'] },
      },
      required: ['category', 'style', 'height_cm', 'weight_kg', 'shoesize', 'budget_max', 'color'],
      additionalProperties: false,
    },
  },
};

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

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    res.status(400).json({ error: 'Invalid messages payload', requestId });
    return;
  }
  let totalChars = 0;
  for (const m of messages) {
    const roleOk = m && (m.role === 'user' || m.role === 'assistant');
    const contentOk = m && typeof m.content === 'string' && m.content.length <= MAX_MESSAGE_CHARS;
    if (!roleOk || !contentOk) {
      res.status(400).json({ error: 'Invalid message shape', requestId });
      return;
    }
    totalChars += m.content.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    res.status(400).json({ error: 'Conversation history too large', requestId });
    return;
  }

  try {
    const completion = await client.chat.completions.create(
      {
        model: MODEL_ID,
        messages,
        response_format: EXTRACT_SCHEMA,
        max_tokens: 300,
        // this is pure structured extraction, not open-ended writing — temperature 0
        // makes it consistently pick the same reading of a given sentence instead of
        // occasionally sampling a worse one (seen: "рост 185" extracted fine on one call,
        // missed on the next with the exact same input)
        temperature: 0,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) {
      log('error', 'empty_response', { model: MODEL_ID });
      res.status(502).json({ error: 'Model did not return a response', requestId });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('error', 'invalid_json', { model: MODEL_ID });
      res.status(502).json({ error: 'Model did not return valid structured output', requestId });
      return;
    }

    log('info', 'extract_completed', { model: MODEL_ID, usage: completion.usage || null });

    res.status(200).json(parsed);
  } catch (err) {
    const isTimeout = err?.name === 'APIConnectionTimeoutError' || /timeout/i.test(err?.message || '');
    log('error', isTimeout ? 'upstream_timeout' : 'upstream_error', { message: err?.message, name: err?.name });
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'Upstream model timed out' : 'Upstream model error',
      requestId,
    });
  }
}
