#!/usr/bin/env node
// scripts/calibrate.mjs — probe how many concurrent headless `opencode run`
// one-shots this machine + provider sustain, then write the stable cap to
// .env as STUDI0_MAX_CHUNK_CONCURRENCY. Run: `pnpm calibrate` (re-run after
// changing providers/plans). Same spawn/kill pattern as apps/server's
// util/oneshot.ts (detached child, private --standalone server, tree kill).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isWin = process.platform === 'win32';
const CHILD_TIMEOUT_MS = 75_000;
const ROUNDS_PER_TIER = 2;
const PROMPT = 'Reply with exactly: OK';

// ── pure tier logic (exported for tests; no real opencode involved) ──

/** Fire `tier` concurrent children, `rounds` times. Passes iff every child exits 0 in time. */
export async function runTier(tier, fire, rounds = ROUNDS_PER_TIER) {
  const results = [];
  for (let r = 0; r < rounds; r++) {
    results.push(...(await Promise.all(Array.from({ length: tier }, () => fire()))));
  }
  return {
    tier,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    slowest: results.length ? Math.max(...results.map((r) => r.ms)) : 0,
    ok: results.length > 0 && results.every((r) => r.ok),
    stderrTails: results.map((r) => r.stderrTail).filter(Boolean),
  };
}

/** Highest fully-passing tier from probe-order results (stop at first failure); null if none. */
export function pickCap(results) {
  const passing = [];
  for (const r of results) {
    if (!r.ok) break;
    passing.push(r);
  }
  return passing.length ? passing[passing.length - 1].tier : null;
}

// ── the real firer (same semantics as util/oneshot.ts) ──

function resolveBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const r = spawnSync(isWin ? 'where.exe' : 'which', ['opencode'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return isWin ? null : 'opencode';
  const lines = String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (isWin) {
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
    if (exe) return exe;
    const cmd = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
    // npm global layout — the real exe lives next to the .cmd shim
    if (cmd) {
      return path.join(path.dirname(cmd), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    }
    return null;
  }
  return lines[0];
}

function killTree(pid) {
  if (pid === undefined) return;
  if (isWin) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** One headless one-shot: { ok, ms, stderrTail }. Never throws. */
function fireOnce(bin, cwd) {
  return () =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(bin, ['run', '--auto', '--standalone', PROMPT], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: !isWin, // process-group leader on POSIX — killTree reaches the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let finished = false;
      const stderr = [];
      child.stderr?.on('data', (d) => {
        if (stderr.length < 32) stderr.push(String(d));
      });
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        killTree(child.pid);
        resolve({
          ok,
          ms: Date.now() - t0,
          stderrTail: stderr.join('').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '),
        });
      };
      const timer = setTimeout(() => finish(false), CHILD_TIMEOUT_MS);
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
    });
}

async function main() {
  const bin = resolveBin();
  if (!bin) {
    console.error('opencode CLI not found — install it (https://opencode.ai) or set OPENCODE_BIN.');
    process.exit(1);
  }
  const cwd = await mkdtemp(path.join(tmpdir(), 'studi0-calibrate-'));
  const fire = fireOnce(bin, cwd);
  try {
    console.log(`calibrating chunk concurrency (child timeout ${CHILD_TIMEOUT_MS / 1000}s, ${ROUNDS_PER_TIER} rounds/tier)…`);
    const results = [];
    const queue = [2, 4, 6, 8]; // 12 is probed only if everything before it passed
    while (queue.length) {
      const tier = queue.shift();
      process.stdout.write(`tier ${tier}: firing ${tier * ROUNDS_PER_TIER} one-shots…\n`);
      const res = await runTier(tier, fire);
      results.push(res);
      console.log(`  ${res.passed}/${res.total} passed, slowest ${(res.slowest / 1000).toFixed(1)}s${res.ok ? '' : '  ✗'}`);
      if (!res.ok) break;
      if (tier === 8) queue.push(12);
    }

    console.log('\ntier  passed   slowest');
    console.log('────  ───────  ───────');
    for (const r of results) {
      console.log(`${String(r.tier).padEnd(5)} ${`${r.passed}/${r.total}`.padEnd(8)} ${(r.slowest / 1000).toFixed(1)}s`);
    }

    const cap = pickCap(results);
    if (cap === null) {
      const first = results[0];
      if (first.tier === 2 && first.passed === 0) {
        console.error('\ndiagnosis: even 2 concurrent one-shots failed — opencode is probably not');
        console.error('logged in or the model server is unreachable. Sample stderr:');
        console.error(`  ${first.stderrTails?.[0] || '(none captured)'}`);
        console.error('run `opencode auth login`, then re-run `pnpm calibrate`.');
        process.exit(1);
      }
      console.log('\nno tier fully passed — .env not written; keep the current setting (consider STUDI0_MAX_CHUNK_CONCURRENCY=1).');
      return;
    }
    console.log(`\nstable cap: ${cap}`);
    const { parseEnvFile, writeEnvFile } = await import('./setup.mjs');
    const { readFileSync, existsSync } = await import('node:fs');
    const envPath = path.join(path.resolve(import.meta.dirname, '..'), '.env');
    const current = parseEnvFile(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');
    if (current.STUDI0_MAX_CHUNK_CONCURRENCY === String(cap)) {
      console.log('.env already has it — nothing written.');
      return;
    }
    writeEnvFile({ STUDI0_MAX_CHUNK_CONCURRENCY: cap });
    console.log(`wrote STUDI0_MAX_CHUNK_CONCURRENCY=${cap} to .env (other keys untouched).`);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
