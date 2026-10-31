import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

describe('body-parser errors (QA minor 6)', () => {
  it('malformed JSON body → 400 VALIDATION envelope, not 500', async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/subjects',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('empty JSON body → 400 VALIDATION envelope (UI cancel path)', async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/00000000-0000-0000-0000-000000000000/cancel',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});
