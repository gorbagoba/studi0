import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
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

describe('graphTokenBudget', () => {
  it('defaults to 3000', () => {
    delete process.env.STUDI0_GRAPH_TOKEN_BUDGET;
    expect(makeConfig('/tmp/studi0-graphenv').graphTokenBudget).toBe(3000);
  });

  it('honours STUDI0_GRAPH_TOKEN_BUDGET', () => {
    process.env.STUDI0_GRAPH_TOKEN_BUDGET = '1200';
    expect(makeConfig('/tmp/studi0-graphenv').graphTokenBudget).toBe(1200);
  });

  it('falls back to 3000 on garbage', () => {
    process.env.STUDI0_GRAPH_TOKEN_BUDGET = 'lots';
    expect(makeConfig('/tmp/studi0-graphenv').graphTokenBudget).toBe(3000);
    process.env.STUDI0_GRAPH_TOKEN_BUDGET = '-5';
    expect(makeConfig('/tmp/studi0-graphenv').graphTokenBudget).toBe(3000);
  });
});

describe('graphEnv', () => {
  it('defaults to the chat gateway and the extraction model (backend openai)', () => {
    clearGraphEnv();
    process.env.CHAT_BASE_URL = 'http://chat.local/v1';
    process.env.CHAT_API_KEY = 'chat-key';
    const cfg = makeConfig('/tmp/studi0-graphenv');
    expect(cfg.graphBackend).toBe('openai');
    expect(cfg.graphModel).toBe('qwen3-coder-next');
    expect(graphEnv(cfg)).toMatchObject({
      GRAPHIFY_BACKEND: 'openai',
      OPENAI_BASE_URL: 'http://chat.local/v1',
      OPENAI_API_KEY: 'chat-key',
      GRAPHIFY_OPENAI_MODEL: 'qwen3-coder-next',
      OPENAI_MODEL: 'qwen3-coder-next',
    });
  });

  it('STUDI0_GRAPH_MODEL overrides the default extraction model', () => {
    clearGraphEnv();
    process.env.STUDI0_GRAPH_BACKEND = 'openai';
    process.env.STUDI0_GRAPH_BASE_URL = 'http://gw.local/v1';
    process.env.STUDI0_GRAPH_API_KEY = 'gw-key';
    process.env.STUDI0_GRAPH_MODEL = 'custom-extract-model';
    const cfg = makeConfig('/tmp/studi0-graphenv');
    expect(cfg.graphModel).toBe('custom-extract-model');
    expect(graphEnv(cfg).GRAPHIFY_OPENAI_MODEL).toBe('custom-extract-model');
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

  it('puts the venv scripts dir first on PATH and exports the venv env', () => {
    const venv = path.resolve('/tmp/studi0-venv');
    const cfg = {
      ...makeConfig('/tmp/studi0-graphenv'),
      graphifyVenv: venv,
      graphifyBin: path.join(venv, 'Scripts', 'graphify.exe'),
    };
    const env = graphEnv(cfg);
    const scriptsDir = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    expect(env.PATH.split(path.delimiter)[0]).toBe(scriptsDir);
    expect(env.GRAPHIFY_BIN).toBe(cfg.graphifyBin);
    expect(env.VIRTUAL_ENV).toBe(venv);
    expect(env.PYTHONNOUSERSITE).toBe('1');
  });

  it('exports the venv python for the graph inspector on win32 and posix', () => {
    const venv = path.resolve('/tmp/studi0-venv');
    const cfg = { ...makeConfig('/tmp/studi0-graphenv'), graphifyVenv: venv };
    const original = process.platform;
    const setPlatform = (value: string) =>
      Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
      setPlatform('win32');
      expect(graphEnv(cfg).STUDI0_GRAPH_PY).toBe(path.join(venv, 'Scripts', 'python.exe'));
      setPlatform('linux');
      expect(graphEnv(cfg).STUDI0_GRAPH_PY).toBe(path.join(venv, 'bin', 'python'));
    } finally {
      setPlatform(original);
    }
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
