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
    const [counterRows, recentRows, pnlRows, insiderRows, leagueRows, monthlyRows, formRows, rowTotalRows] = await Promise.all([
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
      // Monthly P&L — the hero chart's series. One row per calendar month
      // with win rate, breakeven WR (= avg entry price, since a favorite
      // priced at 0.62 must hit 62% just to break even) and flat-$100 P&L.
      // Month bars replace the all-time cumulative line so a single bad
      // month can't bury current form.
      sql`
        SELECT
          to_char(timestamp, 'YYYY-MM') AS month,
          MIN(timestamp) AS month_start,
          COUNT(*)::int AS resolved,
          SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          (AVG(entry_price) * 100)::float8 AS breakeven_wr,
          SUM(CASE
                WHEN outcome = 'WIN' AND entry_price > 0 THEN (1.0 / entry_price - 1) * 100
                ELSE -100
              END)::float8 AS pnl
        FROM calls
        WHERE outcome IN ('WIN', 'LOSS')
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      // Rolling 30-day form — what the hero headline leads with.
      sql`
        SELECT
          COUNT(*)::int AS resolved,
          SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          (AVG(entry_price) * 100)::float8 AS breakeven_wr,
          SUM(CASE
                WHEN outcome = 'WIN' AND entry_price > 0 THEN (1.0 / entry_price - 1) * 100
                ELSE -100
              END)::float8 AS pnl
        FROM calls
        WHERE outcome IN ('WIN', 'LOSS')
          AND timestamp > now() - interval '30 days'
      `,
      // Rows-derived totals — the single source of truth for the headline.
      // call_counter carries ~248 pre-Neon-migration increments that have no
      // per-call row, so counter-derived accuracy (57.1%) and row-derived
      // accuracy (55.3%) disagreed. Everything public now reads from rows.
      sql`
        SELECT
          COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS'))::int AS resolved,
          COUNT(*) FILTER (WHERE outcome = 'WIN')::int  AS wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS')::int AS losses,
          COUNT(*) FILTER (WHERE outcome IS NULL OR outcome NOT IN ('WIN','LOSS'))::int AS pending,
          COUNT(*)::int AS total
        FROM calls
      `,
    ]);

    const counter = counterRows[0];
    // Rows-derived headline — single source of truth. See the rowTotal query
    // above for why this replaces counter-derived accuracy.
    const rowTotal = (rowTotalRows && rowTotalRows[0]) || null;
    const headline = rowTotal ? {
      wins:     Number(rowTotal.wins     || 0),
      losses:   Number(rowTotal.losses   || 0),
      pending:  Number(rowTotal.pending  || 0),
      resolved: Number(rowTotal.resolved || 0),
      total:    Number(rowTotal.total    || 0),
    } : null;
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
    // Residual is measured against the ROWS headline now, so "Others" holds
    // only Politics/Crypto — the phantom pre-migration calls it used to
    // absorb are simply not in the row-derived totals at all.
    const baseWins    = headline ? headline.wins    : (counter.wins    || 0);
    const baseLosses  = headline ? headline.losses  : (counter.losses  || 0);
    const basePending = headline ? headline.pending : (counter.pending || 0);
    const headlineTotalCalls = baseWins + baseLosses + basePending;
    const othersCalls   = Math.max(0, headlineTotalCalls - sumLeagueCalls);
    const othersWins    = Math.max(0, baseWins   - sumLeagueWins);
    const othersLosses  = Math.max(0, baseLosses - sumLeagueLosses);
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

    const pct = (w, r) => (r > 0 ? Math.round((w / r) * 1000) / 10 : null);
    const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

    // Monthly bars — each month standalone, so recovery is visible.
    const monthlySeries = (monthlyRows || []).map(r => {
      const resolved = Number(r.resolved || 0);
      const wins = Number(r.wins || 0);
      const wr = pct(wins, resolved);
      const be = r.breakeven_wr != null ? Math.round(Number(r.breakeven_wr) * 10) / 10 : null;
      return {
        month: r.month,
        ts: new Date(r.month_start).getTime(),
        resolved,
        wins,
        losses: Number(r.losses || 0),
        winRate: wr,
        breakevenWr: be,
        // Positive edge = win rate cleared the price you paid.
        edge: (wr != null && be != null) ? Math.round((wr - be) * 10) / 10 : null,
        pnl: round2(r.pnl),
      };
    });

    // Rolling 30-day form — the number the page leads with.
    const f = (formRows && formRows[0]) || null;
    const formResolved = f ? Number(f.resolved || 0) : 0;
    const formWins = f ? Number(f.wins || 0) : 0;
    const formWr = pct(formWins, formResolved);
    const formBe = f && f.breakeven_wr != null
      ? Math.round(Number(f.breakeven_wr) * 10) / 10 : null;
    const currentForm = {
      windowDays: 30,
      resolved: formResolved,
      wins: formWins,
      losses: f ? Number(f.losses || 0) : 0,
      winRate: formWr,
      breakevenWr: formBe,
      edge: (formWr != null && formBe != null)
        ? Math.round((formWr - formBe) * 10) / 10 : null,
      pnl: f ? round2(f.pnl) : 0,
    };

    const body = {
      counter: {
        wins: baseWins,
        losses: baseLosses,
        pending: basePending,
        nextId: counter.next_id,
        total: baseWins + baseLosses,
        accuracy: (pct(baseWins, baseWins + baseLosses) ?? 0).toFixed(1),
      },
      monthlySeries,
      currentForm,
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
