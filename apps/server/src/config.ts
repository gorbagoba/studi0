import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  subjectsDir: string; // default location for create-here subjects
  maxConcurrentJobs: number;
  rotateThreshold: number; // messages per chat session before rotation
  rotateBytes: number; // session transcript bytes before rotation
  ladder: number[]; // practice interval ladder (days)
  allowedExt: string[];
  maxFileBytes: number;
  ocPort: number;
  ocHost: string;
  oneshotTimeoutMs: number;
  sseHeartbeatMs: number;
}

// repo root = apps/server/src -> up 3
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

export function makeConfig(dataDir?: string): Config {
  const dir = dataDir ?? process.env.STUDI0_DATA_DIR ?? resolve(repoRoot, 'data');
  return {
    port: Number(process.env.PORT ?? 3001),
    host: '127.0.0.1',
    dataDir: dir,
    dbPath: resolve(dir, 'studi0.db'),
    subjectsDir: resolve(dir, 'subjects'),
    maxConcurrentJobs: 2,
    rotateThreshold: 24,
    rotateBytes: 60_000,
    ladder: [1, 3, 7],
    allowedExt: ['.pdf', '.md'],
    maxFileBytes: 200 * 1024 * 1024,
    ocPort: Number(process.env.OPENCODE_PORT ?? 44096),
    ocHost: '127.0.0.1',
    oneshotTimeoutMs: 300_000,
    sseHeartbeatMs: 15_000,
  };
}
