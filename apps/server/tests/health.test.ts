import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app';

describe('GET /api/health', () => {
  it('returns { ok: true }', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
