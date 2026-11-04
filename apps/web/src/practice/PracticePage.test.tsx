import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PracticePage } from './PracticePage';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

const NOW = '2026-11-01T00:00:00.000Z';

const question = {
  id: 'q1',
  subjectId: 's1',
  lessonId: null,
  topic: 'heaps',
  type: 'mcq' as const,
  payload: {
    prompt: 'Pick one',
    options: [
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
    ],
  },
  keyStatus: 'unverified' as const,
  source: 'on_demand' as const,
  createdAt: NOW,
};

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getStats: vi.fn(async () => ({ perTopic: [], dueCount: 0, streakDays: 0, totalQuestions: 1 })),
    getDue: vi.fn(async () => ({ date: NOW, questions: [] })),
    getQuestions: vi.fn(async () => [question]),
    deleteQuestion: vi.fn(async () => ({ ok: true })),
  };
});

describe('PracticePage', () => {
  afterEach(cleanup);

  it('deletes a bank question after confirming, warning about attempt history, and refreshes', async () => {
    const { deleteQuestion, getQuestions } = await import('../api/client');
    render(<PracticePage subjectId="s1" version={0} />);

    // before the dialog opens, the row's Delete is the only one
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    // the dialog states that attempt history goes too
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/attempt history/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteQuestion).toHaveBeenCalledWith('q1'));
    // initial fetch + version-bump refetch after the delete
    await waitFor(() => expect(getQuestions).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
