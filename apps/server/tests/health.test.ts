import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

describe('GET /api/health', () => {
  it('returns ok, managed opencode status, db probe, uptime and active jobs', async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.opencode).toEqual({ running: false, pid: null, port: 44096, healthy: false });
    expect(body.db).toBe('ok');
    expect(Number.isInteger(body.uptime_s)).toBe(true);
    expect(typeof body.probed_at).toBe('string');
    expect(body.jobs).toEqual([]);
  });
});
