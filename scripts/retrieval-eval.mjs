#!/usr/bin/env node
// scripts/retrieval-eval.mjs — thin client for the retrieval eval harness.
// The work happens server-side (POST /api/subjects/:id/retrieval-eval);
// this only picks a subject, calls it, and pretty-prints the table.
// Usage: node scripts/retrieval-eval.mjs [--subject cs2107] [--gold 40]
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function apiPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    for (const line of readFileSync(path.join(repoRoot, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*PORT\s*=\s*(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {
    // no .env — default port
  }
  return 3001;
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const base = `http://127.0.0.1:${apiPort()}`;
const subjectName = arg('subject');
const gold = arg('gold', '40');

const res = await fetch(`${base}/api/subjects`);
if (!res.ok) {
  console.error(`✗ server not reachable at ${base} (start it with: pnpm dev)`);
  process.exit(1);
}
const subjects = await res.json();
const subject = subjectName
  ? subjects.find((s) => s.name === subjectName || s.id === subjectName)
  : subjects[0];
if (!subject) {
  console.error(`✗ subject not found: ${subjectName ?? '(none registered)'}`);
  process.exit(1);
}

console.log(`retrieval eval — ${subject.name} (gold=${gold})`);
console.log('building/refreshing the index on first run; graphify arm spawns one query per gold node…\n');

const started = Date.now();
const evalRes = await fetch(
  `${base}/api/subjects/${subject.id}/retrieval-eval?gold=${encodeURIComponent(gold)}`,
  { method: 'POST' },
);
if (!evalRes.ok) {
  console.error(`✗ eval failed: HTTP ${evalRes.status} — ${await evalRes.text()}`);
  process.exit(1);
}
const body = await evalRes.json();
if (body.error) {
  console.error(`✗ ${body.error}`);
  process.exit(1);
}

console.log(`gold nodes: ${body.gold.used}/${body.gold.requested}`);
console.log(`gold files: ${body.gold.files.join(', ')}`);
console.log(`wall time: ${Math.round((Date.now() - started) / 1000)}s\n`);

const templates = ['lexical', 'paraphrase'];
const rows = Object.entries(body.arms);
const width = Math.max(...rows.map(([arm]) => arm.length), 4);
console.log(`${'arm'.padEnd(width)}  ${templates.map((t) => `${t} hit@5`).join('   ')}  mean latency`);
console.log('─'.repeat(width + templates.join('x').length + 30));
for (const [arm, byTemplate] of rows) {
  const cells = templates.map((t) => String(byTemplate[t]?.hitAt5 ?? '–').padStart(9));
  const lat = Math.max(...templates.map((t) => byTemplate[t]?.meanLatencyMs ?? 0));
  console.log(`${arm.padEnd(width)}  ${cells.join('   ')}  ${lat} ms/query`);
}
