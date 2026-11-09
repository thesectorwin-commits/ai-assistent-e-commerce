import OpenAI from 'openai';

// Round 5 (GPT design review): semantic-understanding FALLBACK for message dispatch.
// LLM understands language; it NEVER makes the business decision. This endpoint returns
// only intent/entities/referent TYPES — never a productId, never an action, never free
// text treated as source of truth. The client resolves referents against
// dState.lastShownIds deterministically (see resolveSemanticReferents in index.html) and
// routes the result through the SAME applyStateUpdate/startEquipFlow/runComparison/
// addToCart functions the existing regex-classified intents already use — this is not a
// second, parallel state-management path.
const client = new OpenAI();

const MODEL_ID = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MAX_MESSAGE_CHARS = 2000;
const MAX_TOTAL_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 15000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateLimitBuckets = new Map();

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

// Canonical contract, finalized per GPT's round-5 review of the spike:
// - referents is an ARRAY (was a single referentType/referentIndices/referentCount trio in
//   the spike) so "сравни самый дешёвый и самый дорогой" can be expressed as TWO referent
//   entries (SHOWN_MIN_PRICE + SHOWN_MAX_PRICE) instead of needing a bespoke combined type.
// - "size" (not "shoesize") to match GPT's example field name exactly.
// - No productId/product name anywhere in this schema, by construction.
const INTENT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'intent_extract',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['EQUIPMENT_SEARCH', 'CONSTRAINT_CHANGE', 'CONSTRAINT_QUERY', 'COMPARE', 'ADD_TO_CART', 'PRODUCT_QUESTION', 'OTHER'],
        },
        category: { type: ['string', 'null'], enum: ['лыжи', 'ботинки', 'палки', 'шлем', 'маска', null] },
        constraints: {
          type: 'object',
          properties: {
            budgetMax: { type: ['number', 'null'] },
            heightCm: { type: ['number', 'null'] },
            weightKg: { type: ['number', 'null'] },
            color: { type: ['string', 'null'] },
            size: { type: ['number', 'null'] },
          },
          required: ['budgetMax', 'heightCm', 'weightKg', 'color', 'size'],
          additionalProperties: false,
        },
        referents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['ORDINAL', 'LAST_SHOWN_ALL', 'FIRST_N', 'SHOWN_MIN_PRICE', 'SHOWN_MAX_PRICE', 'CURRENT', 'NONE'],
              },
              // 0-based positions into the most-recently-shown product list ONLY.
              indices: { type: ['array', 'null'], items: { type: 'number' } },
              count: { type: ['number', 'null'] },
            },
            required: ['type', 'indices', 'count'],
            additionalProperties: false,
          },
          maxItems: 3,
        },
        confidence: { type: 'number' },
      },
      required: ['intent', 'category', 'constraints', 'referents', 'confidence'],
      additionalProperties: false,
    },
  },
};

