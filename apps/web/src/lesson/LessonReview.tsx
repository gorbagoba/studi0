import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ID, LessonReviewResponse, Question } from '@studi0/shared';
import {
  displayError,
  generateQuestions,
  getQuestions,
  submitLessonReview,
} from '../api/client';
import { Badge } from '../components/Badge';
import { ErrorBanner } from '../components/ErrorBanner';
import { QuizRunner } from '../practice/QuizRunner';

/**
 * Lesson review — instantiated ONLY when the student clicks "Lesson review"
 * in the reader. Reuses the question bank: answer the lesson's bank questions
 * (teacher-graded via the normal flow), then submit for marking. Pass marks
 * the lesson reviewed (tick in lists).
 */
export function LessonReview({
  subjectId,
  lessonId,
  onReviewed,
}: {
  subjectId: ID;
  lessonId: ID;
  onReviewed: () => void;
}) {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LessonReviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(0);

  useEffect(() => {
    let stopped = false;
    getQuestions(subjectId, '', '', lessonId)
      .then((qs) => {
        if (!stopped) setQuestions(qs);
      })
      .catch((e) => {
        if (!stopped) setError(displayError(e));
      });
    return () => {
      stopped = true;
    };
  }, [subjectId, lessonId]);

  async function onGenerate(): Promise<void> {
    setGenBusy(true);
    setError(null);
    try {
      // review bar: 3 short explain-style questions on the lesson's material
      await generateQuestions(subjectId, { topic: 'lesson review', count: 3, lessonId });
      const qs = await getQuestions(subjectId, '', '', lessonId);
      setQuestions(qs);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function onMark(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await submitLessonReview(lessonId);
      setReview(r);
      if (r.verdict === 'pass') onReviewed();
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lesson-review-title" className="panel lesson-review">
      <h3 id="lesson-review-title">Lesson review</h3>
      <p className="muted">
        Answer the review questions — the teacher marks them. Pass every one and this lesson gets
        its tick.
      </p>
      {error !== null && <ErrorBanner message={error} />}
      {questions === null ? (
        <p className="muted">Loading review questions…</p>
      ) : questions.length === 0 ? (
        <div>
          <p>No questions banked for this lesson yet.</p>
          <button className="btn-primary" disabled={genBusy} onClick={() => void onGenerate()}>
            {genBusy ? 'Generating…' : 'Generate review questions'}
          </button>
        </div>
      ) : (
        <>
          <QuizRunner
            questions={questions}
            onClose={() => setQuestions([])}
            onAnswered={() => setAnswered((n) => n + 1)}
          />
          <form onSubmit={(e) => void onMark(e)} className="btn-row">
            <button type="submit" className="btn-primary" disabled={busy || answered === 0}>
              {busy ? 'Marking…' : 'Submit review for marking'}
            </button>
            {answered > 0 && answered < questions.length && (
              <span className="muted">{answered}/{questions.length} answered</span>
            )}
          </form>
        </>
      )}
      {review !== null && (
        <div className={`review-verdict ${review.verdict}`} role="status">
          <Badge tone={review.verdict === 'pass' ? 'ok' : 'warn'}>
            {review.verdict === 'pass' ? '✓ reviewed — understood' : 'retry'}
          </Badge>
          {review.verdict === 'pass' ? (
            <p>You've shown you understand this lesson. The tick is on.</p>
          ) : (
            <ul>
              {review.results
                .filter((r) => r.verdict !== 'correct')
                .map((r) => (
                  <li key={r.questionId}>
                    {r.answered ? `still wrong (verdict: ${r.verdict})` : 'not answered yet'}
                  </li>
                ))}
              <li className="muted">Re-answer the missed questions and submit again.</li>
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
