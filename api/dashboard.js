import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

// Politics is the only category hidden from public dashboard surface.
// Politics calls are still written to Neon by the brain — we just don't
// surface them in the visible UI. They DO factor into the aggregate
// counter and the cumulative P&L chart so headline numbers stay honest.
const HIDE_LABELS = ['Politics'];

export default async function handler() {
  try {
    const [counterRows, categoryRows, recentRows, pnlRows, cohortRows, rosterRows] = await Promise.all([
      // Counter — global totals across ALL categories (politics included)
      sql`
        SELECT next_id, wins, losses, pending,
               ROUND(100.0 * wins / NULLIF(wins + losses, 0), 1)::float AS accuracy,
               updated_at
        FROM call_counter
        LIMIT 1
      `,
      // Categories — hide Politics only; everything else shows
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
          AND COALESCE(sport, category) <> 'Politics'
        GROUP BY label
        HAVING COUNT(*) >= 3
        ORDER BY calls DESC
        LIMIT 12
      `,
      // Recent calls — hide Politics
      sql`
        SELECT
          call_number, market_question, market_url,
          COALESCE(sport, category) AS sport,
          side, entry_price::float8 AS entry_price,
          verdict, verdict_emoji, confidence, confidence_emoji,
          outcome, timestamp, updated_at
        FROM calls
        WHERE (archived = FALSE OR archived IS NULL)
          AND (category IS NULL OR category <> 'Politics')
        ORDER BY call_number DESC
        LIMIT 20
      `,
      // P&L series — include ALL resolved calls (politics included)
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
      // Smart Money Pool — cohort summary across tracked Polymarket wallets.
      // Identities stay masked (nicknames only); no addresses leave the API.
      sql`
        SELECT
          COUNT(*)::int AS wallets_tracked,
          COALESCE(SUM(wins), 0)::int AS total_wins,
          COALESCE(SUM(losses), 0)::int AS total_losses,
          COALESCE(SUM(pending), 0)::int AS total_pending,
          ROUND(100.0 * SUM(wins) / NULLIF(SUM(wins) + SUM(losses), 0), 1)::float
            AS cohort_win_rate
        FROM traders
        WHERE (COALESCE(wins, 0) + COALESCE(losses, 0) + COALESCE(pending, 0)) >= 5
      `,
      // Top roster — top 10 tracked wallets by win rate, with their best
      // (most-active) category. Min 10 resolved bets to filter noise.
      // Politics excluded from category attribution.
      sql`
        WITH active AS (
          SELECT nickname, win_rate, wins, losses, pending,
                 (COALESCE(wins, 0) + COALESCE(losses, 0)) AS resolved
          FROM traders
          WHERE (COALESCE(wins, 0) + COALESCE(losses, 0)) >= 10
            AND win_rate IS NOT NULL
        ),
        top_traders AS (
          SELECT * FROM active
          ORDER BY win_rate DESC, resolved DESC
          LIMIT 10
        ),
        per_sport AS (
          SELECT
            tb.trader_nick,
            tb.category,
            COUNT(*) FILTER (WHERE tb.outcome = 'WIN')::int AS sport_wins,
            COUNT(*) FILTER (WHERE tb.outcome IN ('WIN','LOSS'))::int AS sport_resolved
          FROM trader_bets tb
          WHERE tb.trader_nick IN (SELECT nickname FROM top_traders)
            AND tb.category IS NOT NULL
            AND tb.category <> 'Politics'
          GROUP BY tb.trader_nick, tb.category
          HAVING COUNT(*) FILTER (WHERE tb.outcome IN ('WIN','LOSS')) >= 3
        ),
        best_sport AS (
          SELECT DISTINCT ON (trader_nick)
            trader_nick, category, sport_wins, sport_resolved,
            ROUND(100.0 * sport_wins / NULLIF(sport_resolved, 0), 0)::int AS sport_win_pct
          FROM per_sport
          ORDER BY trader_nick, sport_resolved DESC, sport_wins DESC
        )
        SELECT
          t.nickname, t.win_rate, t.resolved, t.wins, t.losses,
          bs.category AS top_category, bs.sport_win_pct AS top_win_pct
        FROM top_traders t
        LEFT JOIN best_sport bs ON bs.trader_nick = t.nickname
        ORDER BY t.win_rate DESC, t.resolved DESC
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

    const cohort = cohortRows[0] || {};
    const smartMoney = {
      walletsTracked: cohort.wallets_tracked || 0,
      cohortWinRate: cohort.cohort_win_rate != null
        ? Number(cohort.cohort_win_rate)
        : null,
      totalResolved: (cohort.total_wins || 0) + (cohort.total_losses || 0),
      totalPending: cohort.total_pending || 0,
      roster: rosterRows.map(r => ({
        nickname: r.nickname,
        winRate: r.win_rate != null ? Math.round(Number(r.win_rate) * 10) / 10 : null,
        resolved: r.resolved,
        wins: r.wins,
        losses: r.losses,
        topCategory: r.top_category || null,
        topWinPct: r.top_win_pct != null ? Number(r.top_win_pct) : null,
      })),
    };

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
      smartMoney,
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
