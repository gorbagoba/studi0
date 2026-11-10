import { describe, expect, it } from 'vitest';
import {
  GRAPH_DEFAULT_MODEL,
  autoGraphChanges,
  graphEnvChanges,
  graphifyInstallSpecs,
  graphifyVenvPaths,
  graphifyVenvPlan,
  maskSecret,
} from '../../../scripts/setup.mjs';

const CHAT = { CHAT_BASE_URL: 'http://gw.local/v1', CHAT_API_KEY: 'chat-secret-key' };

describe('graph LLM setup helpers', () => {
  it('choice 1 inherits the chat gateway and keeps a saved model', () => {
    expect(graphEnvChanges(1, {}, CHAT)).toEqual({
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: 'http://gw.local/v1',
      STUDI0_GRAPH_API_KEY: 'chat-secret-key',
      STUDI0_GRAPH_MODEL: GRAPH_DEFAULT_MODEL,
    });
    expect(graphEnvChanges(1, {}, { ...CHAT, STUDI0_GRAPH_MODEL: 'saved' }).STUDI0_GRAPH_MODEL).toBe('saved');
  });

  it('choice 1 writes nothing when the chat gateway is incomplete', () => {
    expect(graphEnvChanges(1, {}, { CHAT_BASE_URL: 'http://gw.local/v1' })).toEqual({});
    expect(graphEnvChanges(1, {}, {})).toEqual({});
  });

  it('choice 2 writes the entered OpenAI-compatible endpoint', () => {
    const entered = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-123456', model: 'meta/llama' };
    expect(graphEnvChanges(2, entered, {})).toEqual({
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: entered.baseUrl,
      STUDI0_GRAPH_API_KEY: entered.apiKey,
      STUDI0_GRAPH_MODEL: 'meta/llama',
    });
  });

  it('a blank required key skips the choice (no write)', () => {
    expect(graphEnvChanges(2, { baseUrl: 'https://x.test/v1', apiKey: '' }, {})).toEqual({});
    expect(graphEnvChanges(2, { baseUrl: '', apiKey: 'sk-12345' }, {})).toEqual({});
    expect(graphEnvChanges(3, { apiKey: '' }, {})).toEqual({});
    expect(graphEnvChanges(4, { apiKey: '' }, {})).toEqual({});
  });

  it('choices 3/4 switch backend and write the vendor key (model optional)', () => {
    expect(graphEnvChanges(3, { apiKey: 'sk-ant-123456', model: '' }, {})).toEqual({
      STUDI0_GRAPH_BACKEND: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-123456',
      STUDI0_GRAPH_MODEL: '',
    });
    expect(graphEnvChanges(4, { apiKey: 'AIza-123456', model: 'gemini-2.5-flash' }, {})).toEqual({
      STUDI0_GRAPH_BACKEND: 'gemini',
      GEMINI_API_KEY: 'AIza-123456',
      STUDI0_GRAPH_MODEL: 'gemini-2.5-flash',
    });
  });

  it('choice 5 is AST-only', () => {
    expect(graphEnvChanges(5, {}, CHAT)).toEqual({ STUDI0_GRAPH_BACKEND: 'none' });
  });

  it('maskSecret never returns the full key', () => {
    const key = 'sk-ant-secret-value-1234';
    const masked = maskSecret(key);
    expect(masked).not.toBe(key);
    expect(masked).not.toContain('secret-value');
    expect(masked.endsWith('1234')).toBe(true);
    expect(maskSecret('abcd')).toBe('set');
    expect(maskSecret('short')).toBe('••••hort');
    expect(maskSecret('')).toBe('missing');
    expect(maskSecret(undefined)).toBe('missing');
  });

  it('--yes: saved graph keys are left untouched', () => {
    expect(autoGraphChanges({ STUDI0_GRAPH_BACKEND: 'openai', STUDI0_GRAPH_API_KEY: 'k' })).toEqual({});
  });

  it('--yes: no saved keys + CHAT_* inherits the gateway', () => {
    expect(autoGraphChanges(CHAT)).toEqual(graphEnvChanges(1, {}, CHAT));
  });

  it('--yes: no saved keys and no gateway → AST-only', () => {
    expect(autoGraphChanges({})).toEqual({ STUDI0_GRAPH_BACKEND: 'none' });
  });
});

describe('graphify venv setup', () => {
  const WIN = graphifyVenvPaths('C:\\repo', 'win32');
  const POSIX = graphifyVenvPaths('/repo', 'posix');

  it('maps the venv layout per platform', () => {
    expect(WIN).toEqual({
      dir: 'C:\\repo\\.graphify-venv',
      python: 'C:\\repo\\.graphify-venv\\Scripts\\python.exe',
      bin: 'C:\\repo\\.graphify-venv\\Scripts\\graphify.exe',
    });
    expect(POSIX).toEqual({
      dir: '/repo/.graphify-venv',
      python: '/repo/.graphify-venv/bin/python',
      bin: '/repo/.graphify-venv/bin/graphify',
    });
  });

  it('pins graphifyy with the openai extra + pypdf', () => {
    expect(graphifyInstallSpecs).toContain('graphifyy[openai]==0.9.95');
    expect(graphifyInstallSpecs).toContain('pypdf>=6,<7');
  });

  it('plans venv creation + install when the venv is missing', () => {
    const plan = graphifyVenvPlan({ paths: POSIX, python: 'python3', venvExists: false });
    expect(plan.commands).toEqual([
      { bin: 'python3', argv: ['-m', 'venv', POSIX.dir] },
      { bin: POSIX.python, argv: ['-m', 'pip', 'install', '--quiet', ...graphifyInstallSpecs] },
    ]);
    expect(plan.env).toEqual({ STUDI0_GRAPHIFY_VENV: POSIX.dir, GRAPHIFY_BIN: POSIX.bin });
  });

  it('plans nothing when graphifyy + openai + pypdf are already in the venv', () => {
    const plan = graphifyVenvPlan({
      paths: WIN,
      python: 'python',
      venvExists: true,
      installed: { graphifyy: '0.9.95', openai: '1.0.0', pypdf: '6.1.1' },
    });
    expect(plan.commands).toEqual([]);
  });

  it('reuses uv against the venv interpreter when the pin is stale', () => {
    const plan = graphifyVenvPlan({
      paths: POSIX,
      python: 'python3',
      venvExists: true,
      installed: { graphifyy: '0.9.90', openai: '1.0.0', pypdf: '6.1.1' },
      tool: 'uv',
    });
    expect(plan.commands).toEqual([
      { bin: 'uv', argv: ['pip', 'install', '--python', POSIX.python, ...graphifyInstallSpecs] },
    ]);
  });
});
