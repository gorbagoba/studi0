import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, type BuiltApp } from '../src/http/app.js';
export interface TestHarness extends BuiltApp {
  dataDir: string;
  close: () => Promise<void>;
}

/** Fresh app in a temp data dir (own sqlite db, own subject roots). */
export async function makeHarness(
  opts: { dataDir?: string; dbPath?: string; env?: Record<string, string> } = {},
): Promise<TestHarness> {
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'studi0-test-')));
  // deterministic chat engine for every test unless a test opts into native;
  // config reads process.env at buildApp time, after the repo .env was applied
  process.env.CHAT_ENGINE = opts.env?.CHAT_ENGINE ?? 'opencode';
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const { app, ctx } = await buildApp({ dataDir, dbPath: opts.dbPath });
  return {
    app,
    ctx,
    dataDir,
    close: async () => {
      await app.close();
      try {
        ctx.db.close();
      } catch {
        // already closed (e.g. restart simulation)
      }
      // Windows AV/indexer can briefly hold freshly written files
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
  };
}
