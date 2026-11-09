import OpenAI from 'openai';
import { exceedsBudget } from './_budget.js';

// Reads OPENAI_API_KEY from the environment — set it in Vercel project settings,
// never commit it or send it to the client.
const client = new OpenAI();

// gpt-4o-mini by default (cheap + fast, supports structured outputs) — override
// with OPENAI_MODEL in Vercel env vars without touching code.
const MODEL_ID = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;
// whole-conversation cap, not just per-message — 40 messages each just under the
// per-message limit would still add up to something slow/expensive to send upstream
const MAX_TOTAL_CHARS = 24000;
const MAX_CANDIDATE_IDS = 20;
const MAX_ID_CHARS = 60;
const REQUEST_TIMEOUT_MS = 20000;

// Best-effort in-memory rate limiter. Vercel serverless functions do NOT guarantee
// shared memory across invocations — a cold start gets a fresh module, and traffic can
// land on a different instance or region entirely — so this is not a hard guarantee
// under real load. It stops the easy case (one warm instance getting hammered) for
// free; an actual guarantee needs a shared store outside process memory (e.g. Upstash
// Redis), which is out of scope for this demo.
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

// opportunistic cleanup so stale buckets don't accumulate forever on a long-lived warm
// instance — called probabilistically rather than every request, since exactness here
// doesn't matter and a Map scan on every single request would be wasteful
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

// The model does not get to write free-text "why" prose anymore — that was an
// unverified field rendered straight into the page (why="..." could claim anything,
// including something contradicting the candidate's real data). Instead it tags each
// pick with which known attributes justify it; the frontend turns those tags into
// display text itself, generated only from the candidate's real fields. A tag that
// doesn't apply just doesn't render — there is no path from model prose to the DOM.
const REASON_TAGS = ['price', 'discount', 'rating', 'delivery', 'stock', 'color', 'size', 'specs', 'complement', 'category'];

// round 3.3 P0-3: small closed color vocabulary (mirrors the client's own COLOR_KEYWORDS)
// used only for the narrow reply-vs-data color-availability check below — NOT a general
// text classifier, just enough to catch "claims color X is unavailable when candidate data
// says X is available", the specific failure mode found via E2E audit.
const COLOR_CLAIM_CHECKS = [
  { name: 'Чёрный', re: /черн|чёрн/i }, { name: 'Синий', re: /син/i }, { name: 'Красный', re: /красн/i },
  { name: 'Белый', re: /бел/i }, { name: 'Жёлтый', re: /жёлт|желт/i }, { name: 'Зелёный', re: /зелен|зелён/i },
  { name: 'Серый', re: /\bсер(ый|ая|ое|ые|ого|ой|ым|ом)\b/i }, { name: 'Оранжевый', re: /оранж/i },
  { name: 'Розовый', re: /розов/i }, { name: 'Фиолетовый', re: /фиолет/i }
];
const NEGATIVE_AVAILABILITY_RE = /нет в наличии|нет\b|недоступ\w*|отсутств\w*|закончил\w*|есть только|доступен только|доступна только|доступно только/i;
// true when a negative-availability phrase and some other regex's mention sit close
// together in `reply` (either order) — a same-message proximity check, not full sentence
// parsing. Generalized in round 4.1 (was color-only) — reused for size negation too.
function NEGATIVE_CLAIM_NEAR(reply, subjectRe) {
  const forward = new RegExp('(?:' + NEGATIVE_AVAILABILITY_RE.source + ')[^.!?\\n]{0,40}(?:' + subjectRe.source + ')', 'i');
  const backward = new RegExp('(?:' + subjectRe.source + ')[^.!?\\n]{0,40}(?:' + NEGATIVE_AVAILABILITY_RE.source + ')', 'i');
  return forward.test(reply) || backward.test(reply);
}

// round 4.1: extend the round-3.3 P0-3 narrow prose-vs-data guardrail (previously color
// only) to the other most-unambiguous, highest-risk factual claim types GPT flagged after
// the referential-resolution work landed. Still deliberately NOT a general NLI/fact-checker
// — each check below looks for one specific claim SHAPE (a number next to a currency
// symbol, a percent next to "скидка", a brand name from a small closed list, etc.) and
// cross-references it against `candidateInfoById` (the same validated candidate data
// already used for structured-output checks). "Комплектация" and open-ended specs/
// characteristics are deliberately NOT covered here — see the checkSpecsClaim comment
// below for why.

