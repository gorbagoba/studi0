import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, cancelJob, deleteSubject, startJob } from './client';

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps ApiError payloads with code, message and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: 'KEY_NOT_VERIFIED', message: 'key not verified', details: { keyStatus: 'unverified' } },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const err = await api('/api/x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('KEY_NOT_VERIFIED');
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).details).toEqual({ keyStatus: 'unverified' });
  });

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ id: 'x' }]), { status: 200 })),
    );
    expect(await api<{ id: string }[]>('/api/x')).toEqual([{ id: 'x' }]);
  });

  it('sends bodyless POSTs (cancel) without content-type or body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'j1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await cancelJob('j1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('sends deleteSubject as bodyless DELETE without content-type', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteSubject('s1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/subjects/s1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('still sends JSON content-type and body for POSTs that carry one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'j2' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await startJob('s1', 'build');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ kind: 'build' }));
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('surfaces a readable error when a 500 comes back with an empty body (QA #2)', async () => {
    // the historical failure mode: empty-body POST + JSON content-type → Fastify
    // 500 with a non-JSON body; the UI must show a readable message, never crash
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const err: unknown = await cancelJob('j1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('INTERNAL');
    expect((err as ApiError).message).toContain('500');
  });
});
