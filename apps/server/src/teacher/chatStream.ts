import * as chatRepo from '../db/repos/chat.js';
import * as jobsRepo from '../db/repos/jobs.js';
import * as lessonsRepo from '../db/repos/lessons.js';
import { maybeRotate, fetchHistory } from './sessions.js';
import { stripStepMarkers } from '../pipeline/parse.js';
import { detectAndIndexLessons, snapshotLessons } from './lessons.js';
import { extractQuizBlocks, depositQuiz } from './quizScan.js';
import { runNativeTurn, buildPreamble, TURN_TIMEOUT_MS, type NativeTurnDeps } from './engine.js';
import type { Send } from '../http/sse.js';
import type { OcClient } from './sdk.js';
import type { OneshotFn } from '../util/oneshot.js';
import type { ChatSessionRow } from '../db/repos/chat.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import { HttpError } from '../util/errors.js';

export interface StreamTurnDeps extends NativeTurnDeps {
  client: OcClient;
  oneshot: OneshotFn;
}

/**
 * One chat turn: rotation check → context preamble → engine (native LLM loop or
 * opencode SDK pump) → SSE token deltas → lesson/quiz detection → `done`.
 * Exactly one terminal event.
 */
export async function streamTurn(
  deps: StreamTurnDeps,
  subject: SubjectRow,
  startSession: ChatSessionRow,
  content: string,
  lessonIdOverride: string | null,
  send: Send,
): Promise<void> {
  const { db, cfg, events, client, oneshot, feedQuestions } = deps;
  let session = startSession;
  let terminalSent = false;

  const terminate = (event: 'done' | 'error', data: unknown) => {
    if (terminalSent) return;
    terminalSent = true;
    send(event, data);
  };

  try {
    // rotation check first (AC16): continue transparently in a fresh session
    // (native sessions keep their transcript in chat_messages, not opencode)
    const rotation = await maybeRotate(
      client,
      oneshot,
      db,
      subject,
      session,
      cfg.chatEngine === 'native' ? () => Promise.resolve(chatRepo.listMessages(db, session.id)) : undefined,
    );
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

    let lastAssistantText: string;
    if (cfg.chatEngine === 'native') {
      lastAssistantText = await runNativeTurn(
        deps,
        subject,
        session,
        content,
        preamble,
        lesson,
        before,
        send,
      );
    } else {
      lastAssistantText = await runOpencodeTurn(deps, session, content, preamble, send);
    }

    // index lessons written during the turn (native write_lesson already synced
    // `before`, so this is a no-cost safety net there)
    const lessonRows = await detectAndIndexLessons(db, subject, before, events);
    for (const row of lessonRows) {
      send('lesson', lessonsRepo.lessonToDto(row));
      feedQuestions(subject, row);
    }

    // quiz blocks in the latest assistant reply only — scanning the whole
    // history would re-deposit older ```studi0-quiz``` blocks every turn (AC18)
    for (const spec of extractQuizBlocks(lastAssistantText)) {
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

/** The opencode SDK path: event pump → prompt → await execution outcome. */
async function runOpencodeTurn(
  deps: StreamTurnDeps,
  session: ChatSessionRow,
  content: string,
  preamble: string,
  send: Send,
): Promise<string> {
  const { client } = deps;

  let resolveIdle!: (v: 'idle' | 'failed') => void;
  const idle = new Promise<'idle' | 'failed'>((res) => {
    resolveIdle = res;
  });

  const pump = (async () => {
    // opencode 2.2.1 emits no session.idle: the turn lifecycle is
    // execution.started → execution.succeeded/failed (probed live)
    const stream = client.event.subscribe({
      types: [
        'session.text.delta',
        'session.execution.succeeded',
        'session.execution.failed',
        'permission.asked',
      ],
    });
    for await (const event of stream) {
      if (event.type === 'session.text.delta' && event.data.sessionID === session.oc_session_id) {
        // opencode step markers (§N§) are not content — strip before emitting
        const text = stripStepMarkers(event.data.delta);
        if (text) send('token', { text });
      } else if (
        event.type === 'session.execution.succeeded' &&
        event.data.sessionID === session.oc_session_id
      ) {
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

  const history = await fetchHistory(client, session.oc_session_id);
  return [...history].reverse().find((m) => m.role === 'assistant')?.text ?? '';
}