function checkColorClaim(reply, candidateInfoById) {
  const hit = COLOR_CLAIM_CHECKS.find(({ re }) => re.test(reply) && NEGATIVE_CLAIM_NEAR(reply, re));
  if (!hit) return null;
  for (const info of candidateInfoById.values()) {
    if (Array.isArray(info.colors) && info.colors.includes(hit.name)) {
      return { type: 'color', claim: 'negative-but-available', value: hit.name };
    }
  }
  return null;
}

// price: any "<number> ₽/руб" mention must approximately equal SOME candidate's current
// price OR its oldPrice (a reply legitimately citing the pre-discount price, e.g. "было
// 22370 ₽", shouldn't be flagged as a contradiction of the current 14990 ₽ price), OR the
// difference between two known prices (a comparison reply citing "дороже на 7 000 ₽").
// A small tolerance (max of 500 ₽ or 2%) absorbs natural-language rounding — found via a
// second user report: a real comparison reply naming an accurate price (e.g. "около 39 000
// ₽" for an actual 38 990 ₽ item) still got flagged as a mismatch by exact-equality
// checking, even after the round-4.1 delta fix. This still rejects a genuinely fabricated
// number (materially different from anything real), just not a rounded restatement of one.
// Root cause found via live debugging (not just rounding): the model sometimes formats a
// price with a COMMA thousands separator ("38,990 рублей", English style) instead of a
// space ("38 990"). The old character class [\d\s] doesn't include a comma, so the match
// silently restarted after it and only captured the trailing "990" as its own "price" —
// a spurious ~990 ₽ claim nowhere close to any real value, which is what was actually
// tripping the guardrail on ~2/3 of real comparison replies, not natural-language rounding.
// Comma added to the captured character class; stripped (like spaces) before parsing.
const PRICE_MENTION_RE = /(\d[\d\s,]{2,})\s*(?:₽|руб\w*)/gi;
// kept from the earlier (correct, but secondary) rounding fix — a comparison reply
// rounding a price in prose ("около 39 000 ₽" for an actual 38 990 ₽ item) is still a
// real, accurate claim, not a fabrication.
function pricesClose(a, b) {
  return Math.abs(a - b) <= Math.max(500, a * 0.02);
}
function checkPriceClaim(reply, candidateInfoById) {
  const knownPrices = [...candidateInfoById.values()]
    .flatMap(info => [info.price, info.oldPrice])
    .filter(p => typeof p === 'number');
  for (const m of reply.matchAll(PRICE_MENTION_RE)) {
    const n = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    if (!isFinite(n)) continue;
    const matchesDirect = knownPrices.some(p => pricesClose(p, n));
    const matchesDelta = !matchesDirect && knownPrices.some((p1, i) =>
      knownPrices.some((p2, j) => i !== j && pricesClose(Math.abs(p1 - p2), n)));
    if (!matchesDirect && !matchesDelta) {
      // include a text snippet around the flagged number — without this, a false-positive
      // report is unactionable (the raw reply is discarded, never returned to the client)
      const idx = m.index || 0;
      const snippet = reply.slice(Math.max(0, idx - 30), idx + m[0].length + 10);
      return { type: 'price', claim: 'mismatch', value: n, knownPrices, snippet };
    }
  }
  return null;
}

// discount: "N%" mentioned within ~20 chars of "скидк" must equal SOME candidate's real
// discount field
const DISCOUNT_MENTION_RE = /скидк\w*[^.!?\n]{0,20}?(\d{1,3})\s*%|(\d{1,3})\s*%[^.!?\n]{0,20}?скидк\w*/i;
function checkDiscountClaim(reply, candidateInfoById) {
  const m = reply.match(DISCOUNT_MENTION_RE);
  if (!m) return null;
  const n = parseInt(m[1] || m[2], 10);
  const matchesAny = [...candidateInfoById.values()].some(info => typeof info.discount === 'number' && info.discount === n);
  return matchesAny ? null : { type: 'discount', claim: 'mismatch', value: n };
}

