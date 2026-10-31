import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@studi0/shared';
import { AppProvider } from '../state/app';
import { SubjectPage } from './SubjectPage';

// capture the SSE handlers so tests can push job events like the live stream does
const sse = vi.hoisted(() => ({ handlers: null as { onJob: (job: Job) => void } | null }));
vi.mock('../api/sse', () => ({
  openSubjectEvents: vi.fn((_id: string, handlers: { onJob: (job: Job) => void }) => {
    sse.handlers = handlers;
    return () => {};
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOW = '2026-10-31T00:00:00.000Z';
function job(status: Job['status']): Job {
  return {
    id: 'j1',
    subjectId: 's1',
    kind: 'build',
    status,
    progress: { done: 0, total: 0, currentFile: null },
    partial: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
  };
}

const subjectDetail = {
  id: 's1',
  name: 'QA Subject',
  path: 'C:/tmp/qa-subject',
  createdAt: NOW,
  lastBuiltAt: null,
  stale: false,
  graphStatus: 'none',
  activeJob: null,
  counts: { lessons: 0, questions: 0, due: 0 },
};

describe('SubjectPage job state', () => {
  let resolveStart: ((job: Job) => void) | null;

  beforeEach(() => {
    resolveStart = null;
    sse.handlers = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/jobs') && init?.method === 'POST') {
          // hold the start POST until the test resolves it (late 202 response)
          return new Promise<Response>((resolve) => {
            resolveStart = (j: Job) => resolve(jsonResponse(j, 202));
          });
        }
        if (url.endsWith('/cancel') && init?.method === 'POST')
          return Promise.resolve(jsonResponse(job('cancelling')));
        if (url.includes('/tree')) return Promise.resolve(jsonResponse({ dir: 'material', entries: [] }));
        if (url.endsWith('/graph/report'))
          return Promise.resolve(jsonResponse({ graphReport: null, verifyReport: null }));
        if (url.endsWith('/graph'))
          return Promise.resolve(
            jsonResponse({
              graphStatus: 'none',
              stale: false,
              lastBuiltAt: null,
              hasGraph: false,
              hasReport: false,
              hasVerifyReport: false,
            }),
          );
        if (url.endsWith('/wiki')) return Promise.resolve(jsonResponse({ pages: [] }));
        return Promise.resolve(jsonResponse(subjectDetail));
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not regress to queued when the start POST resolves after SSE said running', async () => {
    render(
      <AppProvider>
        <SubjectPage subjectId="s1" />
      </AppProvider>,
    );
    expect(await screen.findByText('QA Subject')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Build graph' }));

    // server emits queued→running before the 202 is sent, so SSE arrives first
    act(() => sse.handlers!.onJob(job('running')));
    expect(await screen.findByText(/Working…/)).toBeTruthy();

    await act(async () => resolveStart!(job('queued')));
    expect(screen.queryByText(/Queued — waiting/)).toBeNull();
    expect(screen.getByText(/Working…/)).toBeTruthy();
  });

  it('lets a cancel response upgrade the snapshot from running to cancelling', async () => {
    render(
      <AppProvider>
        <SubjectPage subjectId="s1" />
      </AppProvider>,
    );
    expect(await screen.findByText('QA Subject')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Build graph' }));

    act(() => sse.handlers!.onJob(job('running')));
    expect(await screen.findByText(/Working…/)).toBeTruthy();
    await act(async () => resolveStart!(job('queued')));
    expect(screen.getByText(/Working…/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Cancelling…/)).toBeTruthy();
  });
});
