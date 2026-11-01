import { describe, expect, it, afterEach } from 'vitest';
import net from 'node:net';
import { makeHarness } from './helpers';
import { makeConfig } from '../src/config.js';
import { netstatPidForPort, lsofPidForPort } from '../src/teacher/opencode.js';
import {
  portBusy,
  pickFreePort,
  parseEnvFile,
  writeEnvFile,
} from '../../../scripts/setup.mjs';
import type { TestHarness } from './helpers';

// ── pure parsers (T-X4: platform branches stay unit-tested; live-Linux boot is out of scope) ──

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:44096        0.0.0.0:0              LISTENING       1234',
  '  TCP    127.0.0.1:5173         127.0.0.1:5174         ESTABLISHED     999',
  '  TCP    [::]:3001              [::]:0                 LISTENING       777',
].join('\r\n');

describe('port-pid parsers', () => {
  it('netstat: finds the LISTENING pid for a port', () => {
    expect(netstatPidForPort(NETSTAT, 44096)).toBe('1234');
    expect(netstatPidForPort(NETSTAT, 3001)).toBe('777');
  });

  it('netstat: ignores non-listening rows, wrong ports, garbage', () => {
    expect(netstatPidForPort(NETSTAT, 5173)).toBeNull(); // ESTABLISHED row
    expect(netstatPidForPort(NETSTAT, 8080)).toBeNull();
    expect(netstatPidForPort('', 3001)).toBeNull();
  });

  it('lsof: first numeric pid wins, empty output is null', () => {
    expect(lsofPidForPort('1234\n5678\n')).toBe('1234');
    expect(lsofPidForPort('')).toBeNull();
    expect(lsofPidForPort('lsof: no match')).toBeNull();
  });
});

// ── config + allowlist derivation ──

describe('port configuration', () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string) => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('makeConfig derives every port from env (OC_PORT not OPENCODE_PORT)', () => {
    setEnv('PORT', '3999');
    setEnv('OC_PORT', '44996');
    setEnv('VITE_PORT', '5199');
    setEnv('PREVIEW_PORT', '4199');
    const cfg = makeConfig();
    expect([cfg.port, cfg.ocPort, cfg.vitePort, cfg.previewPort]).toEqual([3999, 44996, 5199, 4199]);
  });

  it('maxChunkConcurrency: STUDI0_MAX_CHUNK_CONCURRENCY clamped to 1–12, junk → default', () => {
    setEnv('STUDI0_MAX_CHUNK_CONCURRENCY', '7');
    expect(makeConfig().maxChunkConcurrency).toBe(7);
    setEnv('STUDI0_MAX_CHUNK_CONCURRENCY', '0');
    expect(makeConfig().maxChunkConcurrency).toBe(1);
    setEnv('STUDI0_MAX_CHUNK_CONCURRENCY', '99');
    expect(makeConfig().maxChunkConcurrency).toBe(12);
    setEnv('STUDI0_MAX_CHUNK_CONCURRENCY', 'junk');
    expect(makeConfig().maxChunkConcurrency).toBe(4);
    delete process.env.STUDI0_MAX_CHUNK_CONCURRENCY;
    expect(makeConfig().maxChunkConcurrency).toBe(4);
  });

  it('Host allowlist follows configured ports — old defaults die', async () => {
    setEnv('PORT', '3999');
    setEnv('VITE_PORT', '5199');
    setEnv('PREVIEW_PORT', '4199');
    let h: TestHarness | undefined;
    const n = { i: 0 };
    try {
      h = await makeHarness();
      const post = (headers: Record<string, string>) =>
        h!.app.inject({
          method: 'POST',
          url: '/api/subjects',
          payload: { name: `Port${++n.i}` },
          headers,
        });
      expect((await post({ host: '127.0.0.1:3999', origin: 'http://127.0.0.1:3999' })).statusCode).toBe(201);
      expect((await post({ host: 'localhost:5199', origin: 'http://localhost:5199' })).statusCode).toBe(201);
      expect((await post({ host: '127.0.0.1:4199' })).statusCode).toBe(201);
      // the built-in default must no longer be trusted once overridden
      expect(
        (await post({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).statusCode,
      ).toBe(403);
    } finally {
      if (h) await h.close();
    }
  });
});

// ── scripts/setup.mjs pure helpers ──

describe('setup helpers', () => {
  it('portBusy detects a bound port', async () => {
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      expect(await portBusy(port)).toBe(true);
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  it('pickFreePort skips a busy start and returns the next free', async () => {
    const busy = async (p: number) => p === 5000 || p === 5001;
    expect(await pickFreePort(5000, busy)).toBe(5002);
    expect(await pickFreePort(5002, busy)).toBe(5002);
  });

  it('pickFreePort throws when everything is busy', async () => {
    await expect(pickFreePort(5000, async () => true)).rejects.toThrow(/no free port/);
  });

  it('parseEnvFile: KEY=VALUE, quotes stripped, comments ignored', () => {
    expect(parseEnvFile('# comment\nPORT=3001\nVITE_PORT="5199"\n  OC_PORT = 44096 \nbroken line\n')).toEqual({
      PORT: '3001',
      VITE_PORT: '5199',
      OC_PORT: '44096',
    });
  });

  it('writeEnvFile updates existing keys in place and appends new ones', () => {
    const writes: string[] = [];
    writeEnvFile(
      { VITE_PORT: 5199, OC_PORT: 44097 },
      {
        exists: true,
        read: () => '# ports\nPORT=3999\nVITE_PORT=5173\n',
        write: (_p, t) => writes.push(t),
      },
    );
    expect(writes[0]).toBe('# ports\nPORT=3999\nVITE_PORT=5199\nOC_PORT=44097\n');
  });

  it('writeEnvFile replaces an existing value (calibrate updating the concurrency key)', () => {
    const writes: string[] = [];
    writeEnvFile(
      { STUDI0_MAX_CHUNK_CONCURRENCY: 6 },
      {
        exists: true,
        read: () => 'PORT=3999\nSTUDI0_MAX_CHUNK_CONCURRENCY=4\nOTHER=yes\n',
        write: (_p, t) => writes.push(t),
      },
    );
    expect(writes[0]).toBe('PORT=3999\nSTUDI0_MAX_CHUNK_CONCURRENCY=6\nOTHER=yes\n');
  });
});
