import { existsSync, readFileSync } from 'node:fs';
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
  /** stronger quality-first model for generate_lesson delegation */
  chatModelLesson: string;
  /** chat_template_kwargs for the lesson writer (x-test-2 wants {thinking:false}) */
  chatLessonTemplateKwargs: Record<string, unknown>;
  /** send chat_template_kwargs {enable_thinking:false} — off only when the gateway/model rejects it */
  chatDisableThinking: boolean;
  /** headless browser for lesson render review (STUDI0_BROWSER_BIN); null = auto-detect */
  browserBin: string | null;
  /** per-stage graph pipeline models (`opencode run --model`); extraction is the high-volume stage */
  graphPlanModel: string;
  graphExtractModel: string;
  graphMergeModel: string;
  graphVerifyModel: string;
  /** graphify's own LLM backend (GRAPHIFY_BACKEND); 'none' = local AST-only */
  graphBackend: string;
  /** OpenAI-compatible gateway graphify calls (OPENAI_BASE_URL) */
  graphBaseUrl: string;
  graphApiKey: string;
  /** model graphify itself uses (GRAPHIFY_OPENAI_MODEL) */
  graphModel: string;
  /** project-local graphify virtualenv (STUDI0_GRAPHIFY_VENV) */
  graphifyVenv: string;
  /** graphify executable (GRAPHIFY_BIN) — derived from graphifyVenv when present, else bare graphify */
  graphifyBin: string;
}

/** Lesson-writer template kwargs from JSON env; malformed input falls back (one warn). */
function parseLessonTemplateKwargs(raw: string | undefined): Record<string, unknown> {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the warning below
    }
    console.warn('[config] CHAT_MODEL_LESSON_TEMPLATE_KWARGS is not a JSON object — using {"thinking":false}');
  }
  return { thinking: false };
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
      'CHAT_MODEL_LESSON',
      'CHAT_MODEL_LESSON_TEMPLATE_KWARGS',
      'CHAT_DISABLE_THINKING',
      'STUDI0_BROWSER_BIN',
      'STUDI0_GRAPH_PLAN_MODEL',
      'STUDI0_GRAPH_EXTRACT_MODEL',
      'STUDI0_GRAPH_MERGE_MODEL',
      'STUDI0_GRAPH_VERIFY_MODEL',
      'STUDI0_GRAPH_BACKEND',
      'STUDI0_GRAPH_BASE_URL',
      'STUDI0_GRAPH_API_KEY',
      'STUDI0_GRAPH_MODEL',
      'STUDI0_GRAPHIFY_VENV',
      'GRAPHIFY_BIN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
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
  const chatBaseUrl = process.env.CHAT_BASE_URL ?? '';
  const chatApiKey = process.env.CHAT_API_KEY ?? null;
  // graphify must never auto-detect a vendor backend: explicit backend, gateway by default
  const requested = process.env.STUDI0_GRAPH_BACKEND ?? 'openai';
  let graphBackend = ['openai', 'claude', 'gemini', 'none'].includes(requested) ? requested : 'none';
  if (graphBackend !== requested) {
    console.warn(`[config] unknown STUDI0_GRAPH_BACKEND=${requested}; using none (AST-only)`);
  }
  const graphBaseUrl = process.env.STUDI0_GRAPH_BASE_URL ?? chatBaseUrl;
  let graphApiKey = '';
  if (graphBackend === 'openai') graphApiKey = process.env.STUDI0_GRAPH_API_KEY ?? chatApiKey ?? '';
  else if (graphBackend === 'claude') graphApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  else if (graphBackend === 'gemini') graphApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
  const graphModel =
    process.env.STUDI0_GRAPH_MODEL ?? (graphBackend === 'openai' ? 'nemotron3.5:30b' : '');
  const missing =
    graphBackend === 'openai' ? !(graphBaseUrl && graphApiKey && graphModel) : !graphApiKey;
  if (graphBackend !== 'none' && missing) {
    console.warn(`[config] graph backend ${graphBackend} has no complete credentials; using none (AST-only)`);
    graphBackend = 'none';
  }
  const graphifyVenv = process.env.STUDI0_GRAPHIFY_VENV ?? resolve(repoRoot, '.graphify-venv');
  // venv layout differs by platform; the derived bin is only trusted when it exists
  const venvBin = resolve(
    graphifyVenv,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'graphify.exe' : 'graphify',
  );
  const graphifyBin = process.env.GRAPHIFY_BIN ?? (existsSync(venvBin) ? venvBin : 'graphify');
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
    chatBaseUrl,
    chatApiKey,
    chatModel: process.env.CHAT_MODEL ?? '',
    chatModelLesson: process.env.CHAT_MODEL_LESSON ?? 'x-test-2',
    chatLessonTemplateKwargs: parseLessonTemplateKwargs(process.env.CHAT_MODEL_LESSON_TEMPLATE_KWARGS),
    // chat templates ignore unknown kwargs, so opting out is only for gateways that reject them
    chatDisableThinking: !['false', '0'].includes((process.env.CHAT_DISABLE_THINKING ?? '').toLowerCase()),
    browserBin: process.env.STUDI0_BROWSER_BIN ?? null,
    // the global default model thinks always-on (50s+ per chunk); extraction needs a fast non-thinking model
    graphPlanModel: process.env.STUDI0_GRAPH_PLAN_MODEL ?? 'soclaas/nemotron3.5:30b',
    graphExtractModel: process.env.STUDI0_GRAPH_EXTRACT_MODEL ?? 'soclaas/nemotron3.5:30b',
    graphMergeModel: process.env.STUDI0_GRAPH_MERGE_MODEL ?? 'soclaas/nemotron3.5:30b',
    graphVerifyModel: process.env.STUDI0_GRAPH_VERIFY_MODEL ?? 'soclaas/x-test-2',
    graphBackend,
    graphBaseUrl,
    graphApiKey,
    graphModel,
    graphifyVenv,
    graphifyBin,
  };
}