// size: a number near "размер" — positive ("размер 45 есть/подходит") must fall within
// SOME candidate's sizeRange; negative ("размера 45 нет") must NOT fall within any
// candidate's sizeRange (mirrors the color check's negative-availability logic)
const SIZE_MENTION_RE = /размер\w*[^.!?\n]{0,15}?(\d{2})\b/gi;
function checkSizeClaim(reply, candidateInfoById) {
  for (const m of reply.matchAll(SIZE_MENTION_RE)) {
    const n = parseInt(m[1], 10);
    if (n < 20 || n > 60) continue; // outside any plausible shoe/boot size — not a size claim
    const sizeExists = [...candidateInfoById.values()].some(info =>
      Array.isArray(info.sizeRange) && n >= info.sizeRange[0] && n <= info.sizeRange[1]);
    const sizeRe = new RegExp('размер\\w*[^.!?\\n]{0,15}?' + n);
    const isNegative = NEGATIVE_CLAIM_NEAR(reply, sizeRe);
    if (isNegative && sizeExists) return { type: 'size', claim: 'negative-but-available', value: n };
    if (!isNegative && !sizeExists) return { type: 'size', claim: 'positive-but-unavailable', value: n };
  }
  return null;
}

// stock: generic (not color-specific) in-stock/out-of-stock claim about the product as a
// whole, cross-checked against the `stock` field
function checkStockClaim(reply, candidateInfoById) {
  const negative = /нет в наличии|закончил\w*|раскуплен\w*/i.test(reply);
  if (negative) {
    const anyInStock = [...candidateInfoById.values()].some(info => typeof info.stock === 'number' && info.stock > 0);
    if (anyInStock) return { type: 'stock', claim: 'negative-but-in-stock' };
    return null;
  }
  const positive = /\bв наличии\b/i.test(reply);
  if (positive) {
    const knownStock = [...candidateInfoById.values()].filter(info => typeof info.stock === 'number');
    const noneInStock = knownStock.length > 0 && knownStock.every(info => info.stock === 0);
    if (noneInStock) return { type: 'stock', claim: 'positive-but-out-of-stock' };
  }
  return null;
}

// brand: a small closed list of brand names actually used in this catalog — flags only a
// mention of a RECOGNIZED brand that doesn't appear in any current candidate's name (e.g.
// calling a Head boot "Salomon"). Not a general brand extractor — an unrecognized/unusual
// brand word is simply not checked, same "minimal, not exhaustive" trade-off as elsewhere.
const KNOWN_BRANDS = ['Nordica', 'Head', 'Salomon', 'Atomic', 'Elan', 'Thule', 'Leki', 'POC', 'Rossignol', 'Völkl', 'Volkl', 'Uvex'];
function checkBrandClaim(reply, candidateInfoById) {
  for (const brand of KNOWN_BRANDS) {
    const re = new RegExp('\\b' + brand + '\\b', 'i');
    if (!re.test(reply)) continue;
    const matchesAny = [...candidateInfoById.values()].some(info => typeof info.name === 'string' && re.test(info.name));
    if (!matchesAny) return { type: 'brand', claim: 'mismatch', value: brand };
  }
  return null;
}

// Deliberately NOT implemented as a deterministic check: open-ended specs/characteristics
// ("водонепроницаемость", "состав", "комплектация") have no closed vocabulary or
// structured ground-truth field the way color/price/discount/size/stock/brand do — there's
// no finite list of "characteristics" to scan for the way COLOR_CLAIM_CHECKS or
// KNOWN_BRANDS works. GPT's own instruction was explicit: don't build NLI/fact-checking for
// this. The existing anti-fabrication prompt instruction in LLM_INSTRUCTIONS (client-side)
// already covers this case — verified via E2E (round 3 TC-D01/D02): asked about a
// characteristic absent from `specs`, the model correctly says "не указано" rather than
// inventing a value. That's a prompt-level safeguard, not a server-side deterministic one —
// documented here as a conscious scope boundary, not an oversight.

