import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

export default async function handler() {
  try {
    // Totals derive from the calls table, NOT call_counter. The counter
    // carries ~248 pre-Neon-migration increments that have no per-call row,
    // so counter-derived accuracy (57.1%) disagreed with the row-derived
    // figure the dashboard chart is built from (55.3%). One number, one
    // meaning: everything public reads from rows. next_id still comes from
    // the counter since that's the live call-number sequence.
    const [c] = await sql`
      SELECT
        (SELECT next_id FROM call_counter LIMIT 1)     AS next_id,
        (SELECT updated_at FROM call_counter LIMIT 1)  AS updated_at,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int   AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int  AS losses,
        COUNT(*) FILTER (WHERE outcome IS NULL
                            OR outcome NOT IN ('WIN','LOSS'))::int AS pending,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE outcome = 'WIN')
          / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)
        , 1)::float AS accuracy
      FROM calls
    `;

    if (!c) {
      return new Response(
        JSON.stringify({ error: 'no counter row' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = {
      wins: c.wins,
      losses: c.losses,
      pending: c.pending,
      total: c.wins + c.losses,
      accuracy: c.accuracy != null ? c.accuracy.toFixed(1) : '0.0',
      next_id: c.next_id,
      updated_at: c.updated_at,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'database query failed', detail: String(e) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
