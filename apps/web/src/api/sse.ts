import type {
  ApiErrorPayload,
  ChatStreamQuiz,
  ID,
  Job,
  Lesson,
  SendMessageRequest,
  SubjectQuestionsEvent,
} from '@studi0/shared';
import { toApiError } from './client';

// ---- subject events (GET, EventSource) ----

/** Runner build-log line pushed on the subject event stream (`log` event). */
interface SubjectLogEvent {
  line: string;
  at: string;
}

export interface SubjectEventHandlers {
  onJob?: (job: Job) => void;
  onLesson?: (lesson: Lesson) => void;
  onQuestions?: (payload: SubjectQuestionsEvent) => void;
  onLog?: (event: SubjectLogEvent) => void;
}

/** Opens the subject SSE stream; returns a cleanup that closes it. */
export function openSubjectEvents(subjectId: ID, handlers: SubjectEventHandlers): () => void {
  const es = new EventSource(`/api/subjects/${subjectId}/events`);
  es.addEventListener('job', (e) => handlers.onJob?.(JSON.parse((e as MessageEvent).data) as Job));
  es.addEventListener('lesson', (e) =>
    handlers.onLesson?.(JSON.parse((e as MessageEvent).data) as Lesson),
  );
  es.addEventListener('questions', (e) =>
    handlers.onQuestions?.(JSON.parse((e as MessageEvent).data) as SubjectQuestionsEvent),
  );
  es.addEventListener('log', (e) =>
    handlers.onLog?.(JSON.parse((e as MessageEvent).data) as SubjectLogEvent),
  );
  return () => es.close();
}

// ---- chat stream (POST, fetch-based SSE reader — EventSource cannot POST) ----

export interface ChatStreamHandlers {
  onToken?: (text: string) => void;
  onLesson?: (lesson: Lesson) => void;
  onQuiz?: (payload: ChatStreamQuiz) => void;
  onRotated?: (payload: { newSessionId: ID; summaryPath: string }) => void;
  onDone?: (payload: { messageCount: number }) => void;
  onError?: (err: ApiErrorPayload['error']) => void;
}

/** Parses one SSE frame ("event: <name>\ndata: <json>"). Returns null for comments/empty frames. */
export function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(':')) continue; // heartbeat comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (event === 'message' && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// opencode step markers (§N§) are protocol artifacts, not content. The server
// strips them per delta (chatStream.ts), but a marker split across two deltas
// can leak a fragment — the web filters too, so markers never reach the chat DOM.
// shortcut: a marker split across two token frames leaks its fragment — rare, cosmetic
export function stripStepMarkers(text: string): string {
  return text.replace(/\u00A7\d+\u00A7\s?/g, '');
}

export async function postChatStream(
  sessionId: ID,
  body: SendMessageRequest,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res); // pre-stream JSON error
  if (!res.body) throw new Error('Chat stream ended without a body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (frame: string): void => {
    const parsed = parseSseFrame(frame);
    if (parsed === null || parsed.data === '') return;
    let data: unknown;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return; // malformed frame — skip rather than kill the stream
    }
    switch (parsed.event) {
      case 'token':
        handlers.onToken?.(stripStepMarkers((data as { text: string }).text));
        break;
      case 'lesson':
        handlers.onLesson?.(data as Lesson);
        break;
      case 'quiz':
        handlers.onQuiz?.(data as ChatStreamQuiz);
        break;
      case 'rotated':
        handlers.onRotated?.(data as { newSessionId: ID; summaryPath: string });
        break;
      case 'done':
        handlers.onDone?.(data as { messageCount: number });
        break;
      case 'error':
        handlers.onError?.((data as ApiErrorPayload).error);
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      dispatch(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
    }
  }
  const tail = decoder.decode();
  if (tail !== '') buffer += tail;
  if (buffer.trim() !== '') dispatch(buffer);
}
