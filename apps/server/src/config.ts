import { readFileSync } from 'node:fs';
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
  vitePort: number; // dev server + Host allowlist must agree (scripts/setup.mjs writes these)
  previewPort: number; // vite preview
  oneshotTimeoutMs: number;
  /** whole-course lesson generation (setup run) — far longer than a oneshot */
  setupRunTimeoutMs: number;
  sseHeartbeatMs: number;
  splitTargetBytes: number; // pdf-split target size per part (test/tuning seam)
  maxChunkConcurrency: number; // chunk-wave parallelism (STUDI0_MAX_CHUNK_CONCURRENCY, clamped 1–12)
  harness: 'opencode' | 'claude' | 'codex'; // user's coding harness (STUDI0_HARNESS) — skill targeting + pipeline agent lane; runner is opencode today (seam for future adapters)
  /** chat engine: 'native' = server-native OpenAI-compatible loop; 'opencode' = legacy wrapper */
  chatEngine: 'native' | 'opencode';
  chatBaseUrl: string;
  chatApiKey: string | null;
  chatModel: string;
}

// repo root = apps/server/src -> up 3
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

// load repo-root .env (written by scripts/setup.mjs): KEY=VALUE lines, real env wins
try {
  for (const line of readFileSync(resolve(repoRoot, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    // only known keys may ride into process.env (and onward to spawned children)
    const KNOWN_ENV_KEYS = new Set([
      'PORT',
      'OC_PORT',
      'VITE_PORT',
      'PREVIEW_PORT',
      'STUDI0_DATA_DIR',
      'STUDI0_MAX_CHUNK_CONCURRENCY',
      'STUDI0_SPLIT_TARGET_BYTES',
      'STUDI0_HARNESS',
      'OPENCODE_BIN',
      'CHAT_ENGINE',
      'CHAT_BASE_URL',
      'CHAT_API_KEY',
      'CHAT_MODEL',
    ]);
    if (KNOWN_ENV_KEYS.has(m[1]) && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // no .env — defaults apply
}

export function makeConfig(dataDir?: string): Config {
  const dir = dataDir ?? process.env.STUDI0_DATA_DIR ?? resolve(repoRoot, 'data');
  const chunkConcurrency = Number(process.env.STUDI0_MAX_CHUNK_CONCURRENCY);
  // native engine is valid only with a complete gateway config — else fall back
  const nativeReady = Boolean(process.env.CHAT_BASE_URL && process.env.CHAT_API_KEY && process.env.CHAT_MODEL);
  let chatEngine: 'native' | 'opencode' = 'opencode';
  if (process.env.CHAT_ENGINE === 'native' && nativeReady) chatEngine = 'native';
  else if (process.env.CHAT_ENGINE === 'native')
    console.warn('[config] CHAT_ENGINE=native needs CHAT_BASE_URL, CHAT_API_KEY and CHAT_MODEL — using opencode');
  else if (process.env.CHAT_ENGINE && process.env.CHAT_ENGINE !== 'opencode')
    console.warn(`[config] unknown CHAT_ENGINE=${process.env.CHAT_ENGINE} — using opencode`);
  return {
    port: Number(process.env.PORT ?? 3001),
    host: '127.0.0.1',
    dataDir: dir,
    dbPath: resolve(dir, 'studi0.db'),
    subjectsDir: resolve(dir, 'subjects'),
    maxConcurrentJobs: 2,
    rotateThreshold: 24,
    rotateBytes: 60_000,
    ladder: [1, 3, 7, 14, 30], // successive relearning: expanding rungs (Cepeda optimal-gap); a rung advances per 3 consecutive corrects
    allowedExt: ['.pdf', '.md'],
    maxFileBytes: 200 * 1024 * 1024,
    ocPort: Number(process.env.OC_PORT ?? 44096),
    ocHost: '127.0.0.1',
    vitePort: Number(process.env.VITE_PORT ?? 5173),
    previewPort: Number(process.env.PREVIEW_PORT ?? 4173),
    oneshotTimeoutMs: 300_000,
    setupRunTimeoutMs: 2_700_000, // whole-course lesson generation runs long
    sseHeartbeatMs: 15_000,
    splitTargetBytes: Number(process.env.STUDI0_SPLIT_TARGET_BYTES ?? 15 * 1024 * 1024),
    maxChunkConcurrency: Number.isFinite(chunkConcurrency)
      ? Math.min(12, Math.max(1, chunkConcurrency))
      : 4,
    harness: ['opencode', 'claude', 'codex'].includes(process.env.STUDI0_HARNESS ?? '')
      ? (process.env.STUDI0_HARNESS as 'opencode' | 'claude' | 'codex')
      : 'opencode',
    chatEngine,
    chatBaseUrl: process.env.CHAT_BASE_URL ?? '',
    chatApiKey: process.env.CHAT_API_KEY ?? null,
    chatModel: process.env.CHAT_MODEL ?? '',
  };
}
