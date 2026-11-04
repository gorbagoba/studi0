import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPage } from './ReviewPage';
import { AppProvider } from '../state/app';
import * as client from '../api/client';

const NOW = '2026-11-01T00:00:00.000Z';

const lessons = [
  { id: 'l1', subjectId: 's1', path: 'lessons/a.html', title: 'Alpha', marker: null, nodeTags: [], createdAt: NOW, updatedAt: NOW },
];

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getLessons: vi.fn(async () => lessons),
    getQuestions: vi.fn(async () => [
      {
        id: 'q1',
        subjectId: 's1',
        lessonId: 'l1',
        topic: 'alpha',
        type: 'mcq',
        payload: {
          prompt: 'Pick one',
          options: [
            { id: 'a', text: 'one' },
            { id: 'b', text: 'two' },
          ],
        },
        keyStatus: 'unverified',
        source: 'on_demand',
        createdAt: NOW,
      },
    ]),
    submitLessonReview: vi.fn(async () => ({ verdict: 'retry', results: [], reviewedAt: null })),
  };
});

const mockReview = vi.mocked(client.submitLessonReview);

function renderReview() {
  return render(
    <AppProvider>
      <ReviewPage subjectId="s1" path="lessons/a.html" version={0} />
    </AppProvider>,
  );
}

describe('ReviewPage', () => {
  afterEach(cleanup);

  it('renders the dedicated review page with the bank question in one form', async () => {
    renderReview();
    expect(await screen.findByRole('region', { name: 'Lesson review' })).toBeTruthy();
    expect(await screen.findByRole('radio', { name: 'one' })).toBeTruthy();
    // submit stays disabled until every question is answered
    expect(screen.getByRole('button', { name: 'Submit review for marking' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows feedback on a retry verdict, then passes on resubmit', async () => {
    mockReview
      .mockResolvedValueOnce({
        verdict: 'retry',
        results: [{ questionId: 'q1', verdict: 'incorrect', answered: true, feedback: 'Not quite — check the notes again.' }],
        reviewedAt: null,
      })
      .mockResolvedValueOnce({
        verdict: 'pass',
        results: [{ questionId: 'q1', verdict: 'correct', answered: true }],
        reviewedAt: NOW,
      });

    renderReview();
    const wrong = await screen.findByRole('radio', { name: 'one' });
    wrong.click();
    screen.getByRole('button', { name: 'Submit review for marking' }).click();

    // retry: warn banner + inline feedback, wrong answer stays editable
    expect(await screen.findByText('Not yet — work the missed ones below')).toBeTruthy();
    expect(screen.getByText('Not quite — check the notes again.')).toBeTruthy();
    const right = screen.getByRole('radio', { name: 'two' });
    expect(right.hasAttribute('disabled')).toBe(false);

    right.click();
    screen.getByRole('button', { name: 'Resubmit review' }).click();

    expect(await screen.findByText(/Review passed/)).toBeTruthy();
    // passed: everything locked, no more resubmission
    expect(screen.getByRole('radio', { name: 'one' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Resubmit review' }).hasAttribute('disabled')).toBe(true);
    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(mockReview).toHaveBeenNthCalledWith(1, 'l1', [{ questionId: 'q1', answer: 'a' }]);
    expect(mockReview).toHaveBeenNthCalledWith(2, 'l1', [{ questionId: 'q1', answer: 'b' }]);
  });
});
