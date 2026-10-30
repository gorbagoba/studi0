import * as chatRepo from '../db/repos/chat.js';
import * as jobsRepo from '../db/repos/jobs.js';
import * as lessonsRepo from '../db/repos/lessons.js';
import { maybeRotate, fetchHistory } from './sessions.js';
import { detectAndIndexLessons, snapshotLessons } from './lessons.js';
import { extractQuizBlocks, depositQuiz } from './quizScan.js';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { EventBus, Send } from '../http/sse.js';
import type { OcClient } from './sdk.js';
import type { FeedQuestionsFn } from './practiceFeed.js';
import type { OneshotFn } from '../util/oneshot.js';
import type { ChatSessionRow } from '../db/repos/chat.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import { HttpError } from '../util/errors.js';

const TURN_TIMEOUT_MS = 15 * 60_000;

export interface StreamTurnDeps {
  db: Db;
  cfg: Config;
  events: EventBus;
  client: OcClient;
  oneshot: OneshotFn;
  feedQuestions: FeedQuestionsFn;
}

/**
 * One chat turn: rotation check → context preamble → SDK prompt → SSE pump
 * (token deltas) → lesson/quiz detection → `done`. Exactly one terminal event.
 */
export async function streamTurn(
  deps: StreamTurnDeps,
  subject: SubjectRow,
  startSession: ChatSessionRow,
  content: string,
  lessonIdOverride: string | null,
  send: Send,
): Promise<void> {
  const { db, events, client, oneshot, feedQuestions } = deps;
  let session = startSession;
  let terminalSent = false;

  const terminate = (event: 'done' | 'error', data: unknown) => {
    if (terminalSent) return;
    terminalSent = true;
    send(event, data);
  };

  try {
    // rotation check first (AC16): continue transparently in a fresh session
    const rotation = await maybeRotate(client, oneshot, db, subject, session);
    if (rotation.rotated && rotation.summaryPath) {
      send('rotated', { newSessionId: rotation.session.id, summaryPath: rotation.summaryPath });
      session = rotation.session;
    }

    const scopedLessonId = lessonIdOverride ?? session.lesson_id;
    const lesson = scopedLessonId ? lessonsRepo.getLesson(db, scopedLessonId) : null;
    if (scopedLessonId && !lesson) throw new HttpError('FILE_NOT_FOUND', 'lesson not found');

    const graphJob = jobsRepo.activeJobForSubject(db, subject.id);
    const preamble = buildPreamble(
      Boolean(graphJob),
      lesson?.rel_path ?? null,
      rotation.summaryPath ?? session.summary_path,
    );

    const before = await snapshotLessons(subject);

    let resolveIdle!: (v: 'idle' | 'failed') => void;
    const idle = new Promise<'idle' | 'failed'>((res) => {
      resolveIdle = res;
    });

    const pump = (async () => {
      const stream = client.event.subscribe({
        types: ['session.text.delta', 'session.idle', 'session.execution.failed', 'permission.asked'],
      });
      for await (const event of stream) {
        if (event.type === 'session.text.delta' && event.data.sessionID === session.oc_session_id) {
          send('token', { text: event.data.delta });
        } else if (event.type === 'session.idle' && event.data.sessionID === session.oc_session_id) {
          resolveIdle('idle');
          break;
        } else if (
          event.type === 'session.execution.failed' &&
          event.data.sessionID === session.oc_session_id
        ) {
          resolveIdle('failed');
          break;
        } else if (
          event.type === 'permission.asked' &&
          event.data.sessionID === session.oc_session_id
        ) {
          // headless: nobody answers prompts — reject so the agent keeps working in its allowlist
          void client.permission
            .reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: 'reject' })
            .catch(() => undefined);
        }
      }
    })();

    await client.session.prompt({
      sessionID: session.oc_session_id,
      text: preamble ? `${preamble}\n\n${content}` : content,
    });

    const timer = setTimeout(() => resolveIdle('failed'), TURN_TIMEOUT_MS);
    timer.unref();
    const outcome = await idle;
    clearTimeout(timer);
    void pump.catch(() => undefined);

    if (outcome === 'failed') throw new HttpError('INTERNAL', 'teacher turn failed or timed out');

    // index lessons written during the turn
    const lessonRows = await detectAndIndexLessons(db, subject, before, events);
    for (const row of lessonRows) {
      send('lesson', lessonsRepo.lessonToDto(row));
      feedQuestions(subject, row);
    }

    // quiz blocks in the assistant's reply join the same bank (AC18)
    const history = await fetchHistory(client, session.oc_session_id);
    const assistantText = [...history]
      .reverse()
      .filter((m) => m.role === 'assistant')
      .map((m) => m.text)
      .join('\n\n');
    for (const spec of extractQuizBlocks(assistantText)) {
      const questions = depositQuiz(db, subject.id, spec, lesson?.id ?? null);
      send('quiz', { questions });
      events.emit(subject.id, 'questions', { subjectId: subject.id, questions });
    }

    chatRepo.sessionAfterTurn(db, session.id);
    const updated = chatRepo.getSession(db, session.id);
    terminate('done', { messageCount: updated?.msg_count ?? session.msg_count + 2 });
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError('INTERNAL', (e as Error).message);
    terminate('error', {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
  }
}

function buildPreamble(
  graphBuilding: boolean,
  lessonPath: string | null,
  summaryPath: string | null,
): string {
  const parts: string[] = [];
  if (graphBuilding) {
    parts.push('The knowledge graph is currently being rebuilt; treat graph data as read-only until it finishes.');
  }
  if (lessonPath) {
    parts.push(`The student is currently reading lesson ${lessonPath}; scope answers to it when relevant.`);
  }
  if (summaryPath) {
    parts.push(
      `Before answering, read ${summaryPath} — it summarizes your previous sessions with this student. Also re-read corrections.md.`,
    );
  }
  return parts.length ? `[Context] ${parts.join(' ')}` : '';
}
