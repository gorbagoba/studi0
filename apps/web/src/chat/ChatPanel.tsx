import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { ChatMessage, ChatSession, ID } from '@studi0/shared';
import { ApiError, createSession, displayError, getMessages, getSessions, renameChatSession } from '../api/client';
import { postChatStream } from '../api/sse';
import { CitationText } from '../lesson/CitationText';
import { ErrorBanner } from '../components/ErrorBanner';
import { useApp } from '../state/app';
import { SessionList } from './SessionList';

type LogItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'note'; text: string; lessonPath?: string };

export function ChatPanel({
  subjectId,
  lessonId,
  showSessions = false,
  onLessonSaved,
}: {
  subjectId: ID;
  lessonId?: ID;
  showSessions?: boolean;
  onLessonSaved?: () => void;
}) {
  const { openLesson } = useApp();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [log, setLog] = useState<LogItem[]>([]);
  const [streamText, setStreamText] = useState<string | null>(null);
  const streamRef = useRef('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  // subject-level chats start on the session list; entering one reveals the conversation
  const [entered, setEntered] = useState(false);
  const streaming = streamText !== null;

  async function openSession(s: ChatSession): Promise<void> {
    setEntered(true);
    setSession(s);
    setError(null);
    try {
      const history = await getMessages(s.id);
      setLog(history.map((m) => ({ kind: 'message', message: m })));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SESSION_GONE') {
        // opencode lost the session — start a fresh one transparently
        const fresh = await createSession(subjectId, lessonId !== undefined ? { lessonId } : {});
        setSession(fresh);
        setLog([]);
      } else {
        setError(displayError(e));
      }
    }
  }

  // Bootstrap: lesson-scoped chats open straight into the conversation; subject-level
  // chats show the session list first and only open a chat when the user enters one.
  useEffect(() => {
    let stopped = false;
    setBooting(true);
    setLog([]);
    setSession(null);
    setStreamText(null);
    setError(null);
    setEntered(lessonId === undefined && showSessions);
    void (async () => {
      try {
        if (lessonId === undefined && showSessions) {
          const all = await getSessions(subjectId);
          if (stopped) return;
          setSessions(all);
          return;
        }
        const all = await getSessions(subjectId);
        if (stopped) return;
        setSessions(all);
        const match = all.find((s) => s.active && (lessonId !== undefined ? s.lessonId === lessonId : s.lessonId === null));
        const s = match ?? (await createSession(subjectId, lessonId !== undefined ? { lessonId } : {}));
        if (stopped) return;
        await openSession(s);
      } catch (e) {
        if (!stopped) setError(displayError(e));
      } finally {
        if (!stopped) setBooting(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [subjectId, lessonId]);

  async function renameChat(s: ChatSession, title: string): Promise<void> {
    setError(null);
    try {
      const fresh = await renameChatSession(s.id, title);
      setSessions((all) => all.map((x) => (x.id === fresh.id ? fresh : x)));
      setSession((cur) => (cur?.id === fresh.id ? fresh : cur));
    } catch (e) {
      setError(displayError(e));
    }
  }

  async function newChat(): Promise<void> {
    setError(null);
    try {
      const s = await createSession(subjectId, lessonId !== undefined ? { lessonId } : {});
      setSessions((all) => [s, ...all]);
      await openSession(s);
    } catch (e) {
      setError(displayError(e));
    }
  }

  async function send(draftOverride?: string): Promise<void> {
    const content = (draftOverride ?? draft).trim();
    if (session === null || streaming || content === '') return;
    setDraft('');
    setLog((l) => [
      ...l,
      {
        kind: 'message',
        message: {
          id: `local-u-${Date.now()}`,
          role: 'user',
          text: content,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    streamRef.current = '';
    setStreamText('');
    try {
      await postChatStream(
        session.id,
        { content, ...(lessonId !== undefined ? { lessonId } : {}) },
        {
          onToken: (t) => {
            streamRef.current += t;
            setStreamText(streamRef.current);
          },
          onLesson: (l) => {
            setLog((lg) => [...lg, { kind: 'note', text: `Teacher wrote a lesson: ${l.title}`, lessonPath: l.path }]);
            onLessonSaved?.();
          },
          onQuiz: (q) =>
            setLog((lg) => [
              ...lg,
              { kind: 'note', text: `${q.questions.length} practice question(s) added to the bank.` },
            ]),
          onRotated: (r) => {
            setSession((s) =>
              s !== null ? { ...s, id: r.newSessionId, summaryPath: r.summaryPath } : s,
            );
            setLog((lg) => [
              ...lg,
              { kind: 'note', text: 'Chat auto-rotated — a summary was saved to learning-records; the conversation continues fresh.' },
            ]);
          },
          onError: (err) => setError(`${err.code}: ${err.message}`),
        },
      );
    } catch (e) {
      setError(displayError(e));
    }
    const finalText = streamRef.current;
    setStreamText(null);
    if (finalText.trim() !== '') {
      setLog((l) => [
        ...l,
        {
          kind: 'message',
          message: {
            id: `local-a-${Date.now()}`,
            role: 'assistant',
            text: finalText,
            createdAt: new Date().toISOString(),
          },
        },
      ]);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const listing = showSessions && !entered;

  return (
    <section className="chat" aria-label={lessonId !== undefined ? 'Lesson chat' : 'Subject chat'}>
      <div className="chat-head">
        {showSessions && entered && (
          <button type="button" className="btn btn-small" onClick={() => setEntered(false)}>
            ← All chats
          </button>
        )}
        <h3>
          {listing
            ? 'Your chats'
            : lessonId !== undefined
              ? 'Ask about this lesson'
              : session?.title ?? 'Ask the teacher'}
        </h3>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {listing ? (
        booting ? (
          <p className="muted" role="status">
            Loading chats…
          </p>
        ) : (
          <SessionList
            sessions={sessions}
            currentId={session?.id ?? null}
            onSelect={(s) => void openSession(s)}
            onNew={() => void newChat()}
            onRename={(s, t) => void renameChat(s, t)}
          />
        )
      ) : booting ? (
        <p className="muted" role="status">
          Connecting to the teacher…
        </p>
      ) : session === null ? (
        <p className="muted">
          No chat session available.{' '}
          <button className="btn" onClick={() => void newChat()}>
            Start a new chat
          </button>
        </p>
      ) : (
        <>
          <div className="chat-log" aria-live="polite">
            {log.length === 0 && !streaming && (
              <p className="muted">No messages yet — ask anything about this subject.</p>
            )}
            {log.map((item, i) =>
              item.kind === 'message' ? (
                <article key={i} className={`msg msg-${item.message.role}`}>
                  <span className="msg-role">{item.message.role === 'user' ? 'You' : 'Teacher'}</span>
                  <div className="msg-text">
                    <CitationText text={item.message.text} />
                  </div>
                </article>
              ) : (
                <p key={i} className="msg-note">
                  {item.text}{' '}
                  {item.lessonPath !== undefined && (
                    <button className="btn btn-small" onClick={() => openLesson(item.lessonPath as string)}>
                      Open lesson
                    </button>
                  )}
                </p>
              ),
            )}
            {streaming && (
              <article className="msg msg-assistant">
                <span className="msg-role">Teacher</span>
                <div className="msg-text">
                  {streamText === '' ? (
                    <span className="thinking" aria-label="Teacher is thinking">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  ) : (
                    <CitationText text={streamText ?? ''} />
                  )}
                </div>
              </article>
            )}
          </div>
          <form className="composer" onSubmit={onSubmit}>
            <textarea
              aria-label="Message the teacher"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={lessonId !== undefined ? 'Ask about this lesson…' : 'Ask the teacher…'}
              rows={3}
            />
            <div className="composer-side">
              <button
                type="button"
                className="btn btn-small setup-chip"
                disabled={streaming}
                title="Interview: goals, exam, weak areas — writes MISSION.md"
                onClick={() =>
                  void send(
                    'Start the course setup interview. Ask me every onboarding question in ONE message as a numbered list — I will answer them all in one batch.',
                  )
                }
              >
                Course setup
              </button>
              <button type="submit" className="btn-primary" disabled={streaming || draft.trim() === ''}>
                {streaming ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </form>
          <p className="muted composer-hint">Enter sends · Shift+Enter adds a newline</p>
        </>
      )}
    </section>
  );
}
