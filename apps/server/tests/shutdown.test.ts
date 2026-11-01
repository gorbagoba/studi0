import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
});

describe('POST /api/shutdown', () => {
  it('responds ok and self-signals SIGTERM (killing vitest would be rude)', async () => {
    h = await makeHarness();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const res = await h.app.inject({ method: 'POST', url: '/api/shutdown' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // the route defers the signal 50ms so the response can flush first
    await new Promise((r) => setTimeout(r, 80));
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });
});
