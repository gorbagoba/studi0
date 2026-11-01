import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CourseSetupBody } from '@studi0/shared';
import { displayError, getSetupStatus, setupCourse } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';

const EMPTY: CourseSetupBody = {
  courseIdentity: '',
  examDate: '',
  confidence: '',
  weakTopics: '',
  hoursPerWeek: '',
  learningStyle: '',
  notesToTeacher: '',
};

/** Course setup form — answers land verbatim in MISSION.md; blanks are omitted. */
export function CourseSetupForm({ subjectId }: { subjectId: string }) {
  const [body, setBody] = useState<CourseSetupBody>(EMPTY);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<boolean | null>(null); // null = unknown yet

  useEffect(() => {
    let stopped = false;
    void getSetupStatus(subjectId)
      .then((r) => {
        if (!stopped) setDone(r.done);
      })
      .catch(() => {
        /* banner is informational — a failed probe just leaves it out */
      });
    return () => {
      stopped = true;
    };
  }, [subjectId]);

  const set = (k: keyof CourseSetupBody) => (v: string) => {
    setSaved(false);
    setBody((b) => ({ ...b, [k]: v }));
  };

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setupCourse(subjectId, body);
      setSaved(true);
      setDone(true);
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="setup-title" className="panel">
      <h2 id="setup-title">Course setup</h2>
      <p className="muted">
        Your answers are written verbatim into <code>MISSION.md</code> — the teacher reads it before
        every session. Every field is optional; blanks are simply omitted.
      </p>
      {error !== null && <ErrorBanner message={error} />}
      {done === true && !saved && (
        <p className="banner banner-ok" role="status">
          Course setup already completed — your answers are in <code>MISSION.md</code>. Submitting
          again updates the same section.
        </p>
      )}
      {saved && (
        <p className="banner banner-ok" role="status">
          Mission written. Open <strong>Chat</strong> and ask the teacher to propose your first lesson
          plan — retaking this form later updates the same section.
        </p>
      )}
      <form className="setup-form" onSubmit={(e) => void onSubmit(e)}>
        <fieldset>
          <legend>The course &amp; exam</legend>
          <div className="field-grid">
            <label className="field">
              Course &amp; exam
              <input
                value={body.courseIdentity}
                onChange={(e) => set('courseIdentity')(e.target.value)}
                placeholder="e.g. CS2107 — Introduction to AI"
              />
            </label>
            <label className="field">
              When is the exam?
              <input
                value={body.examDate}
                onChange={(e) => set('examDate')(e.target.value)}
                placeholder="e.g. 24 Nov · 60% of final grade"
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Where you stand</legend>
          <label className="field">
            Confidence going in
            <select value={body.confidence} onChange={(e) => set('confidence')(e.target.value)}>
              <option value="">—</option>
              <option value="lost">Lost — start from the basics</option>
              <option value="shaky">Shaky — know some of it</option>
              <option value="okay">Okay — need exam polish</option>
              <option value="solid">Solid — targeted practice only</option>
            </select>
          </label>
          <label className="field">
            Which topics worry you most?
            <textarea
              rows={2}
              value={body.weakTopics}
              onChange={(e) => set('weakTopics')(e.target.value)}
              placeholder="e.g. Dijkstra vs Bellman-Ford — when to use which"
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>How we&apos;ll work</legend>
          <div className="field-grid">
            <label className="field">
              Study hours per week
              <input
                value={body.hoursPerWeek}
                onChange={(e) => set('hoursPerWeek')(e.target.value)}
                placeholder="e.g. 6–8"
              />
            </label>
            <label className="field">
              Teaching style that works for you
              <select value={body.learningStyle} onChange={(e) => set('learningStyle')(e.target.value)}>
                <option value="">—</option>
                <option value="examples-first">Examples first, then theory</option>
                <option value="theory-first">Theory first, then examples</option>
                <option value="mixed">Mixed</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="field-urgent">
          <legend>Things I need to tell the teacher</legend>
          <label className="field">
            Anything urgent or important — leave blank if nothing
            <textarea
              rows={3}
              value={body.notesToTeacher}
              onChange={(e) => set('notesToTeacher')(e.target.value)}
              placeholder="Deadlines, circumstances, corrections to how I study, topics the lecturer emphasized…"
            />
          </label>
        </fieldset>

        <div className="btn-row">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Writing…' : 'Write to MISSION.md'}
          </button>
        </div>
      </form>
    </section>
  );
}
