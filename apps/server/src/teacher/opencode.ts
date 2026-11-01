import { execFile } from 'node:child_process';
import { spawnArgs, killTree, isAlive, commandLineMentions } from '../util/proc.js';
import { makeOcClient, authHeaders, type OcClient } from './sdk.js';
import { HttpError } from '../util/errors.js';
import type { Config } from '../config.js';

export interface OcStatus {
  running: boolean;
  pid: string | null;
  port: number;
  healthy: boolean;
}

const BOOT_TIMEOUT_MS = 15_000;
const PROBE_FAILURES_BEFORE_REBOOT = 6; // ~60s of consecutive probe failures
const isWin = process.platform === 'win32';

/**
 * Single owner of the managed `opencode serve` process.
 * Boot: kill any zombie already listening on our port (netstat â†’ PID â†’ tree
 * kill), then start ours; periodic authenticated health probe; graceful stop.
 */
export class OpencodeManager {
  private pid: string | null = null;
  private password: string | null = null;
  private healthy = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private ocClient: OcClient | null = null;

  constructor(private cfg: Config) {}

  get baseUrl(): string {
    return `http://${this.cfg.ocHost}:${this.cfg.ocPort}`;
  }

  async boot(): Promise<void> {
    await this.cleanupZombie();
    await this.start();
  }

  /** Something healthy on our port that we did not start â†’ kill its tree. */
  private async cleanupZombie(): Promise<void> {
    if (!(await this.probeAuth(false))) return;
    const pid = await pidListeningOn(this.cfg.ocPort);
    if (pid) {
      // trust follows identity, not possession: only kill if it IS an opencode
      if (await commandLineMentions(pid, 'opencode')) {
        await killTree(pid, 5000);
      } else {
        console.error(
          `port ${this.cfg.ocPort} held by pid ${pid} which is not opencode — refusing to kill`,
        );
        return; // someone else's server: do not boot over it
      }
    }
    // give the port a moment to free up
    for (let i = 0; i < 20; i++) {
      if (!(await this.probeAuth(false))) return;
      await sleep(250);
    }
  }

  async start(): Promise<void> {
    if (this.probeTimer) {
      clearInterval(this.probeTimer); // a re-boot must not stack probe loops
      this.probeTimer = null;
    }
    const { child, done } = spawnArgs(
      ['serve', '--port', String(this.cfg.ocPort), '--hostname', this.cfg.ocHost],
      process.cwd(),
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const m = chunk.match(/server password (\S+)/);
      if (m) this.password = m[1];
    });
    this.pid = child.pid !== undefined ? String(child.pid) : null;
    void done.catch(() => {
      this.healthy = false;
    });
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.password && (await this.probeAuth(true))) {
        this.healthy = true;
        this.startProbeLoop();
        return;
      }
      if (child.exitCode !== null) break;
      await sleep(250);
    }
    this.healthy = false;
    throw new HttpError('OPENCODE_DOWN', 'managed opencode server failed to start');
  }

  private startProbeLoop(): void {
    let failures = 0;
    this.probeTimer = setInterval(() => {
      void this.probeAuth(true).then(async (ok) => {
        this.healthy = ok;
        if (ok) {
          failures = 0;
          return;
        }
        if (++failures < PROBE_FAILURES_BEFORE_REBOOT) return;
        failures = 0;
        // dead serve: boot() clears the port zombie; cached client/password are stale
        this.healthy = false;
        this.password = null;
        this.ocClient = null;
        await this.boot().catch(() => undefined);
      });
    }, 10_000);
    this.probeTimer.unref();
  }

  /** GET /api/info; withAuth=true requires a 200, else any response proves presence. */
  private async probeAuth(withAuth: boolean): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/info`, {
        headers: withAuth && this.password ? authHeaders(this.password) : {},
        signal: AbortSignal.timeout(2000),
      });
      return withAuth ? res.ok : true; // 401 also proves a server is listening
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.healthy = false;
    if (this.pid && isAlive(this.pid)) await killTree(this.pid, 5000);
    this.pid = null;
  }

  status(): OcStatus {
    return {
      running: this.pid !== null,
      pid: this.pid,
      port: this.cfg.ocPort,
      healthy: this.healthy,
    };
  }

  ensureUp(): void {
    if (!this.healthy) {
      throw new HttpError('OPENCODE_DOWN', 'opencode server is not healthy');
    }
  }

  client(): OcClient {
    if (!this.ocClient) {
      if (!this.password) throw new HttpError('OPENCODE_DOWN', 'opencode server is not started');
      this.ocClient = makeOcClient(this.cfg, this.password);
    }
    return this.ocClient;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Does anything listen on `port`? Windows: netstat -ano parse; POSIX: lsof.
 * Returns the owning pid or null. Ownership is then verified via
 * commandLineMentions before anything is killed.
 */
async function pidListeningOn(port: number): Promise<string | null> {
  try {
    if (isWin) {
      const out = await new Promise<string>((resolve, reject) => {
        execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        );
      });
      return netstatPidForPort(out, port);
    }
    const out = await new Promise<string>((resolve) => {
      // lsof exits non-zero when the port is free — an empty result, not an error
      execFile('lsof', ['-ti', `:${port}`], (err, stdout) => resolve(err ? '' : stdout));
    });
    return lsofPidForPort(out);
  } catch {
    return null;
  }
}

/** Pure: the pid of the LISTENING socket on `port` in `netstat -ano` output. */
export function netstatPidForPort(out: string, port: number): string | null {
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    if (!line.includes(`:${port} `) && !line.trim().endsWith(`:${port}`)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid)) return pid;
  }
  return null;
}

/** Pure: the first pid in `lsof -ti :port` output. */
export function lsofPidForPort(out: string): string | null {
  return out.split(/\s+/).find((t) => /^\d+$/.test(t)) ?? null;
}
