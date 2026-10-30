import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

describe('GET /api/health', () => {
  it('returns ok plus managed opencode status', async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      opencode: { running: false, pid: null, port: 44096, healthy: false },
    });
  });
});
