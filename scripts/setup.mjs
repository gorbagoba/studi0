#!/usr/bin/env node
// scripts/setup.mjs — one cross-platform setup for studi0 (no bash/ps1 twins).
// Scan → ask → apply: scans runtimes + harnesses + opencode bin resolution
// (never installs harnesses), asks which harness you use and how to fetch
// Python deps (pip/uv), then opt-in fixes (OPENCODE_BIN, pinned python
// packages, graphify skill targeted at YOUR harness), picks free ports,
// writes repo-root .env (incl. STUDI0_HARNESS), then installs + builds.
// Re-runnable: prompts default to your saved .env choices.
// Pure helpers (port pick, .env parse, bin resolution, harness pick) are
// exported for tests; main only runs when invoked directly.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';
const FORCE = process.argv.includes('--force');
const YES = process.argv.includes('--yes'); // consent to every download prompt (non-interactive)

export const PORT_KEYS = { api: 'PORT', oc: 'OC_PORT', vite: 'VITE_PORT', preview: 'PREVIEW_PORT' };
export const PORT_DEFAULTS = { api: 3001, oc: 44096, vite: 5173, preview: 4173 };
export const PIP_PINS = [
  // [openai]: graphify's OpenAI-compatible backend needs the openai SDK,
  // otherwise extraction/labeling silently degrades to placeholders
  { pkg: 'graphifyy', spec: 'graphifyy[openai]==0.9.95', want: (v) => v === '0.9.95' },
  {
    pkg: 'pypdf',
    spec: 'pypdf>=6,<7',
    want: (v) => Number(v.match(/^(\d+)/)?.[1]) === 6,
  },
];

/** Specs the dedicated graphify venv must hold (same pins as the global fallback). */
export const graphifyInstallSpecs = PIP_PINS.map((p) => p.spec);

// optional skills install (opt-in): graphify skill for YOUR harness.
// sources may drift — registry name is the fallback; failure is a warning, never fatal.
const SKILL_NAME = 'graphify';
const SKILL_SOURCES = ['https://github.com/graphify-labs/graphify', 'graphify-labs/graphify'];
const SKILLS_CLI_PIN = '1.7.4'; // pnpm view skills — re-pin deliberately (typosquat/regression guard)
const WITH_SKILLS = process.argv.includes('--with-skills');

/** harness ask values → skills-CLI agent ids (skills add -a <id>). */
export const SKILL_AGENT_BY_CLI = { opencode: 'opencode', claude: 'claude-code', codex: 'codex' };

/**
 * Default harness: studi0's own runner first (the pipeline runs on opencode),
 * then whatever else is installed. `have` is { opencode, claude, codex } booleans.
 */
export function pickDefaultHarness(have) {
  if (have.opencode) return 'opencode';
  if (have.claude) return 'claude';
  if (have.codex) return 'codex';
  return null;
}

/**
 * Mirror apps/server resolveOpencodeBin: a real .exe wins on Windows; a .cmd
 * shim is only usable if the npm-global layout sits next to it; on POSIX any
 * which-hit (shebang script) works. `lines` = `where opencode` / `which opencode`.
 */
