// pnpm stop — the complement to `pnpm dev`: stops the API (gracefully, via its
// own shutdown route), vite, and the managed opencode serve.
// Identity rule (L2 lesson): a port-held PID proves possession, not ownership —
// verify the command line before taskkill; --force overrides for stubborn cases.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const pExecFile = promisify(execFile);
const isWin = process.platform === 'win32';
const force = process.argv.includes('--force');

// ports follow the app's .env when present (same keys setup writes)
function envPort(key, fallback) {
  try {
    const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    const v = Number(line?.split('=')[1]);
    return Number.isInteger(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
const PORTS = [envPort('OC_PORT', 44096), envPort('PORT', 3001), envPort('VITE_PORT', 5173)]; // serve, API, vite — serve first: it is the API's child
const IDENTITY = /opencode|node|tsx|vite|pnpm/i;

function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port} `) && line.includes('LISTENING')) {
          const pid = Number(line.trim().split(/\s+/).pop());
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

async function commandLine(pid) {
  try {
    if (isWin) {
      const { stdout } = await pExecFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { timeout: 5000 },
      );
      return String(stdout);
    }
    const { stdout } = await pExecFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
    return stdout;
  } catch {
    return '';
  }
}

async function gracefulApiStop() {
  try {
    await pExecFile('curl.exe', ['-s', '-m', '3', '-X', 'POST', 'http://127.0.0.1:3001/api/shutdown'], {
      timeout: 5000,
    });
    // give the drain a moment, then check
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (pidsOnPort(3001).length === 0) return true;
    }
  } catch {
    /* API not up or curl missing — fall through to hard kill */
  }
  return false;
}

async function kill(pid) {
  const cmdline = await commandLine(pid);
  if (!force && !IDENTITY.test(cmdline)) {
    console.log(`skip pid ${pid} on identity check (cmdline: ${cmdline.trim().slice(0, 80) || 'unknown'}) — use --force to override`);
    return false;
  }
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
    return true;
  } catch (e) {
    console.log(`could not kill pid ${pid}: ${e.message}`);
    return false;
  }
}

let stopped = 0;
// API first via its clean shutdown path (drains jobs, stops the serve it owns)
if (pidsOnPort(3001).length > 0) {
  process.stdout.write('stopping API (graceful)…\n');
  if (await gracefulApiStop()) stopped++;
}
for (const port of PORTS) {
  for (const pid of pidsOnPort(port)) {
    process.stdout.write(`stopping pid ${pid} on :${port}…\n`);
    if (await kill(pid)) stopped++;
  }
}
console.log(stopped > 0 ? `stopped ${stopped} process(es).` : 'nothing was running.');
