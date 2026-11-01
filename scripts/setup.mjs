#!/usr/bin/env node
// scripts/setup.mjs — one cross-platform setup for studi0 (no bash/ps1 twins).
// Checks runtimes, detects AI harnesses (never installs them), picks free ports,
// writes repo-root .env, then installs + builds. Run: `pnpm setup`.
// Pure helpers (port pick, .env parse) are exported for tests; main only runs
// when invoked directly.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';
const FORCE = process.argv.includes('--force');

export const PORT_KEYS = { api: 'PORT', oc: 'OC_PORT', vite: 'VITE_PORT', preview: 'PREVIEW_PORT' };
export const PORT_DEFAULTS = { api: 3001, oc: 44096, vite: 5173, preview: 4173 };
export const PIP_PINS = [
  { pkg: 'graphifyy', spec: 'graphifyy==0.9.95', want: (v) => v === '0.9.95' },
  {
    pkg: 'pypdf',
    spec: 'pypdf>=6,<7',
    want: (v) => Number(v.match(/^(\d+)/)?.[1]) === 6,
  },
];

// optional skills install (opt-in): graphify skill for direct opencode use.
// sources may drift — registry name is the fallback; failure is a warning, never fatal.
const SKILL_NAME = 'graphify';
const SKILL_SOURCES = ['https://github.com/graphify-labs/graphify', 'graphify-labs/graphify'];
const SKILLS_CLI_PIN = '1.7.4'; // pnpm view skills — re-pin deliberately (typosquat/regression guard)
const WITH_SKILLS = process.argv.includes('--with-skills');

function run(bin, argv, opts = {}) {
  const { shell, ...spawnOpts } = opts;
  // shell:true + args-array triggers DEP0190 — pass a pre-joined command line instead
  const r = shell
    ? spawnSync([bin, ...argv].join(' '), {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
        shell: true,
        ...spawnOpts,
      })
    : spawnSync(bin, argv, { windowsHide: true, encoding: 'utf8', timeout: 10_000, ...spawnOpts });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/** Can we bind 127.0.0.1:port right now? */
export function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

/** First free port at `start`, then start+1 … (+20). `busy` is injectable for tests. */
export async function pickFreePort(start, busy = portBusy) {
  for (let p = start; p < start + 20 && p <= 65535; p++) {
    if (!(await busy(p))) return p;
  }
  throw new Error(`no free port at or above ${start} (tried ${start}–${start + 19})`);
}

export function parseEnvFile(text) {
  const vals = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vals[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return vals;
}

function readEnvFile() {
  const p = path.join(repoRoot, '.env');
  return existsSync(p) ? parseEnvFile(readFileSync(p, 'utf8')) : {};
}

/** Merge KEY=VALUE changes into repo-root .env, preserving other lines. */
export function writeEnvFile(changes, { exists = existsSync(path.join(repoRoot, '.env')), read = (p) => readFileSync(p, 'utf8'), write = (p, t) => writeFileSync(p, t) } = {}) {
  const p = path.join(repoRoot, '.env');
  let lines = exists ? read(p).split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  for (const [k, v] of Object.entries(changes)) {
    // sink validation: keys are plain identifiers, values never carry newlines/$ (env injection)
    if (!/^[A-Za-z0-9_]+$/.test(k) || /[\r\n$]/.test(String(v))) {
      throw new Error(`unsafe .env change: ${k}`);
    }
    const re = new RegExp(`^(\\s*${k}\\s*=)(.*)$`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = lines[i].replace(re, `$1${v}`);
    else lines.push(`${k}=${v}`);
  }
  write(p, `${lines.join('\n')}\n`);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= 20, label: `node ${process.versions.node}` };
}

function checkPnpm() {
  const r = run('pnpm', ['--version'], { shell: isWin });
  return {
    ok: r.ok,
    label: r.ok ? `pnpm ${r.out.split(/\r?\n/)[0]}` : 'pnpm not found — run: corepack enable',
  };
}

function checkPython() {
  // same try-order as the server (subjects/files.ts runPython): POSIX python3
  // first, Windows python then the py launcher
  const candidates = isWin
    ? [{ bin: 'python', prefix: [] }, { bin: 'py', prefix: ['-3'] }]
    : [{ bin: 'python3', prefix: [] }, { bin: 'python', prefix: [] }];
  for (const c of candidates) {
    const r = run(c.bin, [...c.prefix, '--version']);
    const m = (r.out || r.err).match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!r.ok || !m) continue;
    const minorOk = Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 12);
    return {
      ok: minorOk,
      bin: c.bin,
      prefix: c.prefix,
      label: `python ${m[0].replace('Python ', '')}${minorOk ? '' : ' — need ≥3.12 for the graph pipeline'}`,
    };
  }
  return { ok: false, label: 'python 3 not found — install ≥3.12 (graph pipeline needs it)' };
}

