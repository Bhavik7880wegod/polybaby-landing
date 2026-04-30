import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// INSIDER_CATEGORIES is the allowlist of categories surfaced together
// as the "Insider only" / paid-tier bucket on the public dashboard.
// Categories listed here are excluded from the visible top-12 and
// aggregated into the Insider row instead. Their stats still count
// toward the headline counter and the cumulative P&L chart so the
// headline numbers stay honest.
//
// To add a category (e.g., a future "TechEarnings" premium bucket),
// append the label here and redeploy — the dashboard label, stats,
// and tooltip auto-update.
const INSIDER_CATEGORIES = ['Politics', 'Crypto'];
const HIDE_LABELS = INSIDER_CATEGORIES;

export default async function handler() {
  try {
    const [counterRows, categoryRows, recentRows, pnlRows, insiderRows] = await Promise.all([
      // Counter — global totals across ALL categories (politics included)
      sql`
        SELECT next_id, wins, losses, pending,
               ROUND(100.0 * wins / NULLIF(wins + losses, 0), 1)::float AS accuracy,
               updated_at
        FROM call_counter
        LIMIT 1
      `,
      // Categories — exclude Insider categories so the visible top-12
      // never includes Politics or Crypto (those join the Insider row).
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
          AND NOT (COALESCE(sport, category) = ANY(${INSIDER_CATEGORIES}))
        GROUP BY label
        HAVING COUNT(*) >= 5
        ORDER BY calls DESC
        LIMIT 12
      `,
      // Recent calls — hide Insider categories from the public stream.
      sql`
        SELECT
          call_number, market_question, market_url,
          COALESCE(sport, category) AS sport,
          side, entry_price::float8 AS entry_price,
          verdict, verdict_emoji, confidence, confidence_emoji,
          outcome, timestamp, updated_at
        FROM calls
        WHERE (archived = FALSE OR archived IS NULL)
          AND (category IS NULL OR NOT (category = ANY(${INSIDER_CATEGORIES})))
          AND (sport    IS NULL OR NOT (sport    = ANY(${INSIDER_CATEGORIES})))
        ORDER BY call_number DESC
        LIMIT 20
      `,
      // P&L series — include ALL resolved calls (Insider included)
      // so the cumulative chart matches the headline counter.
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
      // Insider aggregate — explicit allowlist (NOT residual), so this
      // bucket's composition is locked to INSIDER_CATEGORIES. Adding a new
      // sport / market type elsewhere never accidentally affects this row.
      sql`
        SELECT
          COUNT(*)::int AS calls,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          SUM(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 ELSE 0 END)::int AS resolved
        FROM calls
        WHERE COALESCE(sport, category) = ANY(${INSIDER_CATEGORIES})
      `,
    ]);

    const counter = counterRows[0];
    if (!counter) {
      return new Response(
        JSON.stringify({ error: 'no counter row' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Win-rate sample-size floor — never claim a rate on tiny denominators.
    // Below this threshold, winRate stays null and the UI shows "—" so a
    // category with a 7-0 record reads as "we don't have enough data yet"
    // rather than a misleading 100%.
    const RATE_MIN_RESOLVED = 10;
    const categories = categoryRows.map(r => ({
      label: r.label,
      calls: r.calls,
      wins: r.wins,
      losses: r.losses,
      resolved: r.resolved,
      winRate: r.resolved >= RATE_MIN_RESOLVED
        ? Math.round((r.wins / r.resolved) * 1000) / 10
        : null,
    }));

    // Insider bucket — driven by the INSIDER_CATEGORIES allowlist so the
    // composition is intentional and stable. Adding a new sport elsewhere
    // never reshapes this. Win rate updates only as Insider categories'
    // calls resolve.
    const insiderRow = insiderRows[0] || {};
    const insiderResolved = (insiderRow.wins || 0) + (insiderRow.losses || 0);
    const insider = {
      labels: INSIDER_CATEGORIES,
      calls: insiderRow.calls || 0,
      wins: insiderRow.wins || 0,
      losses: insiderRow.losses || 0,
      resolved: insiderResolved,
      winRate: insiderResolved > 0
        ? Math.round((insiderRow.wins / insiderResolved) * 1000) / 10
        : null,
    };
    // Back-compat aliases — keep older client field names working.
    const categoriesHiddenCount = insider.calls;
    const categoriesHidden = {
      count: insider.calls,
      wins: insider.wins,
      losses: insider.losses,
      resolved: insider.resolved,
      winRate: insider.winRate,
    };

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
      insider,
      categoriesHiddenCount,
      categoriesHidden,
      recentCalls,
      pnlSeries,
      lastUpdated: counter.updated_at,
      hidden: HIDE_LABELS,
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