const PROSE_FACT_CHECKS = [
  { name: 'color', check: checkColorClaim },
  { name: 'price', check: checkPriceClaim },
  { name: 'discount', check: checkDiscountClaim },
  { name: 'size', check: checkSizeClaim },
  { name: 'stock', check: checkStockClaim },
  { name: 'brand', check: checkBrandClaim }
];
const PROSE_FACT_FALLBACKS = {
  color: 'Уточняю наличие по цветам — по имеющимся данным этот вариант всё же может подойти, давайте я пришлю точный список подходящих цветов отдельным сообщением.',
  price: 'Дайте уточню точную цену по актуальным данным и вернусь с ответом.',
  discount: 'Дайте уточню точный размер скидки по актуальным данным и вернусь с ответом.',
  size: 'Дайте уточню точную доступность этого размера по актуальным данным и вернусь с ответом.',
  stock: 'Дайте уточню актуальное наличие и вернусь с ответом.',
  brand: 'Дайте уточню точный бренд по актуальным данным и вернусь с ответом.',
  default: 'Дайте уточню детали по актуальным данным и вернусь с ответом.'
};

const REPLY_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ozon_reply',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        items: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              reasons: { type: 'array', maxItems: 4, items: { type: 'string', enum: REASON_TAGS } },
            },
            required: ['id', 'reasons'],
            additionalProperties: false,
          },
        },
        // which single item (if any) `reply` is presenting as THE recommendation, as
        // opposed to items that are just alternatives/comparisons/complements sitting
        // alongside it. null whenever there's no single favorite (multiple equal
        // alternatives, a purely informational reply, or no recommendation at all).
        // Nullable-required, not optional — OpenAI's strict structured-output mode
        // requires every property to always be present as a key.
        primaryItemId: { type: ['string', 'null'] },
      },
      required: ['reply', 'items', 'primaryItemId'],
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

  const { messages, candidateIds, candidates, constraints } = req.body || {};
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

  // The frontend sends the exact set of product ids its retrieval step surfaced to the
  // model this turn. We re-check the model's answer against that set ourselves instead of
  // trusting the client to have filtered honestly — a compromised or buggy client could
  // otherwise get a hallucinated/out-of-catalog id all the way to render. No candidateIds
  // in the request (e.g. an older client, or a caller that forgot) means nothing is
  // whitelisted, so every returned item gets stripped — fail closed, not open.
  let candidateSet = new Set();
  if (candidateIds !== undefined) {
    const idsOk = Array.isArray(candidateIds)
      && candidateIds.length <= MAX_CANDIDATE_IDS
      && candidateIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS);
    if (!idsOk) {
      res.status(400).json({ error: 'Invalid candidateIds payload', requestId });
      return;
    }
    candidateSet = new Set(candidateIds);
  }

  // candidates (optional): the actual price/color/size data behind each candidateId, so
  // the model's answer can be checked against reality, not just against "is this id one
  // of the ids we offered". Absent or malformed candidates simply means no semantic
  // cross-check happens for this request (falls back to id-membership only, same as
  // before this was added) — it never widens what candidateIds already allows.
  let candidateInfoById = new Map();
  if (candidates !== undefined) {
    const candidatesOk = Array.isArray(candidates) && candidates.length <= MAX_CANDIDATE_IDS
      && candidates.every(c => c && typeof c.id === 'string' && c.id.length <= MAX_ID_CHARS);
    if (candidatesOk) {
      for (const c of candidates) candidateInfoById.set(c.id, c);
    }
  }

  // constraints (optional): the hard constraints already established in the dialog
  // (budget ceiling, an explicit budget range, shoe size, a requested color, excluded
  // colors). Used only to strip a whitelisted item that itself violates one of them —
  // this is what catches a hallucination that picked a real id but ignored the budget
  // or color the customer already stated.
  const c = constraints && typeof constraints === 'object' ? constraints : {};
  const budgetMax = typeof c.budgetMax === 'number' ? c.budgetMax : null;
  const knownBudget = c.knownBudget && typeof c.knownBudget.min === 'number' && typeof c.knownBudget.max === 'number'
    ? c.knownBudget : null;
  const shoesize = typeof c.shoesize === 'number' ? c.shoesize : null;
  const requiredColor = typeof c.requiredColor === 'string' ? c.requiredColor : null;
  const excludedColors = Array.isArray(c.excludedColors) ? c.excludedColors.filter(x => typeof x === 'string') : [];
  // round 3.3 P0-2: fail-closed server-side backstop for the client's active-category
  // filter — an E2E audit found a client-side retrieval bug let a wrong-category product
  // (gift-category headphones) reach the model as a "candidate" for a boots query. Same
  // defense-in-depth principle as every other constraint here: don't just trust the client
  // filtered honestly.
  const requiredCategory = typeof c.requiredCategory === 'string' ? c.requiredCategory : null;

  function violatesKnownConstraints(id) {
    const info = candidateInfoById.get(id);
    if (!info) return false; // no data to check against — id-membership check already covers this
    if (budgetMax != null && exceedsBudget(info.price, budgetMax)) return true;
    if (knownBudget && typeof info.price === 'number' && (info.price < knownBudget.min || exceedsBudget(info.price, knownBudget.max))) return true;
    if (shoesize != null && Array.isArray(info.sizeRange) && (shoesize < info.sizeRange[0] || shoesize > info.sizeRange[1])) return true;
    if (requiredColor && Array.isArray(info.colors) && !info.colors.includes(requiredColor)) return true;
    if (excludedColors.length && Array.isArray(info.colors) && info.colors.every(col => excludedColors.includes(col))) return true;
    if (requiredCategory && typeof info.equip === 'string' && info.equip !== requiredCategory) return true;
    return false;
  }

  // A reasons tag is display copy ("Как подобрали" is built from it client-side), not an
  // inert internal marker — so, same principle as violatesKnownConstraints, the model
  // doesn't get to just assert one. Each tag must be backed by a field actually present
  // on this candidate (and, for price/size/color, by a constraint that was actually
  // stated this turn) — found via E2E testing to hallucinate e.g. "specs" on a candidate
  // with no specs field, or "stock" with no stock field at all.
  function reasonIsEvidenced(tag, info) {
    switch (tag) {
      case 'discount': return typeof info.discount === 'number' && info.discount > 0;
      case 'stock': return info.stock != null;
      case 'rating': return typeof info.rating === 'number' && info.rating >= 4.5; // matches the client's own "высокий рейтинг" threshold
      case 'delivery': return typeof info.delivery === 'string' && info.delivery.length > 0;
      case 'specs': return typeof info.specs === 'string' && info.specs.length > 0;
      case 'price': return (budgetMax != null || knownBudget != null) && typeof info.price === 'number';
      case 'size': return shoesize != null && Array.isArray(info.sizeRange)
        && shoesize >= info.sizeRange[0] && shoesize <= info.sizeRange[1];
      case 'color': return !!requiredColor && Array.isArray(info.colors) && info.colors.includes(requiredColor);
      // cross-sell framing tags — no per-request signal this endpoint can check (cart
      // contents aren't sent here), left unverified rather than always stripped
      case 'complement':
      case 'category':
        return true;
      default: return false; // schema enum already prevents this; belt-and-suspenders
    }
  }

  try {
    const completion = await client.chat.completions.create(
      {
        model: MODEL_ID,
        messages,
        response_format: REPLY_SCHEMA,
        max_tokens: 1024,
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

    const rawItemCount = Array.isArray(parsed.items) ? parsed.items.length : 0;
    let droppedForConstraints = 0;
    if (Array.isArray(parsed.items)) {
      // layer 1: id whitelist — enforced server-side, the client's own filter is only a
      // second layer now, this is what actually guarantees an out-of-catalog id never ships
      parsed.items = parsed.items.filter(it => it && typeof it.id === 'string' && candidateSet.has(it.id));
      // layer 2: semantic validation — a whitelisted id can still be the wrong pick if the
      // model ignored a stated budget/size/color constraint while writing its reply. Strip
      // it independently of anything the model said, rather than trusting its own judgment
      // about hard-constraint compliance.
      const beforeSemanticCheck = parsed.items.length;
      parsed.items = parsed.items.filter(it => !violatesKnownConstraints(it.id));
      droppedForConstraints = beforeSemanticCheck - parsed.items.length;
      // reasons: keep only tags that (a) are in the enum — belt-and-suspenders, the
      // schema already constrains this — and (b) are actually evidenced by this
      // candidate's real data, so a tag can never claim something the candidate doesn't
      // have. No candidate data at all (legacy caller that sent candidateIds but not
      // candidates) means nothing can be verified, so every reason is stripped — same
      // fail-closed stance as the id whitelist.
      parsed.items.forEach(it => {
        const info = candidateInfoById.get(it.id) || null;
        it.reasons = Array.isArray(it.reasons)
          ? it.reasons.filter(r => REASON_TAGS.includes(r) && info && reasonIsEvidenced(r, info))
          : [];
      });
    }

    // primaryItemId names which item `reply` presents as THE recommendation — fail-closed
    // the same way as everything else here: if it doesn't survive as a real id in the
    // now-validated items (never in items, or was in items but got stripped above by the
    // whitelist/semantic checks), null it out rather than trust the model's own claim.
    if (typeof parsed.primaryItemId !== 'string' || !Array.isArray(parsed.items) || !parsed.items.some(it => it.id === parsed.primaryItemId)) {
      parsed.primaryItemId = null;
    }

    // The whitelist and semantic checks above only ever protected `items` — but `reply`
    // is free text written by the model in the SAME completion, before it knew anything
    // would be stripped, so it can still describe/recommend a product that never survives
    // validation. Two distinct cases, found via E2E testing:
    //   1. candidateIds was never sent at all (candidateIdsMissing) — nothing could ever
    //      be legitimately whitelisted this turn, so no recommendation-shaped reply can be
    //      trusted, regardless of what the model put in items.
    //   2. the model DID put an id in items, but it got stripped (out-of-whitelist, or a
    //      semantic constraint violation) — its reply almost certainly still describes
    //      that now-invalid item (e.g. "нашёл вариант в вашем бюджете" naming something
    //      that is, in fact, over budget).
    // An items:[] the model chose itself with candidateIds legitimately present — even if
    // empty (retrieval genuinely found nothing) — is untouched: that's a factual answer or
    // an honest no-match the model already worded correctly, not an invalidated attempt.
    const candidateIdsMissing = candidateIds === undefined;
    const recommendationInvalidated = candidateIdsMissing || (rawItemCount > 0 && (!parsed.items || parsed.items.length === 0));
    if (recommendationInvalidated) {
      parsed.reply = 'Не нашёл вариант, который точно подходит под все условия — уточните, пожалуйста, что важнее всего, и я предложу точнее.';
    }

    // round 3.3 P0-3: `reply` is free text, never covered by the items/reasons validation
    // above — found via E2E audit: reply claimed a color was unavailable for a candidate
    // whose own `colors` field said otherwise (a real hallucination the structured-output
    // checks can't see, since items/reasons were technically fine). Deliberately narrow,
    // not a general NLI system: the app already works with a small closed color vocabulary
    // (COLOR_KEYWORDS client-side), so a targeted "does reply deny a color this candidate
    // actually has" check is tractable and catches exactly the failure mode that was found.
    // False positives are possible (e.g. a reply nuancing "item A lacks it, item B has it"
    // gets caught too) — acceptable per the same fail-safe trade-off as the rest of this
    // system: a safe generic fallback beats a confident factual contradiction.
    if (!recommendationInvalidated && typeof parsed.reply === 'string' && candidateInfoById.size > 0) {
      for (const { name, check } of PROSE_FACT_CHECKS) {
        const contradiction = check(parsed.reply, candidateInfoById);
        if (!contradiction) continue;
        log('warn', 'reply_fact_claim_contradicted', { checkName: name, ...contradiction, requestId });
        parsed.reply = PROSE_FACT_FALLBACKS[name] || PROSE_FACT_FALLBACKS.default;
        break; // one contradiction is enough to distrust the whole reply — same principle
               // as the rest of this file's fail-safe checks, don't try to salvage the rest
      }
    }

    log('info', 'chat_completed', {
      model: MODEL_ID,
      usage: completion.usage || null,
      candidateCount: candidateSet.size,
      itemsReturnedByModel: rawItemCount,
      itemsDroppedForConstraints: droppedForConstraints,
      itemsAfterValidation: parsed.items ? parsed.items.length : 0,
      recommendationInvalidated,
      primaryItemId: parsed.primaryItemId,
    });

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