export function resolveOpencodeFromLines(lines, exists = (p) => existsSync(p)) {
  const norm = lines.map((l) => l.trim()).filter(Boolean);
  const exe = norm.find((l) => l.toLowerCase().endsWith('.exe'));
  if (exe) return { ok: true, exe, label: exe };
  const cmd = norm.find((l) => l.toLowerCase().endsWith('.cmd'));
  if (cmd) {
    const npmExe = path.join(path.dirname(cmd), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    if (exists(npmExe)) return { ok: true, exe: npmExe, label: npmExe };
    return { ok: false, exe: null, cmd, label: 'only a .cmd shim found — the server needs a real .exe (npm-layout miss)' };
  }
  const bare = norm.find((l) => !/\.(exe|cmd|ps1|bat)$/i.test(l));
  if (bare && exists(bare)) return { ok: true, exe: bare, label: bare };
  return { ok: false, exe: null, cmd: null, label: 'opencode not found on PATH' };
}

/** Bounded search for opencode.exe under the pnpm global dir (pnpm shims carry no npm layout). */
export function findOpencodeExeCandidates(whereLines, { exists = existsSync, localAppData = process.env.LOCALAPPDATA, walk = walkForExe } = {}) {
  const cands = [];
  const cmd = whereLines.map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('.cmd'));
  if (cmd) {
    const npmLayout = path.join(path.dirname(cmd), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    if (exists(npmLayout)) cands.push(npmLayout);
  }
  if (localAppData) {
    const pnpmDir = path.join(localAppData, 'pnpm');
    if (exists(pnpmDir)) {
      for (const hit of walk(pnpmDir)) if (!cands.includes(hit)) cands.push(hit);
    }
  }
  return cands.filter((c) => exists(c));
}

/** Depth/budget-limited walk collecting opencode.exe paths (never throws). */
export function walkForExe(dir, { maxDepth = 8, maxVisited = 8000, maxHits = 3 } = {}) {
  const hits = [];
  let visited = 0;
  const step = (d, depth) => {
    if (depth > maxDepth || visited > maxVisited || hits.length >= maxHits) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (visited > maxVisited || hits.length >= maxHits) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) step(p, depth + 1);
      else if (e.isFile() && e.name === 'opencode.exe') hits.push(p);
    }
  };
  step(dir, 0);
  return hits;
}

/** argv for installing the pinned python packages with uv, targeting the SAME
    interpreter the server uses (imports + the `graphify` entry point must land there). */
export function uvInstallArgs(pythonBin, specs) {
  return ['pip', 'install', '--python', pythonBin, ...specs];
}

/** Dedicated graphify venv layout for a repo root + node platform (win32 | posix). */
export function graphifyVenvPaths(repoRoot, platform = process.platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dir = p.join(repoRoot, '.graphify-venv');
  const bindir = p.join(dir, win ? 'Scripts' : 'bin');
  return {
    dir,
    python: p.join(bindir, win ? 'python.exe' : 'python'),
    bin: p.join(bindir, win ? 'graphify.exe' : 'graphify'),
  };
}

/**
 * Pure: commands setup must run against the venv. `installed` = { graphifyy,
 * openai, pypdf } versions probed from the venv (null = missing). No commands =
 * ready. `env` is the .env pair the server reads.
 */
export function graphifyVenvPlan({ paths, python, pythonPrefix = [], venvExists, installed = {}, tool = 'pip' }) {
  const ready = installed.graphifyy === '0.9.95' && Boolean(installed.openai) && Boolean(installed.pypdf);
  const commands = [];
  if (!venvExists) commands.push({ bin: python, argv: [...pythonPrefix, '-m', 'venv', paths.dir] });
  if (!ready) {
    commands.push(
      tool === 'uv'
        ? { bin: 'uv', argv: uvInstallArgs(paths.python, graphifyInstallSpecs) }
        : { bin: paths.python, argv: ['-m', 'pip', 'install', '--quiet', ...graphifyInstallSpecs] },
    );
  }
  return { commands, env: { STUDI0_GRAPHIFY_VENV: paths.dir, GRAPHIFY_BIN: paths.bin } };
}

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

// ── graphify LLM: which backend extracts the graph (SoCLaaS is NUS-only) ──

/** Fallback extraction model when none is saved (mirrors apps/server graphModel). */
export const GRAPH_DEFAULT_MODEL = 'nemotron3.5:30b';

/** Display-safe secret: never more than the last 4 chars. */
export function maskSecret(s) {
  const v = String(s ?? '');
  if (!v) return 'missing';
  return v.length > 4 ? `••••${v.slice(-4)}` : 'set';
}

