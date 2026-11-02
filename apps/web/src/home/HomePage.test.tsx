import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { AppProvider, useApp } from '../state/app';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

const NOW = '2026-11-01T00:00:00.000Z';
const subject = {
  id: 's1',
  name: 'QA Heaps',
  path: 'C:/t/qa',
  createdAt: NOW,
  lastBuiltAt: null,
  stale: false,
  groupId: null,
  groupName: null,
  icon: '🧠',
};

const stats = {
  perTopic: [{ topic: 'heaps', attempts: 10, correct: 8, accuracy: 0.8 }],
  dueCount: 2,
  streakDays: 3,
  totalQuestions: 12,
};

const lessons = [
  { id: 'l1', subjectId: 's1', path: 'lessons/sift.html', title: 'Sift-down', marker: null, nodeTags: [], createdAt: NOW, updatedAt: '2026-11-01T10:00:00.000Z' },
];

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

// route table is matched in insertion order — list the specific ones first
const ROUTES = {
  '/practice/stats': stats,
  '/practice/due': { date: NOW, questions: [] },
  '/lessons': lessons,
  '/api/subjects': [subject],
};

/** surfaces the app state so navigation from the dashboard can be asserted */
function Probe() {
  const { subjectId, tab, lessonPath } = useApp();
  return (
    <output data-testid="probe">
      {subjectId ?? 'none'}:{tab}:{lessonPath ?? '-'}
    </output>
  );
}

function renderHome() {
  return render(
    <AppProvider>
      <HomePage />
      <Probe />
    </AppProvider>,
  );
}

describe('HomePage dashboard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows due-today, per-subject progress, recent lessons and quick actions', async () => {
    stubFetch(ROUTES);
    renderHome();
    expect(await screen.findByText('Due today')).toBeTruthy();
    expect(screen.getByText('Subjects')).toBeTruthy();
    expect(screen.getByText('Recent lessons')).toBeTruthy();
    // due panel names the subject with the count
    expect(screen.getAllByText('QA Heaps').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 due').length).toBeGreaterThan(0);
    // per-subject progress row carries accuracy + counts
    expect(screen.getByText('80% accuracy')).toBeTruthy();
    expect(screen.getByText(/12 questions/)).toBeTruthy();
    // recent lesson lists the lesson with its subject
    expect(screen.getByText('Sift-down')).toBeTruthy();
    // quick actions
    expect(screen.getByRole('button', { name: 'Add subject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('opens the subject from the due panel and the lesson from recent lessons', async () => {
    stubFetch(ROUTES);
    renderHome();
    const duePanel = await screen.findByRole('region', { name: 'Due today' });
    fireEvent.click(within(duePanel).getByRole('button', { name: /QA Heaps/ }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('s1:material:-'));

    // remount for the lesson navigation check
    cleanup();
    renderHome();
    const lessonsPanel = await screen.findByRole('region', { name: 'Recent lessons' });
    fireEvent.click(within(lessonsPanel).getByRole('button', { name: /Sift-down/ }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('s1:lessons:lessons/sift.html'),
    );
  });

  it('renders an intentional empty state when no subjects exist', async () => {
    stubFetch({ '/api/subjects': [] });
    renderHome();
    expect(await screen.findByText('No subjects yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add subject' })).toBeTruthy();
    // the CTA opens the same styled dialog the sidebar uses
    fireEvent.click(screen.getByRole('button', { name: 'Add subject' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Add subject' })).toBeTruthy();
  });

  it('degrades gracefully when per-subject stats fail', async () => {
    stubFetch({
      '/practice/stats': { error: { code: 'INTERNAL', message: 'boom' } },
      '/lessons': [],
      '/api/subjects': [subject],
    });
    renderHome();
    expect(await screen.findByText('Subjects')).toBeTruthy();
    // subject row still renders with zeroed stats — no error wall
    expect(screen.getByText(/0 questions/)).toBeTruthy();
  });
});
