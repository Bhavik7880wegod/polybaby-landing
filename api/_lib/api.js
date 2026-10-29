// Shared helpers for /api/v1/*. Files under api/_lib are not routes on Vercel.
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

// Comma-separated keys in POLYBABY_API_KEYS. Fail closed: if the var is
// missing, keyed endpoints refuse rather than open up.
export function checkKey(req) {
  const raw = process.env.POLYBABY_API_KEYS || '';
  const keys = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (keys.length === 0) return { ok: false, status: 503, error: 'api keys not configured' };
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const key = bearer || req.headers.get('x-api-key') || '';
  if (!key || !keys.includes(key)) return { ok: false, status: 401, error: 'invalid or missing api key' };
  return { ok: true };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, x-api-key, content-type',
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

// Polymarket price (0-1) -> American odds string.
function american(p) {
  if (!(p > 0 && p < 1)) return null;
  return p < 0.5 ? `+${Math.round(((1 - p) / p) * 100)}` : `${Math.round(-(p / (1 - p)) * 100)}`;
}

// Rows where the brain never captured a price get entry_price=0.50 with
// public_yes=public_no=0.50. Consumers must not treat that as a real entry.
function priceQuality(r) {
  const e = Number(r.entry_price), py = Number(r.public_yes), pn = Number(r.public_no);
  if (e === 0.5 && py === 0.5 && pn === 0.5) return 'placeholder';
  return 'ok';
}

const num = v => (v == null ? null : Number(v));

export function serializeCall(r, { detail = false } = {}) {
  const entry = num(r.entry_price);
  const out = {
    call_number: r.call_number,
    status: r.outcome === 'WIN' || r.outcome === 'LOSS' ? 'resolved' : 'pending',
    outcome: r.outcome === 'WIN' || r.outcome === 'LOSS' ? r.outcome : null,
    market: {
      question: r.market_question,
      slug: r.market_slug,
      url: r.market_url,
      id: r.market_id,
    },
    category: r.category,
    sport: r.sport,
    side: r.side,
    entry_price: entry,
    price_quality: priceQuality(r),
    american_odds: american(entry),
    payout_on_100: entry > 0 && entry < 1 ? Math.round(100 / entry) : null,
    confidence: r.confidence,
    verdict: r.verdict,
    signal_types: r.signal_types || [],
    total_volume: num(r.total_volume),
    distinct_wallets: r.distinct_wallets,
    prices: {
      public_yes: num(r.public_yes),
      public_no: num(r.public_no),
      smart_yes: num(r.smart_yes),
      smart_no: num(r.smart_no),
      divergence_gap: num(r.divergence_gap),
    },
    posted_at: r.timestamp,
    updated_at: r.updated_at,
  };
  if (detail) out.analysis_md = r.analysis_md || null;
  return out;
}