/**
 * .env changes for the graph LLM question: 1 = chat gateway (CHAT_*), 2 = own
 * OpenAI-compatible endpoint, 3 = Anthropic, 4 = Gemini, 5 = none. A blank
 * required key returns {} (skip — never write a blank key).
 */
export function graphEnvChanges(choice, entered = {}, env = {}) {
  if (choice === 1) {
    if (!env.CHAT_BASE_URL || !env.CHAT_API_KEY) return {};
    return {
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: env.CHAT_BASE_URL,
      STUDI0_GRAPH_API_KEY: env.CHAT_API_KEY,
      STUDI0_GRAPH_MODEL: env.STUDI0_GRAPH_MODEL || GRAPH_DEFAULT_MODEL,
    };
  }
  if (choice === 2) {
    if (!entered.baseUrl || !entered.apiKey) return {};
    return {
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: entered.baseUrl,
      STUDI0_GRAPH_API_KEY: entered.apiKey,
      STUDI0_GRAPH_MODEL: entered.model || env.STUDI0_GRAPH_MODEL || GRAPH_DEFAULT_MODEL,
    };
  }
  if (choice === 3 || choice === 4) {
    if (!entered.apiKey) return {};
    return {
      STUDI0_GRAPH_BACKEND: choice === 3 ? 'claude' : 'gemini',
      [choice === 3 ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY']: entered.apiKey,
      STUDI0_GRAPH_MODEL: entered.model || '',
    };
  }
  if (choice === 5) return { STUDI0_GRAPH_BACKEND: 'none' };
  return {};
}

/** --yes / no TTY: keep saved graph keys; else inherit CHAT_*; else AST-only. */
export function autoGraphChanges(env = {}) {
  if (env.STUDI0_GRAPH_BACKEND) return {};
  const inherited = graphEnvChanges(1, {}, env);
  return Object.keys(inherited).length > 0 ? inherited : { STUDI0_GRAPH_BACKEND: 'none' };
}

/** Print-safe KEY=VALUE list (API keys masked). */
function describeChanges(changes) {
  return Object.entries(changes)
    .map(([k, v]) => `${k}=${/KEY/.test(k) ? maskSecret(v) : v}`)
    .join(', ');
}

/** Scan row: effective backend + model + whether a key is present (masked). */
function checkGraphLlm(env) {
  const backend = env.STUDI0_GRAPH_BACKEND || 'openai';
  if (backend === 'none') return { ok: true, label: 'none — local AST-only' };
  const model = env.STUDI0_GRAPH_MODEL || GRAPH_DEFAULT_MODEL;
  const key =
    backend === 'claude'
      ? env.ANTHROPIC_API_KEY
      : backend === 'gemini'
        ? env.GEMINI_API_KEY
        : env.STUDI0_GRAPH_API_KEY || env.CHAT_API_KEY;
  return { ok: Boolean(key), label: `${backend} · ${model} · key ${key ? maskSecret(key) : 'missing'}` };
}

/** Free-text prompt; '' when non-interactive. */
function askText(q) {
  if (YES || !process.stdin.isTTY) return Promise.resolve('');
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(a.trim().replace(/^["']|["']$/g, ''));
    });
  });
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

function missingPipPkgs(py) {
  return PIP_PINS.filter((pin) => {
    const have = pipVersion(py, pin.pkg);
    return !(have && pin.want(have));
  });
}

/** Install the missing pins with pip (python -m pip) or uv (--python server's interpreter). */
function installPipPkgs(py, tool) {
  const missing = missingPipPkgs(py);
  if (missing.length === 0) {
    return PIP_PINS.map((p) => `✔ pip: ${p.pkg} ${pipVersion(py, p.pkg)} already satisfied`);
  }
  const specs = missing.map((p) => p.spec);
  const r =
    tool === 'uv'
      ? run('uv', uvInstallArgs(py.bin, specs), { timeout: 0 })
      : run(py.bin, [...py.prefix, '-m', 'pip', 'install', ...specs], { timeout: 0 });
  return [
    r.ok
      ? `✔ ${tool}: installed ${specs.join(', ')}`
      : `✗ ${tool}: install failed — ${r.err.split(/\r?\n/).slice(-2).join(' | ')}`,
  ];
}

/** Versions of the venv's pinned deps (null = missing, incl. no venv). */
function graphifyVenvInstalled(venv) {
  if (!existsSync(venv.python)) return {};
  const asPy = { bin: venv.python, prefix: [] };
  return Object.fromEntries(['graphifyy', 'openai', 'pypdf'].map((pkg) => [pkg, pipVersion(asPy, pkg)]));
}

/** Scan row: dedicated venv presence, its python version, its graphifyy version. */
function checkGraphifyVenv(venv) {
  if (!existsSync(venv.python)) return { ok: false, label: `missing — setup creates ${venv.dir}` };
  const v = run(venv.python, ['--version']);
  const pyv = (v.out || v.err).match(/Python (\d+\.\d+\.\d+)/)?.[1];
  const gv = pipVersion({ bin: venv.python, prefix: [] }, 'graphifyy');
  return { ok: Boolean(gv), label: `python ${pyv ?? '?'} · graphifyy ${gv ?? 'missing'}` };
}

/** Create the dedicated venv if missing, then install/refresh the two pins inside it. */
function installGraphifyVenv(venv, py, tool) {
  const plan = graphifyVenvPlan({
    paths: venv,
    python: py.bin,
    pythonPrefix: py.prefix,
    venvExists: existsSync(venv.python),
    installed: graphifyVenvInstalled(venv),
    tool,
  });
  for (const { bin, argv } of plan.commands) {
    process.stdout.write(`+ ${bin} ${argv.join(' ')}\n`);
    const r = run(bin, argv, { timeout: 0 });
    if (!r.ok) {
      return {
        ok: false,
        notes: [`✗ graphify venv: \`${bin} ${argv.join(' ')}\` failed — ${r.err.split(/\r?\n/).slice(-2).join(' | ')}`],
      };
    }
  }
  return {
    ok: true,
    env: plan.env,
    notes: [
      plan.commands.length === 0
        ? `✔ graphify venv: ${venv.dir} already has graphifyy 0.9.95`
        : `✔ graphify venv: ${venv.dir} (${tool})`,
    ],
  };
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

/** Mirror of the server's bin resolution against THIS machine (.env override first). */
function checkOpencodeBin(envBin) {
  if (envBin) {
    const ok = existsSync(envBin);
    return { ok, label: `OPENCODE_BIN=${envBin}${ok ? '' : ' — path does not exist'}` };
  }
  if (!isWin) {
    const w = run('which', ['opencode']);
    const first = w.ok ? w.out.split(/\r?\n/).find(Boolean) : null;
    return first
      ? { ok: true, label: `bin ok: ${first}` }
      : { ok: false, label: 'opencode not on PATH — the server cannot spawn the teacher' };
  }
  const w = run('where.exe', ['opencode']);
  if (!w.ok) return { ok: false, label: 'opencode not on PATH — the server cannot spawn the teacher' };
  const res = resolveOpencodeFromLines(w.out.split(/\r?\n/));
  return res.ok
    ? { ok: true, label: `bin ok: ${res.label}` }
    : { ok: false, label: res.label, whereLines: w.out.split(/\r?\n/) };
}

/** y/N prompt; YES flag or non-TTY returns false (callers note the skip). */
function askYesNo(q) {
  if (YES) return true;
  if (!process.stdin.isTTY) return false;
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(/^\s*y(es)?\s*$/i.test(a));
    });
  });
}

