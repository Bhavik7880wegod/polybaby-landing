import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const sql = neon(process.env.DATABASE_URL);

export default async function handler() {
  try {
    const [c] = await sql`
      SELECT next_id, wins, losses, pending,
             ROUND(100.0 * wins / NULLIF(wins + losses, 0), 1)::float AS accuracy,
             updated_at
      FROM call_counter
      LIMIT 1
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