const INTENT_INSTRUCTIONS = 'Ты — слой понимания естественного языка для чат-ассистента маркетплейса горнолыжного снаряжения. '
  + 'Твоя ЕДИНСТВЕННАЯ задача — перевести сообщение покупателя в структурированный JSON. Ты НЕ выбираешь товары, НЕ знаешь ID товаров, НЕ выполняешь действий — только классифицируешь намерение и извлекаешь то, что покупатель явно сказал. '
  + 'intent: EQUIPMENT_SEARCH — просьба подобрать/показать товар определённой категории (может содержать constraints); CONSTRAINT_CHANGE — явное изменение фильтра (бюджет/цвет/размер), включая продолжение диалога без глагола ("тогда можно до 30 тысяч"); CONSTRAINT_QUERY — вопрос о наличии варианта без явного намерения сменить фильтр ("а бывают синие?"); COMPARE — просьба сравнить уже показанные товары; ADD_TO_CART — просьба добавить конкретный уже показанный товар в корзину; PRODUCT_QUESTION — вопрос о характеристике/цене/наличии уже показанного товара, не являющийся сравнением или добавлением; OTHER — всё остальное. '
  + 'category и constraints извлекай из ЛЮБОЙ формы: цифрами, прописанными словами ("метр восемьдесят пять" = 185), с ошибками в единицах измерения. Никогда не выдумывай значение, которого нет в сообщении. '
  + 'referents (массив, обычно 0-2 элемента) описывает, на какие из НЕДАВНО ПОКАЗАННЫХ товаров ссылается покупатель (не важно, существуют ли они на самом деле — это не твоя ответственность): ORDINAL — конкретная позиция (или несколько позиций, "первый и третий" -> два элемента с indices:[0] и indices:[2] — ЛИБО один элемент с indices:[0,2], главное не терять ни одну позицию) (0-based); LAST_SHOWN_ALL — "эти"/"все эти варианты" (один элемент, без индексов); FIRST_N — "первые N вариантов" -> count; SHOWN_MIN_PRICE — "самый дешёвый"; SHOWN_MAX_PRICE — "самый дорогой" (для "самый дешёвый и самый дорогой" верни ДВА элемента: SHOWN_MIN_PRICE и SHOWN_MAX_PRICE); CURRENT — "этот"/"он" без числительного; NONE или пустой массив — сообщение не ссылается ни на какой уже показанный товар. '
  + 'confidence (0-1) — насколько ты уверен в разборе ЦЕЛИКОМ; если сообщение двусмысленно, зависит от контекста, которого у тебя нет, или ты не уверен — ставь низкое confidence вместо угадывания. Правило: лучше низкий confidence, чем ошибочно уверенный разбор. '
  + 'Верни строго один JSON-объект по схеме, без пояснений вокруг.';

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

  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.length || text.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({ error: 'Invalid text payload', requestId });
    return;
  }
  if (text.length > MAX_TOTAL_CHARS) {
    res.status(400).json({ error: 'Message too large', requestId });
    return;
  }

  try {
    const completion = await client.chat.completions.create(
      {
        model: MODEL_ID,
        messages: [
          { role: 'user', content: INTENT_INSTRUCTIONS },
          { role: 'user', content: 'Сообщение покупателя: "' + text + '"' },
        ],
        response_format: INTENT_SCHEMA,
        max_tokens: 300,
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
    // fail-closed at the source too, not just client-side: strip anything that isn't part
    // of the declared contract, in case a future prompt/model revision starts hallucinating
    // extra fields (a productId, free-text "answer", etc.) — belt-and-suspenders alongside
    // strict:true json_schema.
    const safe = {
      intent: typeof parsed.intent === 'string' ? parsed.intent : 'OTHER',
      category: typeof parsed.category === 'string' ? parsed.category : null,
      constraints: {
        budgetMax: typeof parsed.constraints?.budgetMax === 'number' ? parsed.constraints.budgetMax : null,
        heightCm: typeof parsed.constraints?.heightCm === 'number' ? parsed.constraints.heightCm : null,
        weightKg: typeof parsed.constraints?.weightKg === 'number' ? parsed.constraints.weightKg : null,
        color: typeof parsed.constraints?.color === 'string' ? parsed.constraints.color : null,
        size: typeof parsed.constraints?.size === 'number' ? parsed.constraints.size : null,
      },
      referents: Array.isArray(parsed.referents)
        ? parsed.referents.slice(0, 3).map(r => ({
            type: typeof r?.type === 'string' ? r.type : 'NONE',
            indices: Array.isArray(r?.indices) ? r.indices.filter(n => typeof n === 'number').slice(0, 4) : null,
            count: typeof r?.count === 'number' ? r.count : null,
          }))
        : [],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    };
    log('info', 'intent_extract_completed', { model: MODEL_ID, usage: completion.usage || null, intent: safe.intent, confidence: safe.confidence });
    res.status(200).json(safe);
  } catch (err) {
    const isTimeout = err?.name === 'APIConnectionTimeoutError' || /timeout/i.test(err?.message || '');
    log('error', isTimeout ? 'upstream_timeout' : 'upstream_error', { message: err?.message, name: err?.name });
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'Upstream model timed out' : 'Upstream model error',
      requestId,
    });
  }
}
