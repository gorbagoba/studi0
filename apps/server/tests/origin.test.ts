import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>> | undefined;

afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

let n = 0;
const post = (headers: Record<string, string>) =>
  h!.app.inject({
    method: 'POST',
    url: '/api/subjects',
    payload: { name: `Origin${++n}` },
    headers,
  });

describe('origin guard on mutating routes', () => {
  it('passes header-absent clients (curl, tests)', async () => {
    h = await makeHarness();
    const res = await post({});
    expect(res.statusCode).toBe(201);
  });

  it('allows the app origin and same-origin/none fetch metadata', async () => {
    h = await makeHarness();
    expect((await post({ origin: 'http://127.0.0.1:5173' })).statusCode).toBe(201);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
    expect((await post({ 'sec-fetch-site': 'none' })).statusCode).toBe(201);
  });

  it('rejects foreign origins and cross-site fetch metadata with 403', async () => {
    h = await makeHarness();
    const evil = await post({ origin: 'http://evil.example' });
    expect(evil.statusCode).toBe(403);
    const cross = await post({ 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
  });

  it('does not touch GET requests', async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/subjects',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});
