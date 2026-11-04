import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from './GraphView';

const NOW = '2026-11-01T00:00:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [needle, body] of Object.entries(routes)) {
        if (url.includes(needle)) return jsonResponse(body);
      }
      return jsonResponse({});
    }),
  );
}

function renderView() {
  return render(<GraphView subjectId="s1" version={0} />);
}

describe('GraphView chrome', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the loading state until the iframe loads, then the legend and zoom hint', async () => {
    stubFetch({
      '/graph.json': {
        nodes: [
          { entity_type: 'Concept' },
          { entity_type: 'Concept' },
          { entity_type: 'Pitfall' },
        ],
        links: [{ relation: 'uses' }, { relation: 'uses' }, { relation: 'confused_with' }],
      },
      '/graph': {
        graphStatus: 'ready',
        stale: false,
        lastBuiltAt: NOW,
        hasGraph: true,
        hasReport: false,
        hasVerifyReport: false,
      },
    });
    renderView();

    // loading state is visible while the iframe loads
    expect(screen.getByText('Loading graph…')).toBeTruthy();
    // a re-render can detach the found element between find and fire — re-query
    // the live iframe on every retry until the loading state actually clears
    await screen.findByTitle('Interactive knowledge graph');
    await waitFor(() => {
      fireEvent.load(screen.getByTitle('Interactive knowledge graph'));
      expect(screen.queryByText('Loading graph…')).toBeNull();
    });

    // legend chips: node types and relations with counts, most frequent first
    const legend = screen.getByLabelText('Graph legend');
    expect(legend.textContent).toContain('Concept ×2');
    expect(legend.textContent).toContain('Pitfall ×1');
    expect(legend.textContent).toContain('uses ×2');
    expect(legend.textContent).toContain('confused_with ×1');
    // zoom hint + fullscreen control
    expect(screen.getByText(/Scroll to zoom · drag to pan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();
  });

  it('toggles fullscreen on the pane and exits on the button and Escape', async () => {
    stubFetch({
      '/graph.json': { nodes: [], links: [] },
      '/graph': {
        graphStatus: 'ready',
        stale: false,
        lastBuiltAt: NOW,
        hasGraph: true,
        hasReport: false,
        hasVerifyReport: false,
      },
    });
    renderView();
    const iframe = await screen.findByTitle('Interactive knowledge graph');
    fireEvent.load(iframe);

    const pane = screen.getByRole('region', { name: 'Knowledge graph' });
    const btn = screen.getByRole('button', { name: 'Fullscreen' });
    fireEvent.click(btn);
    expect(pane.className).toContain('fullscreen');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(pane.className).not.toContain('fullscreen'));
  });

  it('keeps the empty state when no graph is built', async () => {
    stubFetch({
      '/graph': {
        graphStatus: 'none',
        stale: false,
        lastBuiltAt: null,
        hasGraph: false,
        hasReport: false,
        hasVerifyReport: false,
      },
    });
    renderView();
    expect(await screen.findByText('No graph yet')).toBeTruthy();
  });
});