/** Numbered-choice prompt; returns the chosen value or null (skip). Choices: [{key,label}]. */
function askChoice(q, choices, defaultKey) {
  if (!process.stdin.isTTY) return null;
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(q);
    choices.forEach((c, i) => console.log(`  [${i + 1}] ${c.label}${c.key === defaultKey ? ' (default)' : ''}`));
    rl.question(`choose 1-${choices.length} (enter = ${defaultKey}): `, (a) => {
      rl.close();
      const n = Number(a.trim());
      if (a.trim() === '') return res(defaultKey);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return res(choices[n - 1].key);
      res(null);
    });
  });
}

/**
 * Harness ask: which CLI the user actually drives — decides the graphify skill
 * target and is written to .env (STUDI0_HARNESS) so the pipeline agent knows
 * its lane. Default = first detected (opencode, claude, codex).
 */
async function chooseHarness(have, saved) {
  const choices = Object.keys(SKILL_AGENT_BY_CLI).map((cli) => ({
    key: cli,
    label: `${cli}${have[cli] ? ' — detected' : ' — not detected'}`,
  }));
  const def = saved ?? pickDefaultHarness(have) ?? 'opencode';
  if (YES) return def;
  const picked = await askChoice('which coding harness do you use? (drives the graphify skill + the pipeline agent\'s lane)', choices, def);
  return picked ?? def;
}

