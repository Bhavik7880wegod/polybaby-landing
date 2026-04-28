#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BRAIN_ROOT = process.env.BRAIN_ROOT ?? path.join(os.homedir(), 'polybaby-brain', 'Polymarket');
const CALLS_DIR = path.join(BRAIN_ROOT, 'calls');
const OUT = process.env.STATS_OUT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'stats.json');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const body = m[1];
  const obj = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    obj[kv[1]] = v;
  }
  return obj;
}

const files = fs.readdirSync(CALLS_DIR).filter(f => /^call-\d+\.md$/.test(f));
const calls = [];
for (const f of files) {
  const fm = parseFrontmatter(fs.readFileSync(path.join(CALLS_DIR, f), 'utf8'));
  if (fm && fm.call_number != null) calls.push(fm);
}
calls.sort((a, b) => a.call_number - b.call_number);

const resolved = calls.filter(c => c.outcome === 'win' || c.outcome === 'loss');
const wins = resolved.filter(c => c.outcome === 'win').length;
const losses = resolved.filter(c => c.outcome === 'loss').length;
const pending = calls.filter(c => c.outcome === 'pending').length;
const total = wins + losses;
const accuracy = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

const recentResolved = resolved.slice(-10);
const last10Wins = recentResolved.filter(c => c.outcome === 'win').length;
const last10Losses = recentResolved.length - last10Wins;
const last_10 = `${last10Wins}W-${last10Losses}L`;

let streak = '—';
if (resolved.length > 0) {
  const latest = resolved[resolved.length - 1].outcome;
  let n = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].outcome === latest) n++; else break;
  }
  streak = `${n}${latest === 'win' ? 'W' : 'L'}`;
}

const recent_calls = calls.slice(-10).map(c => ({
  call_number: c.call_number,
  market: typeof c.market_question === 'string' ? c.market_question.slice(0, 80) : '',
  side: c.side ?? '',
  outcome: c.outcome ?? 'pending',
  verdict: c.verdict ?? ''
}));

const stats = {
  wins,
  losses,
  pending,
  total,
  accuracy,
  streak,
  last_10,
  recent_calls,
  updated_at: new Date().toISOString()
};

fs.writeFileSync(OUT, JSON.stringify(stats, null, 2) + '\n');
console.log(`✓ wrote ${OUT} — ${wins}W / ${losses}L (${accuracy}%) · streak ${streak} · last 10 ${last_10}`);
