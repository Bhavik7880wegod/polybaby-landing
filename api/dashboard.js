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
    const [counterRows, recentRows, pnlRows, insiderRows, leagueRows] = await Promise.all([
      // Counter — global totals across ALL categories (politics included)
      sql`
        SELECT next_id, wins, losses, pending,
               ROUND(100.0 * wins / NULLIF(wins + losses, 0), 1)::float AS accuracy,
               updated_at
        FROM call_counter
        LIMIT 1
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
      // Per-league breakdown — every non-Insider call grouped by sport.
      // Includes archived rows so each league shows its full lifetime record
      // (otherwise older wins like Cricket #457 hide in the Others residual).
      sql`
        SELECT
          COALESCE(sport, 'OtherSports') AS sport,
          COUNT(*)::int AS calls,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          SUM(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 ELSE 0 END)::int AS resolved
        FROM calls
        WHERE (category IS NULL OR NOT (category = ANY(${INSIDER_CATEGORIES})))
          AND (sport    IS NULL OR NOT (sport    = ANY(${INSIDER_CATEGORIES})))
        GROUP BY COALESCE(sport, 'OtherSports')
        ORDER BY calls DESC
      `,
    ]);

    const counter = counterRows[0];
    if (!counter) {
      return new Response(
        JSON.stringify({ error: 'no counter row' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Per-league rows — every non-Insider call grouped by canonical league.
    // Sport labels are written by brain's deriveSport() (see
    // polymarket-discord-monitor/src/brain/db-mirror.ts) using Polymarket
    // tags, so they're already canonical (NBA, NFL, Soccer, Esports, etc.).
    // We filter out leagues with 0 calls so off-season sports don't render
    // as empty rows. Headline / per-league sum gap is explained via tooltip.
    const categories = (leagueRows || [])
      .filter(r => Number(r.calls || 0) > 0)
      .map(r => {
        const wins = Number(r.wins || 0);
        const losses = Number(r.losses || 0);
        const resolved = Number(r.resolved || 0);
        return {
          label: r.sport,
          calls: Number(r.calls || 0),
          wins,
          losses,
          resolved,
          winRate: resolved > 0
            ? Math.round((wins / resolved) * 1000) / 10
            : null,
        };
      });

    // "Others" bucket — derived as residual against the headline counter so
    // that sum-of-leagues + Others = headline total exactly. Absorbs:
    //   - Politics + Crypto (the original Insider allowlist)
    //   - Pre-Neon-migration calls (no per-call record exists in the DB)
    // The label stays "Others" because the bucket's composition is mixed.
    const sumLeagueCalls   = categories.reduce((s, c) => s + (c.calls   || 0), 0);
    const sumLeagueWins    = categories.reduce((s, c) => s + (c.wins    || 0), 0);
    const sumLeagueLosses  = categories.reduce((s, c) => s + (c.losses  || 0), 0);
    const headlineTotalCalls = (counter.wins || 0) + (counter.losses || 0) + (counter.pending || 0);
    const othersCalls   = Math.max(0, headlineTotalCalls       - sumLeagueCalls);
    const othersWins    = Math.max(0, (counter.wins   || 0) - sumLeagueWins);
    const othersLosses  = Math.max(0, (counter.losses || 0) - sumLeagueLosses);
    const othersResolved = othersWins + othersLosses;
    const insider = {
      labels: INSIDER_CATEGORIES,
      displayLabel: 'Others',
      calls: othersCalls,
      wins: othersWins,
      losses: othersLosses,
      resolved: othersResolved,
      winRate: othersResolved > 0
        ? Math.round((othersWins / othersResolved) * 1000) / 10
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
