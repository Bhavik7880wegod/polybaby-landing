// GET /api/v1/calls/:call_number  -> one call, including analysis_md.
// Resolved calls are public; pending ones need an API key.
import { sql, checkKey, json, preflight, serializeCall } from '../../_lib/api.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const id = Number(path.slice(path.lastIndexOf('/') + 1));
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'call_number must be a positive integer' }, 400);

  try {
    const rows = await sql`
      SELECT call_number, market_id, market_question, market_slug, market_url,
             category, sport, side, entry_price, confidence, verdict, signal_types,
             total_volume, distinct_wallets, public_yes, public_no, smart_yes, smart_no,
             divergence_gap, outcome, "timestamp", updated_at, analysis_md
      FROM calls
      WHERE call_number = ${id} AND archived IS NOT TRUE
      LIMIT 1
    `;
    if (rows.length === 0) return json({ error: 'not found' }, 404);
    const r = rows[0];
    const resolved = r.outcome === 'WIN' || r.outcome === 'LOSS';
    if (!resolved) {
      const auth = checkKey(req);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
    }
    return json(serializeCall(r, { detail: true }), 200, {
      'cache-control': resolved ? 'public, max-age=300' : 'no-store',
    });
  } catch (err) {
    return json({ error: 'query failed', detail: String(err.message || err) }, 500);
  }
}
