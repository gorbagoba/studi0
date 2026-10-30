import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './client';

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
});
