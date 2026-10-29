// GET /api/v1/calls
//   ?status=pending|resolved|all   (default pending; pending requires an API key)
//   ?sport=NBA                      exact match on the sport label
//   ?since=2026-09-01T00:00:00Z     posted_at >= since
//   ?before=1500                    call_number < before (cursor for paging)
//   ?limit=50                       1..200
//
// Resolved history is public: it's the same record the site already shows.
// Pending calls are the product, so they need Authorization: Bearer <key>.
import { sql, checkKey, json, preflight, serializeCall } from '../_lib/api.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  const q = url.searchParams;

  const status = (q.get('status') || 'pending').toLowerCase();
  if (!['pending', 'resolved', 'all'].includes(status)) {
    return json({ error: 'status must be pending, resolved, or all' }, 400);
  }
  if (status !== 'resolved') {
    const auth = checkKey(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
  }

  const sport = q.get('sport') || null;
  const since = q.get('since') || null;
  if (since && Number.isNaN(Date.parse(since))) return json({ error: 'since must be an ISO timestamp' }, 400);
  const beforeRaw = q.get('before');
  const before = beforeRaw == null ? null : Number(beforeRaw);
  if (before != null && !Number.isInteger(before)) return json({ error: 'before must be an integer call_number' }, 400);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit') || 50) || 50));

  try {
    // One static query; every filter is a nullable parameter so the tagged
    // template stays fully parameterized.
    const rows = await sql`
      SELECT call_number, market_id, market_question, market_slug, market_url,
             category, sport, side, entry_price, confidence, verdict, signal_types,
             total_volume, distinct_wallets, public_yes, public_no, smart_yes, smart_no,
             divergence_gap, outcome, "timestamp", updated_at
      FROM calls
      WHERE archived IS NOT TRUE
        AND CASE ${status}
              WHEN 'pending'  THEN (outcome IS NULL OR outcome NOT IN ('WIN','LOSS'))
              WHEN 'resolved' THEN outcome IN ('WIN','LOSS')
              ELSE TRUE END
        AND (${sport}::text IS NULL OR sport = ${sport})
        AND (${since}::timestamptz IS NULL OR "timestamp" >= ${since}::timestamptz)
        AND (${before}::int IS NULL OR call_number < ${before}::int)
      ORDER BY call_number DESC
      LIMIT ${limit}
    `;
    const calls = rows.map(r => serializeCall(r));
    const next = calls.length === limit ? calls[calls.length - 1].call_number : null;
    return json(
      { count: calls.length, next_before: next, calls },
      200,
      { 'cache-control': status === 'resolved' ? 'public, max-age=60' : 'no-store' },
    );
  } catch (err) {
    return json({ error: 'query failed', detail: String(err.message || err) }, 500);
  }
}
