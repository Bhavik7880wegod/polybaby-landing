import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

export default async function handler() {
  try {
    const [counterRows, categoryRows, recentRows, pnlRows] = await Promise.all([
      sql`
        SELECT
          next_id, wins, losses, pending,
          ROUND(100.0 * wins / NULLIF(wins + losses, 0), 1)::float AS accuracy,
          updated_at
        FROM call_counter
        LIMIT 1
      `,
      sql`
        SELECT
          COALESCE(sport, category) AS label,
          COUNT(*)::int AS calls,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          SUM(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 ELSE 0 END)::int AS resolved
        FROM calls
        WHERE COALESCE(sport, category) IS NOT NULL
          AND COALESCE(sport, category) <> 'Other'
        GROUP BY label
        HAVING COUNT(*) >= 3
        ORDER BY calls DESC
        LIMIT 12
      `,
      sql`
        SELECT
          call_number, market_question, market_url,
          COALESCE(sport, category) AS sport,
          side, entry_price::float8 AS entry_price,
          verdict, verdict_emoji, confidence, confidence_emoji,
          outcome, timestamp, updated_at
        FROM calls
        WHERE archived = FALSE OR archived IS NULL
        ORDER BY call_number DESC
        LIMIT 20
      `,
      sql`
        SELECT
          call_number,
          EXTRACT(EPOCH FROM timestamp::timestamptz) * 1000 AS ts_ms,
          (CASE
            WHEN outcome = 'WIN' AND entry_price > 0 THEN (1.0 / entry_price - 1) * 100
            WHEN outcome = 'LOSS' THEN -100
            ELSE 0
          END)::float8 AS profit
        FROM calls
        WHERE outcome IN ('WIN', 'LOSS')
        ORDER BY timestamp ASC
      `,
    ]);

    const counter = counterRows[0];
    if (!counter) {
      return new Response(
        JSON.stringify({ error: 'no counter row' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const categories = categoryRows.map(r => ({
      label: r.label,
      calls: r.calls,
      wins: r.wins,
      losses: r.losses,
      resolved: r.resolved,
      winRate: r.resolved > 0 ? Math.round((r.wins / r.resolved) * 1000) / 10 : null,
    }));

    const recentCalls = recentRows.map(r => ({
      callNumber: r.call_number,
      sport: r.sport,
      marketTitle: r.market_question,
      marketUrl: r.market_url,
      side: r.side,
      entryPrice: r.entry_price,
      verdict: r.verdict,
      verdictEmoji: r.verdict_emoji,
      confidence: r.confidence,
      confidenceEmoji: r.confidence_emoji,
      outcome: r.outcome,
      returnPct: r.outcome === 'WIN' && r.entry_price > 0
        ? Math.round((1 / r.entry_price - 1) * 100)
        : null,
      timestamp: r.timestamp,
      updatedAt: r.updated_at,
    }));

    let cumulative = 0;
    const pnlSeries = pnlRows.map(r => {
      cumulative += Number(r.profit);
      return {
        callNumber: r.call_number,
        ts: Number(r.ts_ms),
        cumulativeReturn: Math.round(cumulative * 100) / 100,
      };
    });

    const body = {
      counter: {
        wins: counter.wins,
        losses: counter.losses,
        pending: counter.pending,
        nextId: counter.next_id,
        total: counter.wins + counter.losses,
        accuracy: counter.accuracy != null ? counter.accuracy.toFixed(1) : '0.0',
      },
      categories,
      recentCalls,
      pnlSeries,
      lastUpdated: counter.updated_at,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'database query failed', detail: String(e) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
