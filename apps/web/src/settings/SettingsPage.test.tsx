import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import * as client from '../api/client';

const health = {
  ok: true,
  opencode: { running: true, pid: '999', port: 44096, healthy: true },
  uptime_s: 125,
  db: 'ok',
  probed_at: new Date().toISOString(),
  jobs: [],
};

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getHealth: vi.fn(),
    restartTeacher: vi.fn(),
    cancelJob: vi.fn(),
  };
});

// AppProvider is required for the Back button's context
import { AppProvider } from '../state/app';

function renderPage() {
  return render(
    <AppProvider>
      <SettingsPage />
    </AppProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  it('probes on mount and shows per-service status chips', async () => {
    vi.mocked(client.getHealth).mockResolvedValue(health);
    renderPage();
    await waitFor(() => expect(client.getHealth).toHaveBeenCalled());
    expect(await screen.findByText('healthy')).toBeTruthy();
    expect(screen.getAllByText('API server').length).toBe(2);
    expect(screen.getAllByText('up', { exact: true }).length).toBe(2);
    expect(screen.getByText('No graph builds running.')).toBeTruthy();
  });

  it('shows the restart-teacher action and calls it on click', async () => {
    vi.mocked(client.getHealth)
      .mockResolvedValueOnce({ ...health, opencode: { ...health.opencode, healthy: false } })
      .mockResolvedValue(health);
    vi.mocked(client.restartTeacher).mockResolvedValue({ ok: true, opencode: health.opencode });
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Restart teacher' });
    fireEvent.click(btn);
    await waitFor(() => expect(client.restartTeacher).toHaveBeenCalled());
    expect(await screen.findByText('Teacher restarted.')).toBeTruthy();
    // re-probe after restart shows healthy again
    await waitFor(() => expect(screen.getByText('healthy')).toBeTruthy());
  });

  it('lists active jobs with a cancel action', async () => {
    vi.mocked(client.getHealth).mockResolvedValue({
      ...health,
      jobs: [{ id: 'j1', subject: 'cs2040c', kind: 'build', status: 'running', done: 3, total: 56 }],
    });
    vi.mocked(client.cancelJob).mockResolvedValue({
      id: 'j1',
      subjectId: 's1',
      kind: 'build',
      status: 'cancelled',
      createdAt: '',
      error: null,
      pid: null,
    } as never);
    renderPage();
    expect(await screen.findByText('cs2040c')).toBeTruthy();
    expect(screen.getByText(/running/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(client.cancelJob).toHaveBeenCalledWith('j1'));
  });

  it('shows the not-answering state when the probe fails', async () => {
    vi.mocked(client.getHealth).mockRejectedValue(new Error('ECONNREFUSED'));
    renderPage();
    expect(await screen.findByText(/not answering/i)).toBeTruthy();
  });
});