/** pip vs uv for the pinned python packages; the pick itself is the consent. */
async function choosePyTool(py, haveUv) {
  if (!py.ok) return null;
  if (missingPipPkgs(py).length === 0) return null; // nothing to install — no ask
  const choices = [
    { key: 'pip', label: `pip (python -m pip install ${PIP_PINS.map((p) => p.spec).join(' ')})` },
    ...(haveUv ? [{ key: 'uv', label: `uv (targets the same interpreter the server uses)` }] : []),
    { key: 'skip', label: 'skip — install later' },
  ];
  const def = 'pip';
  if (YES) return 'pip';
  const picked = await askChoice(`install pinned python packages (${PIP_PINS.map((p) => p.pkg).join(', ')}) with which tool?`, choices, def);
  return picked === 'skip' ? null : picked;
}

const GRAPH_CHOICE_LABELS = [
  'my chat gateway already in .env (CHAT_BASE_URL / CHAT_API_KEY)',
  'my own OpenAI-compatible endpoint (OpenRouter, OpenAI, Groq, LM Studio, Ollama, …)',
  'Anthropic (ANTHROPIC_API_KEY)',
  'Google Gemini (GEMINI_API_KEY)',
  'no LLM — local AST-only',
];

/** Which LLM extracts the graph; returns the .env changes to write ({} = skip). */
async function chooseGraphLlm(env, notes) {
  if (YES || !process.stdin.isTTY) {
    const changes = autoGraphChanges(env);
    if (Object.keys(changes).length === 0) notes.push('graph LLM: saved STUDI0_GRAPH_* keys kept (non-interactive)');
    else if (changes.STUDI0_GRAPH_BACKEND === 'none') notes.push('graph LLM: no STUDI0_GRAPH_* or CHAT_* keys — wrote STUDI0_GRAPH_BACKEND=none (AST-only)');
    else notes.push(`✔ graph LLM: inherited CHAT_* — ${describeChanges(changes)}`);
    return changes;
  }
  const hasChat = Boolean(env.CHAT_BASE_URL && env.CHAT_API_KEY);
  const saved = env.STUDI0_GRAPH_BACKEND;
  const def = hasChat ? 1 : saved === 'claude' ? 3 : saved === 'gemini' ? 4 : saved === 'openai' ? 2 : 5;
  const picked = await askChoice(
    'Which LLM should graphify use for extraction?',
    GRAPH_CHOICE_LABELS.map((label, i) => ({ key: i + 1, label })),
    def,
  );
  if (picked === null) {
    notes.push('graph LLM: skipped — invalid choice');
    return {};
  }
  if (picked === 1 && !hasChat) {
    notes.push('graph LLM: skipped — CHAT_BASE_URL / CHAT_API_KEY not in .env');
    return {};
  }
  const entered = {};
  if (picked === 2) {
    entered.baseUrl = await askText('graph base URL (e.g. https://openrouter.ai/api/v1): ');
    entered.apiKey = await askText('graph API key (blank to skip): ');
    entered.model = await askText('graph model: ');
  } else if (picked === 3 || picked === 4) {
    entered.apiKey = await askText(`${picked === 3 ? 'ANTHROPIC' : 'GEMINI'} API key (blank to skip): `);
    entered.model = await askText('model (blank = backend default): ');
  }
  const changes = graphEnvChanges(picked, entered, env);
  if (Object.keys(changes).length === 0) {
    notes.push('graph LLM: skipped — no key entered, existing keys left untouched');
    return {};
  }
  notes.push(`✔ graph LLM: ${describeChanges(changes)}`);
  return changes;
}

