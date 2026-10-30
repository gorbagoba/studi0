import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ChildRun {
  pid: number | undefined;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  child: ReturnType<typeof spawn>;
}

const isWin = process.platform === 'win32';

let binCache: string | null | undefined;

/**
 * Resolve the opencode CLI executable. Prefers a real .exe: bare names resolve
 * to .cmd shims on Windows, which spawn() cannot execute without a shell.
 * Override with OPENCODE_BIN.
 */
export function resolveOpencodeBin(): string | null {
  if (binCache !== undefined) return binCache;
  const candidates: string[] = [];
  if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN);
  try {
    const out = execFileSyncSafe('where.exe', ['opencode']);
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
    if (exe) candidates.push(exe);
    // npm global layout: <bin>\opencode.cmd + <bin>\node_modules\@opencode\cli\bin\opencode.exe
    const cmd = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
    if (cmd) {
      candidates.push(
        path.join(path.dirname(cmd), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      );
    }
  } catch {
    // where failed — fall through to bare name (works on non-Windows)
  }
  if (!isWin) candidates.push('opencode');
  const found = candidates.find((c) => {
    try {
      return existsSync(c);
    } catch {
      return false;
    }
  });
  binCache = found ?? null;
  return binCache;
}

function execFileSyncSafe(file: string, args: string[]): string {
  return execFileSync(file, args, { windowsHide: true, encoding: 'utf8' });
}

export function spawnArgs(args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildRun {
  const bin = resolveOpencodeBin();
  if (!bin) throw new Error('opencode CLI not found; set OPENCODE_BIN to the opencode executable');
  const child = spawn(bin, args, {
    cwd,
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (d: Buffer) => stdout.push(d));
  child.stderr?.on('data', (d: Buffer) => stderr.push(d));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveDone, rejectDone) => {
      child.on('error', rejectDone);
      child.on('close', (code) => {
        resolveDone({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    },
  );
  return { pid: child.pid, done, child };
}

/** Kill a process tree. Windows: taskkill /T /F (mandatory — children survive otherwise). */
export async function killTree(pid: string | number, forceDelayMs = 5000): Promise<void> {
  if (isWin) {
    await new Promise<void>((resolveKill) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolveKill(),
      );
    });
    return;
  }
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    return;
  }
  await new Promise<void>((r) => setTimeout(r, Math.min(forceDelayMs, 2000)));
  try {
    process.kill(Number(pid), 'SIGKILL');
  } catch {
    // already gone
  }
}

export function isAlive(pid: string | number): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill tree with a force fallback after forceDelayMs (AC4: terminal within 5s). */
export function killTreeWithDeadline(pid: string | number, forceDelayMs = 5000): void {
  void killTree(pid);
  setTimeout(() => {
    if (isAlive(pid)) void killTree(pid, 0);
  }, forceDelayMs).unref();
}
