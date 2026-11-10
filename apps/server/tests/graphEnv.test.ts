import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphEnv } from '../src/graph/backendEnv.js';
import { makeConfig } from '../src/config.js';

// env snapshot: makeConfig reads process.env live (plus the repo .env loaded at import)
const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

const GRAPH_KEYS = [
  'STUDI0_GRAPH_BACKEND',
  'STUDI0_GRAPH_BASE_URL',
  'STUDI0_GRAPH_API_KEY',
  'STUDI0_GRAPH_MODEL',
];

function gatewayEnv(): void {
  process.env.STUDI0_GRAPH_BACKEND = 'openai';
  process.env.STUDI0_GRAPH_BASE_URL = 'http://gw.local/v1';
  process.env.STUDI0_GRAPH_API_KEY = 'gw-key';
  process.env.STUDI0_GRAPH_MODEL = 'm1';
}

function clearGraphEnv(): void {
  for (const key of GRAPH_KEYS) delete process.env[key];
}

describe('graphEnv', () => {
  it('defaults to the chat gateway and the extraction model (backend openai)', () => {
    clearGraphEnv();
    process.env.CHAT_BASE_URL = 'http://chat.local/v1';
    process.env.CHAT_API_KEY = 'chat-key';
    const cfg = makeConfig('/tmp/studi0-graphenv');
    expect(cfg.graphBackend).toBe('openai');
    expect(cfg.graphModel).toBe('nemotron3.5:30b');
    expect(graphEnv(cfg)).toMatchObject({
      GRAPHIFY_BACKEND: 'openai',
      OPENAI_BASE_URL: 'http://chat.local/v1',
      OPENAI_API_KEY: 'chat-key',
      GRAPHIFY_OPENAI_MODEL: 'nemotron3.5:30b',
      OPENAI_MODEL: 'nemotron3.5:30b',
    });
  });

  it('neutralises every vendor key so detection cannot pick them', () => {
    gatewayEnv();
    for (const key of [
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'MOONSHOT_API_KEY',
      'DEEPSEEK_API_KEY',
      'AZURE_OPENAI_API_KEY',
    ]) {
      process.env[key] = 'vendor-secret';
    }
    const env = graphEnv(makeConfig('/tmp/studi0-graphenv'));
    for (const key of [
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'MOONSHOT_API_KEY',
      'DEEPSEEK_API_KEY',
      'AZURE_OPENAI_API_KEY',
    ]) {
      expect(env[key], key).toBe('');
    }
  });

  it('backend claude keeps only the Anthropic key (model only when explicit)', () => {
    clearGraphEnv();
    process.env.STUDI0_GRAPH_BACKEND = 'claude';
    process.env.ANTHROPIC_API_KEY = 'ak';
    const cfg = makeConfig('/tmp/studi0-graphenv');
    expect(cfg.graphBackend).toBe('claude');
    const env = graphEnv(cfg);
    expect(env).toMatchObject({
      GRAPHIFY_BACKEND: 'claude',
      ANTHROPIC_API_KEY: 'ak',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_MODEL');

    process.env.STUDI0_GRAPH_MODEL = 'cm';
    expect(graphEnv(makeConfig('/tmp/studi0-graphenv')).ANTHROPIC_MODEL).toBe('cm');
  });

  it('backend gemini keeps only the Gemini/Google key', () => {
    clearGraphEnv();
    process.env.STUDI0_GRAPH_BACKEND = 'gemini';
    process.env.GEMINI_API_KEY = 'gk';
    let env = graphEnv(makeConfig('/tmp/studi0-graphenv'));
    expect(env).toMatchObject({
      GRAPHIFY_BACKEND: 'gemini',
      GEMINI_API_KEY: 'gk',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    });
    expect(env).not.toHaveProperty('GOOGLE_API_KEY'); // inherited (unset here)

    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'gk2';
    env = graphEnv(makeConfig('/tmp/studi0-graphenv'));
    expect(env.GEMINI_API_KEY).toBe('gk2');
  });

  it('backend none sets no OPENAI_* vars', () => {
    gatewayEnv();
    process.env.STUDI0_GRAPH_BACKEND = 'none';
    const env = graphEnv(makeConfig('/tmp/studi0-graphenv'));
    expect(env.GRAPHIFY_BACKEND).toBe('none');
    expect(env.OPENAI_API_KEY).toBe('');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(env).not.toHaveProperty('GRAPHIFY_OPENAI_MODEL');
  });

  it('incomplete gateway config warns once and falls back to none', () => {
    clearGraphEnv();
    delete process.env.CHAT_BASE_URL;
    delete process.env.CHAT_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = makeConfig('/tmp/studi0-graphenv');
    expect(cfg.graphBackend).toBe('none');
    const graphWarns = warn.mock.calls.filter((c) => String(c[0]).includes('using none'));
    expect(graphWarns).toHaveLength(1);
  });
});