/** OPENCODE_BIN fix: candidate search → confirm → write .env (or paste path). */
async function maybeFixOpencodeBin(ocBin) {
  if (ocBin.ok) return [];
  const notes = [];
  let target = null;
  const cands = ocBin.whereLines ? findOpencodeExeCandidates(ocBin.whereLines) : [];
  if (cands.length > 0) {
    target = cands[0];
    const yes = await askYesNo(`set OPENCODE_BIN=${target} in .env? [y/N] `);
    if (!yes) target = null;
  } else if (process.stdin.isTTY && !YES) {
    console.log('could not locate opencode.exe automatically (checked npm layout + pnpm global dir)');
    target = await new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('paste the full path to opencode.exe (blank to skip): ', (a) => {
        rl.close();
        const p = a.trim().replace(/^["']|["']$/g, '');
        res(p && existsSync(p) ? p : null);
        if (p && !existsSync(p)) console.log('  path does not exist — skipping');
      });
    });
  }
  if (target) {
    writeEnvFile({ OPENCODE_BIN: target });
    notes.push(`✔ .env: OPENCODE_BIN=${target} (restart \`pnpm dev\` to apply)`);
  } else {
    notes.push('✗ OPENCODE_BIN unset — the server will report OPENCODE_DOWN ("teacher not running") until it is set');
  }
  return notes;
}

