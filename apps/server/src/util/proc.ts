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
  // callers may setEncoding('utf8') on these streams, so chunks can arrive as
  // strings — normalize before Buffer.concat or it throws ERR_INVALID_ARG_TYPE
  // and takes down the whole server process (uncaught inside a 'data' handler)
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const collect = (buf: Buffer[]) => (d: Buffer | string) =>
    buf.push(typeof d === 'string' ? Buffer.from(d, 'utf8') : d);
  child.stdout?.on('data', collect(stdout));
  child.stderr?.on('data', collect(stderr));
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
    // taskkill /T cannot reach descendants once the parent is already dead
    // (orphaned grandchildren) — enumerate the parent-link tree and kill each
    const [descendants] = await Promise.all([descendantsOf(pid), taskkillTree(pid)]);
    await Promise.all(descendants.map((p) => taskkillTree(p)));
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

function taskkillTree(pid: string | number): Promise<void> {
  return new Promise<void>((resolveKill) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
      resolveKill(),
    );
  });
}

/** Best-effort descendant pids (parent links, one CIM snapshot); [] on failure. */
async function descendantsOf(pid: string | number): Promise<string[]> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    if (!out.trim()) return [];
    const parsed = JSON.parse(out) as { ProcessId: number; ParentProcessId: number }[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const childrenOf = new Map<number, number[]>();
    for (const r of rows) {
      const list = childrenOf.get(r.ParentProcessId) ?? [];
      list.push(r.ProcessId);
      childrenOf.set(r.ParentProcessId, list);
    }
    const found: string[] = [];
    const queue = [Number(pid)];
    while (queue.length) {
      for (const c of childrenOf.get(queue.pop() as number) ?? []) {
        found.push(String(c));
        queue.push(c);
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Does the process's own command line mention `needle` (case-insensitive)?
 * Ownership check before destructive ops: a port-held PID proves possession,
 * not identity. Non-Windows reads /proc; Windows asks CIM. Errors → false.
 */
export async function commandLineMentions(pid: string | number, needle: string): Promise<boolean> {
  try {
    if (isWin) {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
          { timeout: 5000 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      });
      return out.toLowerCase().includes(needle.toLowerCase());
    }
    const { readFile } = await import('node:fs/promises');
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.toLowerCase().includes(needle.toLowerCase());
  } catch {
    return false;
  }
}

export function isAlive(pid: string | number): boolean {  try {
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
