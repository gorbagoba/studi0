import type { Config } from '../config.js';

/**
 * Env for children that can run graphify: one explicit backend, and every
 * other provider's key blanked so its probe can never auto-detect them.
 * (graphify treats an empty key as absent — llm.py `_get_backend_api_key`.)
 */
export function graphEnv(cfg: Config): Record<string, string> {
  const env: Record<string, string> = {
    GRAPHIFY_BACKEND: cfg.graphBackend,
    MOONSHOT_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    AZURE_OPENAI_API_KEY: '',
  };
  // blank each provider key unless it belongs to the selected backend
  if (cfg.graphBackend !== 'openai') env.OPENAI_API_KEY = '';
  if (cfg.graphBackend !== 'claude') env.ANTHROPIC_API_KEY = '';
  if (cfg.graphBackend !== 'gemini') {
    env.GEMINI_API_KEY = '';
    env.GOOGLE_API_KEY = '';
  }
  if (cfg.graphBackend === 'openai') {
    env.OPENAI_BASE_URL = cfg.graphBaseUrl;
    env.OPENAI_API_KEY = cfg.graphApiKey;
    env.OPENAI_MODEL = cfg.graphModel;
    env.GRAPHIFY_OPENAI_MODEL = cfg.graphModel;
  } else if (cfg.graphBackend === 'claude') {
    env.ANTHROPIC_API_KEY = cfg.graphApiKey;
    if (cfg.graphModel) env.ANTHROPIC_MODEL = cfg.graphModel;
  } else if (cfg.graphBackend === 'gemini') {
    env.GEMINI_API_KEY = cfg.graphApiKey;
    if (cfg.graphModel) env.GRAPHIFY_GEMINI_MODEL = cfg.graphModel;
  }
  return env;
}