/** Opt-in: install the graphify skill for the CHOSEN harness only (never fatal). */
async function maybeInstallGraphifySkill(harness) {
  if (!WITH_SKILLS && !YES && !process.stdin.isTTY) {
    return '– skills install skipped (non-interactive — opt in: `pnpm setup --with-skills`)';
  }
  const yes = WITH_SKILLS || (await askYesNo(`install the graphify skill for ${harness} only? [y/N] `));
  if (!yes) return '– skills install skipped (opt in: `pnpm setup --with-skills`)';
  const agent = SKILL_AGENT_BY_CLI[harness] ?? harness;
  for (const src of SKILL_SOURCES) {
    process.stdout.write(`+ pnpm dlx skills@${SKILLS_CLI_PIN} add ${src} -g -y --skill ${SKILL_NAME} -a ${agent}\n`);
    const r = run('pnpm', ['dlx', `skills@${SKILLS_CLI_PIN}`, 'add', src, '-g', '-y', '--skill', SKILL_NAME, '-a', agent], {
      shell: isWin,
      timeout: 0,
    });
    if (r.ok) return `✔ skills: ${SKILL_NAME} installed for ${agent} (${src})`;
    console.log(`  skills source failed: ${src}`);
  }
  return `⚠ skills install failed for every source — setup continues; try \`pnpm dlx skills add ${SKILL_NAME} -g -y -a ${agent}\` later`;
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
  const envFile = readEnvFile();

  rows.push(['node', checkNode()]);
  const pnpm = checkPnpm();
  rows.push(['pnpm', pnpm]);
  const py = checkPython();
  rows.push(['python', py]);
  const venv = graphifyVenvPaths(repoRoot, process.platform);
  rows.push(['graphify venv', checkGraphifyVenv(venv)]);
  const oc = checkCli('opencode', { argv: ['auth', 'list'], hint: 'opencode auth login' });
  rows.push(['opencode', oc]);
  const claude = checkCli('claude');
  rows.push(['claude', claude]);
  const codex = checkCli('codex');
  rows.push(['codex', codex]);
  const ocBin = checkOpencodeBin(process.env.OPENCODE_BIN ?? envFile.OPENCODE_BIN);
  rows.push(['oc bin', ocBin]);
  rows.push(['graph LLM', checkGraphLlm(envFile)]);

  // ── ask phase: harness + python tool (defaults = saved .env / detection) ──
  const savedHarness = envFile.STUDI0_HARNESS && SKILL_AGENT_BY_CLI[envFile.STUDI0_HARNESS] ? envFile.STUDI0_HARNESS : null;
  const harness = await chooseHarness({ opencode: oc.ok, claude: claude.ok, codex: codex.ok }, savedHarness);
  notes.push(`harness: ${harness}${savedHarness && savedHarness !== harness ? ' (changed)' : ''}`);
  const uvCheck = run('uv', ['--version']);
  const pyTool = await choosePyTool(py, uvCheck.ok);
  const graphChanges = await chooseGraphLlm(envFile, notes);

  // ── apply phase ──
  let venvEnv = {};
  if (py.ok) {
    const res = installGraphifyVenv(venv, py, pyTool ?? 'pip'); // no ask happened → pip
    notes.push(...res.notes);
    venvEnv = res.env ?? {};
    if (!existsSync(venv.python)) {
      // venv creation failed → the old global install is the fallback (never blocks setup)
      notes.push('graphify venv: unavailable — falling back to the global python install');
      if (pyTool) notes.push(...installPipPkgs(py, pyTool));
    }
  } else {
    notes.push('✗ graphify venv: python missing — skipped (server falls back to PATH)');
  }
  notes.push(...(await maybeFixOpencodeBin(ocBin)));
  notes.push(await maybeInstallGraphifySkill(harness));

  const envChanges = { STUDI0_HARNESS: harness, ...graphChanges, ...venvEnv };
  const envPath = path.join(repoRoot, '.env');
  const { picks, changes: portChanges, notes: portNotes } = await pickPorts();
  notes.push(...portNotes);
  const allChanges = { ...envChanges, ...portChanges };
  if (Object.keys(allChanges).length > 0) {
    if (existsSync(envPath) && !FORCE) {
      // STUDI0_HARNESS + graph keys are setup-owned and consented — always writable; ports keep the guard
      const portKeys = Object.keys(portChanges);
      if (portKeys.length === 0) {
        writeEnvFile(envChanges);
        notes.push(`✔ .env: ${describeChanges(envChanges)}`);
      } else {
        writeEnvFile(envChanges);
        notes.push(`✗ .env exists — port changes refused (${portKeys.join(', ')}). Re-run with --force.`);
      }
    } else {
      writeEnvFile(allChanges);
      notes.push(`✔ .env written: ${describeChanges(allChanges)}`);
    }
  } else {
    notes.push('✔ ports as configured are free — no .env changes needed');
  }

  console.log('\nstudi0 setup');
  console.log('────────────');
  for (const [name, r] of rows) console.log(`${r.ok ? '✔' : '✗'} ${name.padEnd(13)} ${r.label}`);
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
  if (!ocBin.ok) {
    console.log('  • set OPENCODE_BIN to opencode.exe (teacher shows "not running" otherwise) — setup can do this, rerun to retry');
  }
  if (!py.ok) console.log('  • install python ≥3.12, then re-run `pnpm setup` for the pinned python packages');
  if (!uvCheck.ok) console.log('  • tip: install uv (https://docs.astral.sh/uv/) for faster python installs — setup will offer it next run');
  console.log(`  • harness: ${harness} (STUDI0_HARNESS in .env — re-run \`pnpm setup\` to change; skills + pipeline agent follow it)`);
  console.log('  • pnpm dev        # API + web + managed opencode serve');
  console.log('  • pnpm stop       # stop everything (graceful)');
  console.log('  • docs/BUILD.md   # manual setup + platform notes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
