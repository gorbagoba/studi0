import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/subjects')) return jsonResponse([]);
      return jsonResponse({
        ok: true,
        opencode: { running: false, pid: null, port: 44096, healthy: false },
      });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the app shell with sidebar and dashboard home', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'studi0' })).toBeTruthy();
    expect(await screen.findByText('No subjects yet.')).toBeTruthy();
    expect(await screen.findByText('No subjects yet')).toBeTruthy();
    // the sidebar CTA and the dashboard quick action share the label
    expect(screen.getAllByRole('button', { name: 'Add subject' }).length).toBeGreaterThanOrEqual(1);
  });
});
