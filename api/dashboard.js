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
      // Categories — classify each call into a canonical league using
      // sport (when set) or market_question text. The brain's deriveSport
      // regex is narrow, so most NBA/NFL/NHL/MLB games where the question
      // names teams like "Bulls vs Heat" fall into the generic Sports
      // umbrella. We re-classify at read time using a wider keyword set
      // and surface every league as its own row.
      // Insider categories (Politics, Crypto) are filtered out here and
      // surfaced separately by the insiderRows query, displayed as "Others".
      sql`
        WITH classified AS (
          SELECT
            CASE
              WHEN COALESCE(sport, category) = ANY(${INSIDER_CATEGORIES})
                THEN COALESCE(sport, category)
              WHEN sport = 'Combat' THEN 'UFC'
              WHEN sport IN ('NBA','NFL','NHL','MLB','Soccer','Esports','Cricket','F1','Tennis','Golf')
                THEN sport
              WHEN market_question ~* '(\\mnba\\M|lakers|celtics|warriors|bulls|knicks|heat|nets|76ers|sixers|bucks|suns|mavericks|\\mmavs\\M|nuggets|spurs|rockets|thunder|jazz|trail blazers|blazers|clippers|pelicans|hawks|hornets|magic|pistons|pacers|cavaliers|cavs|wizards|raptors|grizzlies|timberwolves|basketball)'
                THEN 'NBA'
              WHEN market_question ~* '(\\mnfl\\M|patriots|cowboys|eagles|chiefs|bills|49ers|niners|ravens|steelers|packers|vikings|bears|lions|dolphins|bengals|browns|broncos|raiders|chargers|texans|colts|jaguars|titans|buccaneers|saints|falcons|seahawks|rams|commanders|super bowl|\\mafc\\M|\\mnfc\\M)'
                THEN 'NFL'
              WHEN market_question ~* '(\\mnhl\\M|hockey|penguins|bruins|maple leafs|canadiens|senators|sabres|devils|islanders|flyers|capitals|hurricanes|lightning|predators|stars|avalanche|\\mwild\\M|blackhawks|\\mblues\\M|coyotes|golden knights|kraken|oilers|canucks|flames|sharks|ducks|blue jackets|red wings|stanley cup)'
                THEN 'NHL'
              WHEN market_question ~* '(\\mmlb\\M|baseball|yankees|\\mdodgers\\M|red sox|\\mcubs\\M|\\mmets\\M|astros|braves|phillies|blue jays|world series|orioles|rays|guardians|marlins|nationals|brewers|cardinals|\\mreds\\M|royals|mariners|rockies|padres|pirates|diamondbacks|\\mtigers\\M|twins|athletics|angels)'
                THEN 'MLB'
              WHEN market_question ~* '(soccer|premier league|champions league|\\mucl\\M|\\muefa\\M|bundesliga|la liga|serie a|\\mmls\\M|\\mfifa\\M|world cup|liverpool|arsenal|chelsea|man city|man united|tottenham|\\mpsg\\M|bayern|real madrid|barcelona|juventus|\\mafcon\\M|copa america)'
                THEN 'Soccer'
              WHEN market_question ~* '(esports?|counter-?strike|\\mcs2\\M|valorant|league of legends|\\mdota\\M|\\miem\\M|\\mvct\\M|\\mlol\\M)'
                THEN 'Esports'
              WHEN market_question ~* '(cricket|\\mipl\\M|\\mt20\\M|\\modi\\M)'
                THEN 'Cricket'
              WHEN market_question ~* '(formula 1|formula one|\\mf1\\M|grand prix|drivers'' champion|constructors'' champion|verstappen|hamilton|leclerc|norris|piastri|russell)'
                THEN 'F1'
              WHEN market_question ~* '(\\matp\\M|\\mwta\\M|tennis|wimbledon|us open|french open|australian open|roland.garros|djokovic|alcaraz|sinner|swiatek|sabalenka|federer|nadal)'
                THEN 'Tennis'
              WHEN market_question ~* '(\\mpga\\M|\\mlpga\\M|masters tournament|\\mgolf\\M|tiger woods|mcilroy|scheffler|augusta|ryder cup|liv golf)'
                THEN 'Golf'
              WHEN market_question ~* '(\\mufc\\M|\\mmma\\M|boxing|jon jones|conor mcgregor|khabib|ngannou|usman|adesanya|fury|joshua|alvarez|canelo)'
                THEN 'UFC'
              ELSE 'Misc'
            END AS league,
            outcome
          FROM calls
        )
        SELECT
          league AS label,
          COUNT(*)::int AS calls,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)::int AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)::int AS losses,
          SUM(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 ELSE 0 END)::int AS resolved
        FROM classified
        WHERE NOT (league = ANY(${INSIDER_CATEGORIES}))
          AND league <> 'Misc'
        GROUP BY league
        ORDER BY calls DESC
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

    // Always compute winRate when there's at least one resolved call.
    // The frontend decides display: "X%" for resolved >= 10, W-L record
    // for smaller samples, "—" for zero resolved. Keeping the raw rate in
    // the payload lets the dot-color and tooltip logic work consistently.
    const categories = categoryRows.map(r => ({
      label: r.label,
      calls: r.calls,
      wins: r.wins,
      losses: r.losses,
      resolved: r.resolved,
      winRate: r.resolved > 0
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
      // displayLabel is what visitors see on the row. Decoupled from
      // labels so we can rename ("Others") without touching the
      // underlying data shape.
      displayLabel: 'Others',
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
