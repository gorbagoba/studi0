import { describe, expect, it } from 'vitest';
import { GRAPH_DEFAULT_MODEL, autoGraphChanges, graphEnvChanges, maskSecret } from '../../../scripts/setup.mjs';

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
