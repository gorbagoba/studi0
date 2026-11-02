import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByTitle('Lesson content: Alpha')).toBeTruthy());
  });
});