function pipVersion(py, pkg) {
  const r = run(py.bin, [...py.prefix, '-m', 'pip', 'show', pkg]);
  if (!r.ok) return null;
  return r.out.match(/^Version: (.+)$/m)?.[1] ?? null;
}

function ensurePipPkgs(py) {
  const lines = [];
  const install = [...py.prefix, '-m', 'pip', 'install', ...PIP_PINS.map((p) => p.spec)];
  const missing = PIP_PINS.filter((pin) => {
    const have = pipVersion(py, pin.pkg);
    return !(have && pin.want(have));
  });
  if (missing.length === 0) {
    return PIP_PINS.map((p) => `✔ pip: ${p.pkg} ${pipVersion(py, p.pkg)} already satisfied`);
  }
  // one pip call installs every missing pin (satisfied pins are left alone by pip)
  process.stdout.write(`+ ${py.bin} ${install.join(' ')}\n`);
  const r = run(py.bin, install, { timeout: 0 });
  lines.push(
    r.ok
      ? `✔ pip: installed ${missing.map((p) => p.spec).join(', ')}`
      : `✗ pip: install failed — ${r.err.split(/\r?\n/).slice(-2).join(' | ')}`,
  );
  return lines;
}

/** `--version` probe → installed; optional cheap auth probe → logged in / not. */
function checkCli(name, authProbe) {
  const v = run(name, ['--version'], { shell: isWin });
  if (!v.ok) return { ok: false, label: `${name}: not installed (never auto-installed — see docs)` };
  const version = v.out.split(/\r?\n/)[0];
  if (authProbe) {
    const a = run(name, authProbe.argv, { shell: isWin });
    if (a.ok) {
      return a.out
        ? { ok: true, label: `${name}: ${version} — logged in, ready` }
        : { ok: false, label: `${name}: installed, not logged in — run: ${authProbe.hint}` };
    }
  }
  return { ok: true, label: `${name}: ${version} (login state unknown — run \`${name}\` once to log in)` };
}

/** Optional opt-in: install the graphify skill for direct opencode use (never fatal). */
async function maybeInstallGraphifySkill(oc, pnpmOk) {
  if (!oc.ok || !pnpmOk) return '– skills install skipped (needs opencode + pnpm)';
  const yes =
    WITH_SKILLS ||
    (process.stdin.isTTY &&
      (await new Promise((res) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question('install the graphify skill for direct opencode use? [y/N] ', (a) => {
          rl.close();
          res(/^\s*y(es)?\s*$/i.test(a));
        });
      })));
  if (!yes) return '– skills install skipped (opt in: `pnpm setup --with-skills`)';
  for (const src of SKILL_SOURCES) {
    process.stdout.write(`+ pnpm dlx skills@${SKILLS_CLI_PIN} add ${src} -g -y --skill ${SKILL_NAME}\n`);
    const r = run('pnpm', ['dlx', `skills@${SKILLS_CLI_PIN}`, 'add', src, '-g', '-y', '--skill', SKILL_NAME], {
      shell: isWin,
      timeout: 0,
    });
    if (r.ok) return `✔ skills: ${SKILL_NAME} installed for opencode (${src})`;
    console.log(`  skills source failed: ${src}`);
  }
  return `⚠ skills install failed for every source — setup continues; try \`pnpm dlx skills add ${SKILL_NAME} -g -y\` later`;
}

  /** Is the holder of this port one of OUR services? ( possession + shape, per service) */
  async function isOurStack(port, svc) {
    const get = (path, timeout = 1500) =>
      fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeout) }).catch(() => null);
    try {
      if (svc === 'api') {
        const res = await get('/api/health');
        if (!res?.ok) return false;
        const body = await res.json();
        return body?.ok === true && typeof body?.opencode === 'object';
      }
      if (svc === 'oc') {
        const res = await get('/api/info'); // an opencode serve answers here (401 counts)
        return res !== null;
      }
      if (svc === 'vite' || svc === 'preview') {
        const res = await get('/');
        if (!res?.ok) return false;
        const html = await res.text();
        return /studi0|@vite\/client/i.test(html);
      }
      return false;
    } catch {
      return false;
    }
  }

  async function pickPorts() {
    const envFile = readEnvFile();
    const picks = [];
    const notes = [];
    for (const [svc, key] of Object.entries(PORT_KEYS)) {
      const configured = envFile[key] ?? process.env[key] ?? String(PORT_DEFAULTS[svc]);
      const def = String(PORT_DEFAULTS[svc]);
      // stale override: configured differs from default, but OUR service runs on the default → revert
      if (String(configured) !== def && !isNaN(Number(def)) && (await portBusy(Number(def))) && (await isOurStack(Number(def), svc))) {
        picks.push({ svc, key, configured, free: Number(def), ours: true });
        notes.push(`${key}=${configured} is stale — a running studi0 ${svc} uses the default :${def}; reverting`);
        continue;
      }
      const start = Number(configured);
      const base = Number.isInteger(start) && start > 0 ? start : PORT_DEFAULTS[svc];
      let free = base;
      let ours = false;
      if (await portBusy(base)) {
        if (await isOurStack(base, svc)) {
          // our own live service holds the port — keep the default, never migrate
          ours = true;
          notes.push(`:${base} is busy with a running studi0 ${svc} — keeping ${key}=${base}`);
        } else {
          free = await pickFreePort(base);
          if (free !== base) notes.push(`:${base} held by another app — ${key} auto-picked :${free}`);
        }
      }
      picks.push({ svc, key, configured, free, ours });
    }
    const changes = picks
      .filter((p) => String(p.free) !== String(p.configured))
      .reduce((acc, p) => ({ ...acc, [p.key]: p.free }), {});
    return { picks, changes, notes };
  }

