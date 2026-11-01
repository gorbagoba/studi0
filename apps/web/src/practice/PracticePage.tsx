import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ID, Question, QuestionType } from '@studi0/shared';
import { useDue, useQuestions, useStats } from '../api/hooks';
import { displayError, generateQuestions } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Badge } from '../components/Badge';
import { formatDateTime } from '../lib/format';
import { StatsCards } from './StatsCards';
import { QuizRunner } from './QuizRunner';

export function PracticePage({ subjectId, version }: { subjectId: ID; version: number }) {
  const [localV, setLocalV] = useState(0);
  const v = version + localV;
  const stats = useStats(subjectId, v);
  const due = useDue(subjectId, v);
  const [topic, setTopic] = useState('');
  const [type, setType] = useState<'' | QuestionType>('');
  const [applied, setApplied] = useState<{ topic: string; type: '' | QuestionType }>({
    topic: '',
    type: '',
  });
  const bank = useQuestions(subjectId, applied.topic, applied.type, v);
  const [queue, setQueue] = useState<Question[] | null>(null);
  const [genTopic, setGenTopic] = useState('');
  const [genCount, setGenCount] = useState(5);
  const [genDifficulty, setGenDifficulty] = useState<'mixed' | 'easy' | 'medium' | 'hard'>('mixed');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function generate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setGenerating(true);
    setGenError(null);
    try {
      await generateQuestions(subjectId, { topic: genTopic.trim(), count: genCount, difficulty: genDifficulty });
      setLocalV((x) => x + 1);
    } catch (err) {
      setGenError(displayError(err));
    } finally {
      setGenerating(false);
    }
  }

  const refresh = () => setLocalV((x) => x + 1);

  return (
    <div className="stack">
      {queue !== null && (
        <QuizRunner questions={queue} onClose={() => { setQueue(null); refresh(); }} onAnswered={refresh} />
      )}
      <StatsCards stats={stats.data} />
      <section aria-labelledby="due-title" className="panel">
        <h3 id="due-title">Due today</h3>
        {due.loading && <p className="muted">Loading…</p>}
        {due.error !== null && <ErrorBanner message={due.error} />}
        {due.data !== null &&
          (due.data.questions.length === 0 ? (
            <p className="muted">
              Nothing due right now — each answer schedules the next review (1/3/7 days).
            </p>
          ) : (
            <div className="btn-row">
              <span>
                {due.data.questions.length} question(s) due as of {formatDateTime(due.data.date)}.
              </span>
              <button className="btn-primary" onClick={() => setQueue(due.data?.questions ?? [])}>
                Start review
              </button>
            </div>
          ))}
      </section>
      <section aria-labelledby="bank-title" className="panel">
        <h3 id="bank-title">Question bank</h3>
        <form
          className="filter-row"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ topic, type });
          }}
        >
          <label htmlFor="q-topic">Topic</label>
          <input
            id="q-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. heaps"
          />
          <label htmlFor="q-type">Type</label>
          <select
            id="q-type"
            value={type}
            onChange={(e) => setType(e.target.value as '' | QuestionType)}
          >
            <option value="">All</option>
            <option value="mcq">MCQ</option>
            <option value="short">Short answer</option>
            <option value="code">Code</option>
          </select>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
        <form className="filter-row" onSubmit={(e) => void generate(e)}>
          <label htmlFor="gen-topic">Generate on topic</label>
          <input
            id="gen-topic"
            required
            value={genTopic}
            onChange={(e) => setGenTopic(e.target.value)}
            placeholder="e.g. heaps"
          />
          <label htmlFor="gen-count">Count</label>
          <select
            id="gen-count"
            value={genCount}
            onChange={(e) => setGenCount(Number(e.target.value))}
          >
            {[5, 10, 15, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label htmlFor="gen-difficulty">Difficulty</label>
          <select
            id="gen-difficulty"
            value={genDifficulty}
            onChange={(e) => setGenDifficulty(e.target.value as 'mixed' | 'easy' | 'medium' | 'hard')}
          >
            <option value="mixed">Mixed</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
          <button className="btn" type="submit" disabled={generating}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </form>
        {generating && (
          <p role="status" className="muted">
            Generating questions — this can take about a minute.
          </p>
        )}
        {genError !== null && <ErrorBanner message={genError} />}
        {bank.loading && <p className="muted">Loading…</p>}
        {bank.error !== null && <ErrorBanner message={bank.error} />}
        {bank.data !== null &&
          (bank.data.length === 0 ? (
            <EmptyState
              title="No questions"
              hint="Questions are auto-deposited from lessons, or generate some above."
            />
          ) : (
            <ul className="bank-list">
              {bank.data.map((q) => (
                <li key={q.id} className="bank-item">
                  <div className="bank-meta">
                    <span className="chip">{q.type}</span>
                    <span>{q.topic}</span>
                    <Badge
                      tone={q.keyStatus === 'verified' ? 'ok' : q.keyStatus === 'failed' ? 'err' : 'neutral'}
                    >
                      key: {q.keyStatus}
                    </Badge>
                    <span className="muted">
                      {q.source} · {formatDateTime(q.createdAt)}
                    </span>
                  </div>
                  <button className="btn btn-small" onClick={() => setQueue([q])}>
                    Practice
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
