import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobPanel } from './JobPanel';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getBuildLog: vi.fn(async () => ({ log: null })),
    startJob: vi.fn(async () => ({
      id: 'j1',
      subjectId: 's1',
      kind: 'rebuild',
      status: 'queued',
      progress: { done: 0, total: 0, currentFile: null },
      partial: null,
      error: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    })),
  };
});
vi.mock('../api/sse', () => ({ openSubjectEvents: vi.fn(() => () => {}) }));

describe('JobPanel rebuild', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('only starts the rebuild job after confirming', async () => {
    const { startJob } = await import('../api/client');
    render(<JobPanel subjectId="s1" job={null} stale={false} onStarted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild graph' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/backs up graph\.json/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(startJob).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild graph' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }));

    await waitFor(() => expect(startJob).toHaveBeenCalledWith('s1', 'rebuild'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