async function main() {
  const rows = [];
  const notes = [];

  rows.push(['node', checkNode()]);
  const pnpm = checkPnpm();
  rows.push(['pnpm', pnpm]);
  const py = checkPython();
  rows.push(['python', py]);
  const oc = checkCli('opencode', { argv: ['auth', 'list'], hint: 'opencode auth login' });
  rows.push(['opencode', oc]);
  rows.push(['claude', checkCli('claude')]);
  rows.push(['codex', checkCli('codex')]);

  if (pnpm.ok && py.ok) notes.push(...ensurePipPkgs(py));
  else notes.push('– pip installs skipped (need python ≥3.12; fix python above and re-run `pnpm setup`)');
  notes.push(await maybeInstallGraphifySkill(oc, pnpm.ok));

  const { picks, changes, notes: portNotes } = await pickPorts();
  notes.push(...portNotes);
  const envPath = path.join(repoRoot, '.env');
  if (Object.keys(changes).length > 0) {
    if (existsSync(envPath) && !FORCE) {
      notes.push(`✗ .env exists — refusing to update (${Object.keys(changes).join(', ')}). Re-run with --force.`);
    } else {
      writeEnvFile(changes);
      notes.push(`✔ .env written: ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  } else {
    notes.push('✔ ports as configured are free — no .env changes needed');
  }

  console.log('\nstudi0 setup');
  console.log('────────────');
  for (const [name, r] of rows) console.log(`${r.ok ? '✔' : '✗'} ${name.padEnd(9)} ${r.label}`);
  console.log('');
  for (const { svc, configured, free, ours } of picks) {
    const busy = String(free) !== String(configured);
    const tag = ours ? 'ours — kept' : busy ? `(configured :${configured} busy — using :${free}, written to .env)` : 'free';
    console.log(`${busy && !ours ? '↻' : '✔'} ${svc.padEnd(8)} :${String(free).padEnd(6)} ${tag}`);
  }
  console.log('');
  for (const n of notes) console.log(n);
  console.log('');

  if (pnpm.ok) {
    for (const argv of [['install'], ['run', 'build']]) {
      process.stdout.write(`+ pnpm ${argv.join(' ')} …\n`);
      const r = isWin
        ? spawnSync(['pnpm', ...argv].join(' '), { shell: true, stdio: 'inherit', windowsHide: true })
        : spawnSync('pnpm', argv, { stdio: 'inherit', windowsHide: true });
      if (r.status !== 0) {
        console.log(`✗ pnpm ${argv.join(' ')} failed (exit ${r.status}) — fix and re-run pnpm setup`);
        break;
      }
    }
  }

  console.log('\nnext steps');
  console.log('──────────');
  if (!oc.ok || oc.label.includes('not logged in')) {
    console.log('  • install/log in opencode (chat + practice need it): https://opencode.ai — then `opencode auth login`');
  }
  if (!py.ok) console.log('  • install python ≥3.12, then re-run `pnpm setup` for the pinned pip packages');
  console.log('  • pnpm dev        # API + web + managed opencode serve');
  console.log('  • pnpm stop       # stop everything (graceful)');
  console.log('  • docs/BUILD.md   # manual setup + platform notes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
