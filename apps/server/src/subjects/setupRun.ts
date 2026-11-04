import { resolveOpencodeBin } from '../util/proc.js';
import { detectAndIndexLessons } from '../teacher/lessons.js';
import type { Ctx } from '../context.js';
import type { SubjectRow } from '../db/repos/subjects.js';

export interface ActiveSetupRun {
  subjectId: string;
  subjectName: string;
  startedAt: string;
}

/** Course-setup teacher runs in flight (per-process guard + agent-status source). */
const active = new Map<string, ActiveSetupRun>();

/** Snapshot of in-flight setup runs, for the agent-status endpoint. */
export function activeSetupRuns(): ActiveSetupRun[] {
  return [...active.values()];
}

/** The prompt for the server-initiated headless course-setup run. */
export function setupPrompt(subjectName: string): string {
  return [
    `COURSE SETUP RUN for "${subjectName}" — headless one-shot; nobody can answer you mid-run.`,
    '',
    'MISSION.md already contains the student\'s completed setup form ("## Student setup (from form)").',
    'Treat it as canonical — do NOT re-run the interview.',
    '',
    'Your job, in this single run:',
    '1. Read MISSION.md, then map the course: the pacing spine (syllabus.md if present, else the structure of material/) and, when graphify-out/graph.json exists, at most 2 graphify queries for the topic clusters.',
    '2. Pressing questions FIRST: if anything important is genuinely ambiguous (scope, exam emphasis, ordering), open your reply with a short numbered question list (max 5) the student can answer later in Chat — then CONTINUE WITHOUT WAITING, choosing sensible defaults (the examiner\'s emphasis in the material wins).',
    '3. Generate the COMPLETE lesson set: one lesson per spine topic covering the whole course, numbered lessons/0001-… in order, each following the Lessons rules (marker line, MathJax when math, mandated template, teach-back close). Cram pace = prioritize exam-critical topics and keep lessons focused; long-term = full depth.',
    '4. End your reply with a one-line summary: how many lessons you wrote, and the questions the student should answer in Chat.',
    '',
    'Headless reality: denied tool calls cannot be un-denied — if a graphify query is refused, fall back to grep over material/ and graphify-out/wiki/ and keep going.',
  ].join('\n');
}

/**
 * Fire the headless course-setup teacher run (generates all lessons). One run
 * per subject; completed lessons are indexed + SSE-emitted when it finishes.
 */
export function startSetupRun(
  ctx: Ctx,
  subject: SubjectRow,
): 'started' | 'running' | 'skipped' {
  if (active.has(subject.id)) return 'running';
  if (!resolveOpencodeBin()) return 'skipped';
  const entry: ActiveSetupRun = {
    subjectId: subject.id,
    subjectName: subject.name,
    startedAt: new Date().toISOString(),
  };
  active.set(subject.id, entry);
  ctx.events.emit(subject.id, 'setup', { state: 'started', ...entry });
  const before = import('../teacher/lessons.js').then((m) => m.snapshotLessons(subject));
  void (async () => {
    try {
      await ctx.teacherRun(subject.path, setupPrompt(subject.name));
    } catch (e) {
      const msg = e instanceof Error ? e.message : e;
      console.error(`[setup-run ${subject.id.slice(0, 8)}] failed:`, msg);
      ctx.events.emit(subject.id, 'setup', {
        state: 'failed',
        subjectId: subject.id,
        subjectName: subject.name,
        error: msg instanceof Error ? msg.message : String(msg),
      });
    } finally {
      try {
        // whatever got written lands in the app immediately (SSE onLesson)
        const rows = await detectAndIndexLessons(ctx.db, subject, await before, ctx.events);
        ctx.events.emit(subject.id, 'setup', {
          state: 'done',
          subjectId: subject.id,
          subjectName: subject.name,
          lessons: rows.length,
        });
      } catch (e) {
        console.error(`[setup-run ${subject.id.slice(0, 8)}] indexing failed:`, e instanceof Error ? e.message : e);
      }
      active.delete(subject.id);
    }
  })();
  return 'started';
}
