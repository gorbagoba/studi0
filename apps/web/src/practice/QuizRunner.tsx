import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AnswerResponse, Question, QuestionKey, KeyStatus } from '@studi0/shared';
import {
  ApiError,
  answerQuestion,
  displayError,
  revealKey,
  verifyKey,
} from '../api/client';
import { Badge } from '../components/Badge';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatDateTime } from '../lib/format';

export function QuizRunner({
  questions,
  onClose,
  onAnswered,
}: {
  questions: Question[];
  onClose: () => void;
  onAnswered?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [reveal, setReveal] = useState<QuestionKey | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(questions[0]?.keyStatus ?? 'unverified');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const question = questions[index];

  useEffect(() => {
    setAnswer('');
    setResult(null);
    setReveal(null);
    setBlocked(null);
    setError(null);
    setKeyStatus(question.keyStatus);
  }, [question.id, question.keyStatus]);

  if (question === undefined) return null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (answer.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      setResult(await answerQuestion(question.id, answer));
      onAnswered?.();
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  async function doReveal(): Promise<void> {
    setBusy(true);
    setBlocked(null);
    setError(null);
    try {
      setReveal((await revealKey(question.id)).key);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'KEY_NOT_VERIFIED') {
        setBlocked(
          `The key is not verified (status: ${keyStatus}) — reveal is blocked until verification passes.`,
        );
      } else {
        setError(displayError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function doVerify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await verifyKey(question.id);
      setKeyStatus(r.keyStatus);
      setBlocked(
        r.keyStatus === 'verified'
          ? 'Key verified — you can reveal it now.'
          : `Verification failed${r.reason !== undefined ? ` — ${r.reason}` : ''}. The key stays locked; treat the question as unreliable and regenerate it.`,
      );
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="runner-title" className="panel quiz-runner">
      <div className="quiz-head">
        <h3 id="runner-title">
          Practice — question {index + 1} of {questions.length}
        </h3>
        <div className="btn-row">
          {index < questions.length - 1 && (
            <button className="btn" disabled={busy} onClick={() => setIndex((i) => i + 1)}>
              Next question
            </button>
          )}
          <button className="btn" onClick={onClose}>
            End session
          </button>
        </div>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      <article className="quiz-question">
        <p>
          <span className="chip">{question.type}</span> <strong>{question.topic}</strong>
        </p>
        <p className="quiz-prompt">{question.payload.prompt}</p>
        {question.type === 'mcq' ? (
          <fieldset>
            <legend className="visually-hidden">Options</legend>
            {question.payload.options?.map((o) => (
              <div key={o.id} className="radio-row">
                <input
                  type="radio"
                  id={`opt-${question.id}-${o.id}`}
                  name={`q-${question.id}`}
                  value={o.id}
                  checked={answer === o.id}
                  onChange={() => setAnswer(o.id)}
                  disabled={result !== null}
                />
                <label htmlFor={`opt-${question.id}-${o.id}`}>{o.text}</label>
              </div>
            ))}
          </fieldset>
        ) : (
          <>
            <label htmlFor={`ans-${question.id}`}>
              {question.type === 'code' ? 'Your code' : 'Your answer'}
            </label>
            <textarea
              id={`ans-${question.id}`}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={question.type === 'code' ? 8 : 3}
              className={question.type === 'code' ? 'code-input' : undefined}
              disabled={result !== null}
            />
          </>
        )}
        {result === null ? (
          <form onSubmit={(e) => void submit(e)} className="btn-row">
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || answer.trim() === ''}
            >
              Submit answer
            </button>
          </form>
        ) : (
          <div className="quiz-result" role="status">
            <Badge
              tone={
                result.grade.verdict === 'correct'
                  ? 'ok'
                  : result.grade.verdict === 'partial'
                    ? 'warn'
                    : 'err'
              }
            >
              {result.grade.verdict}
            </Badge>
            <p>{result.grade.feedback}</p>
            <p className="muted">
              Next review in {result.intervalDays} day(s) — {formatDateTime(result.nextDueAt)}.
            </p>
          </div>
        )}
        <KeyGate
          question={question}
          keyStatus={keyStatus}
          reveal={reveal}
          blocked={blocked}
          busy={busy}
          onReveal={() => void doReveal()}
          onVerify={() => void doVerify()}
        />
      </article>
    </section>
  );
}

function KeyGate({
  question,
  keyStatus,
  reveal,
  blocked,
  busy,
  onReveal,
  onVerify,
}: {
  question: Question;
  keyStatus: KeyStatus;
  reveal: QuestionKey | null;
  blocked: string | null;
  busy: boolean;
  onReveal: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="key-gate">
      <div className="btn-row">
        <button className="btn" disabled={busy} onClick={onReveal}>
          Reveal answer key
        </button>
        <button className="btn" disabled={busy} onClick={onVerify}>
          Run key verification
        </button>
        <Badge tone={keyStatus === 'verified' ? 'ok' : keyStatus === 'failed' ? 'err' : 'neutral'}>
          key: {keyStatus}
        </Badge>
      </div>
      {blocked !== null && (
        <p className="banner banner-warn" role="status">
          {blocked}
        </p>
      )}
      {reveal !== null && (
        <div className="key-reveal">
          <h4>Answer key</h4>
          {reveal.answerIndex !== undefined && (
            <p>
              Correct option:{' '}
              {question.payload.options?.[reveal.answerIndex]?.text ?? `option #${reveal.answerIndex}`}
            </p>
          )}
          {reveal.answer !== undefined && (
            <p>
              <strong>Answer:</strong> {reveal.answer}
            </p>
          )}
          {reveal.rubric !== undefined && (
            <p className="muted">
              <strong>Rubric:</strong> {reveal.rubric}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
