import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ID, LessonReviewResponse, Question } from '@studi0/shared';
import {
  displayError,
  generateQuestions,
  getQuestions,
  submitLessonReview,
} from '../api/client';
import { useLessons } from '../api/hooks';
import { useApp } from '../state/app';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatDateTime } from '../lib/format';

/**
 * Dedicated lesson review page — every bank question in ONE submittable form.
 * One click grades all of them; wrong ones stay editable for resubmission
 * until every question is correct, which marks the lesson reviewed.
 */
export function ReviewPage({
  subjectId,
  path,
  version,
  onLessonSaved,
}: {
  subjectId: ID;
  path: string;
  version: number;
  onLessonSaved?: () => void;
}) {
  const lessons = useLessons(subjectId, version);
  const { closeReview } = useApp();
  const lesson = lessons.data?.find((l) => l.path === path) ?? null;
  const lessonId = lesson?.id ?? null;

  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [answers, setAnswers] = useState<Record<ID, string>>({});
  const [review, setReview] = useState<LessonReviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lessonId === null) return;
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
    if (lessonId === null) return;
    setGenBusy(true);
    setError(null);
    try {
      // review bar: 3 short explain-style questions on the lesson's material
      await generateQuestions(subjectId, { topic: 'lesson review', count: 3, lessonId });
      setQuestions(await getQuestions(subjectId, '', '', lessonId));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (lessonId === null || questions === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await submitLessonReview(
        lessonId,
        questions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? '' })),
      );
      setReview(r);
      if (r.verdict === 'pass') onLessonSaved?.();
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  const passed = review?.verdict === 'pass';
  const results = new Map((review?.results ?? []).map((r) => [r.questionId, r]));
  const allAnswered =
    questions !== null && questions.length > 0 && questions.every((q) => (answers[q.id] ?? '').trim() !== '');

  return (
    <section className="lesson-viewer" aria-label="Lesson review">
      <div className="lesson-head">
        <button className="btn" onClick={closeReview} aria-label="Back to lesson">
          ← Back to lesson
        </button>
        <h2>{lesson?.title ?? 'Lesson review'}</h2>
        {lesson?.reviewedAt != null && (
          <span className="muted">reviewed {formatDateTime(lesson.reviewedAt)}</span>
        )}
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {review !== null && (
        <div className={`banner ${passed ? 'banner-ok' : 'banner-warn'}`} role="status">
          <strong>
            {passed
              ? '✓ Review passed — you’ve shown you understand this lesson'
              : 'Not yet — work the missed ones below'}
          </strong>
          {passed && review.reviewedAt !== null && (
            <span className="muted"> marked {formatDateTime(review.reviewedAt)}</span>
          )}
        </div>
      )}
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
        <form onSubmit={(e) => void onSubmit(e)} aria-label="Review questions" className="stack">
          {questions.map((q) => {
            const result = results.get(q.id);
            const locked = result?.verdict === 'correct';
            return (
              <div key={q.id} className="panel quiz-question">
                <p>
                  <span className="chip">{q.type}</span> <strong>{q.topic}</strong>
                </p>
                <p className="quiz-prompt">{q.payload.prompt}</p>
                {q.type === 'mcq' ? (
                  <fieldset>
                    <legend className="visually-hidden">Options</legend>
                    {q.payload.options?.map((o) => (
                      <div key={o.id} className="radio-row">
                        <input
                          type="radio"
                          id={`opt-${q.id}-${o.id}`}
                          name={`q-${q.id}`}
                          value={o.id}
                          checked={answers[q.id] === o.id}
                          onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))}
                          disabled={busy || locked}
                        />
                        <label htmlFor={`opt-${q.id}-${o.id}`}>{o.text}</label>
                      </div>
                    ))}
                  </fieldset>
                ) : (
                  <>
                    <label htmlFor={`ans-${q.id}`}>
                      {q.type === 'code' ? 'Your code' : 'Your answer'}
                    </label>
                    <textarea
                      id={`ans-${q.id}`}
                      value={answers[q.id] ?? ''}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      rows={q.type === 'code' ? 8 : 3}
                      className={q.type === 'code' ? 'code-input' : undefined}
                      disabled={busy || locked}
                    />
                  </>
                )}
                {locked && <p className="review-ok">✓ Correct</p>}
                {!locked && result?.feedback !== undefined && (
                  <p className="review-feedback">{result.feedback}</p>
                )}
              </div>
            );
          })}
          <div className="btn-row">
            <button type="submit" className="btn-primary" disabled={busy || passed || !allAnswered}>
              {busy ? 'Marking…' : results.size > 0 ? 'Resubmit review' : 'Submit review for marking'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
