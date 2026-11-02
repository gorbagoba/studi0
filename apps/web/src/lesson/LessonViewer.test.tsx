import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LessonViewer } from './LessonViewer';
import { AppProvider } from '../state/app';

const NOW = '2026-11-01T00:00:00.000Z';

const lessons = [
  { id: 'l1', subjectId: 's1', path: 'lessons/a.html', title: 'Alpha', marker: null, nodeTags: [], createdAt: NOW, updatedAt: NOW },
  { id: 'l2', subjectId: 's1', path: 'lessons/b.html', title: 'Beta', marker: null, nodeTags: [], createdAt: NOW, updatedAt: NOW },
];

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getLessons: vi.fn(async () => lessons),
    getLessonContent: vi.fn(async () => ({ path: 'lessons/a.html', title: 'Alpha', html: '<p>x</p>', updatedAt: NOW })),
    getSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: 'cs1', subjectId: 's1', lessonId: null, active: true, messageCount: 0, summaryPath: null, createdAt: NOW, lastMessageAt: null, title: null })),
    getMessages: vi.fn(async () => []),
    renameChatSession: vi.fn(async () => undefined),
  };
});

vi.mock('../api/sse', () => ({ postChatStream: vi.fn() }));

function renderViewer(path: string) {
  return render(
    <AppProvider>
      <LessonViewer subjectId="s1" path={path} version={0} onClosed={() => {}} />
    </AppProvider>,
  );
}

describe('LessonViewer', () => {
  afterEach(cleanup);

  it('renders the nav bar with dropdown and the bottom pager', async () => {
    renderViewer('lessons/a.html');
    await waitFor(() => expect(screen.getByLabelText('Lesson navigation')).toBeTruthy());
    // first lesson: prev disabled, next enabled (bottom pager shows titles)
    expect(screen.getByText('◀ Previous').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Beta ▶')).toBeTruthy();
    expect((screen.getByLabelText('Go to lesson') as HTMLSelectElement).value).toBe('lessons/a.html');
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('renders the lesson content iframe', async () => {
    renderViewer('lessons/a.html');
    const frame = await waitFor(() => screen.getByTitle('Lesson content: Alpha'));
    expect(frame.getAttribute('srcdoc')).toContain('column-count: 2');
  });

  it('offers text-size controls and a reading mode with Escape exit', async () => {
    renderViewer('lessons/a.html');
    await waitFor(() => expect(screen.getByTitle('Lesson content: Alpha')).toBeTruthy());
    expect(screen.getByLabelText('Smaller text').hasAttribute('disabled')).toBe(false);
    const read = screen.getByLabelText('Reading mode');
    expect(read.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(read);
    expect(screen.getByLabelText('Exit reading mode')).toBeTruthy();
    expect(screen.getByLabelText('Toggle chat panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Exit reading mode')).toBeNull());
    expect(screen.getByLabelText('Reading mode').getAttribute('aria-pressed')).toBe('false');
  });
});
