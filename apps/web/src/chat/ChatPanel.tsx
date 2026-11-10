import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { ChatMessage, ChatSession, ID } from '@studi0/shared';
import { ApiError, cleanChatSessions, createSession, deleteChatSession, displayError, getMessages, getSessions, renameChatSession } from '../api/client';
import { postChatStream } from '../api/sse';
import { CitationText } from '../lesson/CitationText';
import { ErrorBanner } from '../components/ErrorBanner';
import { useApp } from '../state/app';
import { SessionList } from './SessionList';
import { extractQuestions, QUESTIONS_FENCE } from './questions';
import type { QuestionsBlock } from './questions';

type LogItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'note'; text: string; lessonPath?: string };

// Waiting should read like the teacher, not like a tool log.
const TOOL_LABELS: Record<string, string> = {
  search_material: 'Searching your course material…',
  read_material: 'Reading the material…',
  grep_material: 'Looking up exact terms…',
  graphify_query: 'Consulting the knowledge graph…',
  write_lesson: 'Writing the lesson…',
  save_quiz: 'Saving practice questions…',
  update_corrections: 'Noting that for later…',
};

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
  const [tool, setTool] = useState<string | null>(null);
  const streamRef = useRef('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // answers are keyed by message id so each question form keeps its own state
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [sentAnswers, setSentAnswers] = useState<Record<string, boolean>>({});
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
        // opencode lost the session — go sessionless; the next send starts fresh lazily
        setSession(null);
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
    // lesson chats open straight into the conversation; subject chats show the list first
    setEntered(lessonId !== undefined);
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
        if (match) await openSession(match);
        // no match: stay sessionless — the first message creates the session lazily
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

  async function deleteChat(s: ChatSession): Promise<void> {
    setError(null);
    try {
      await deleteChatSession(s.id);
      setSessions((all) => all.filter((x) => x.id !== s.id));
      if (session?.id === s.id) setEntered(false);
    } catch (e) {
      setError(displayError(e));
    }
  }

  async function cleanChats(): Promise<void> {
    setError(null);
    try {
      const { removed } = await cleanChatSessions(subjectId);
      if (removed > 0) setSessions((all) => all.filter((x) => x.messageCount !== 0));
      if (session !== null && session.messageCount === 0) setEntered(false);
    } catch (e) {
      setError(displayError(e));
    }
  }

  async function newChat(): Promise<void> {
    // lazy: entering a blank chat creates nothing — the session is created on first send
    setError(null);
    setSession(null);
    setLog([]);
    setEntered(true);
  }

  async function send(draftOverride?: string): Promise<void> {
    const content = (draftOverride ?? draft).trim();
    if (streaming || content === '') return;
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
    setTool(null);
    try {
      // lazy session creation: the first message of a chat mints the session
      let target: ChatSession | null = session;
      if (target === null) {
        const created = await createSession(subjectId, lessonId !== undefined ? { lessonId } : {});
        target = created;
        setSessions((all) => (all.some((x) => x.id === created.id) ? all : [created, ...all]));
        setSession(created);
      }
      await postChatStream(
        target.id,
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
          onTool: ({ name }) => setTool(name), // ok:false keeps the same label — the agent recovers
          onDone: () => setTool(null),
          onError: (err) => {
            setTool(null);
            setError(`${err.code}: ${err.message}`);
          },
        },
      );
    } catch (e) {
      setError(displayError(e));
    }
    const finalText = streamRef.current;
    setStreamText(null);
    setTool(null);
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

  function answerFor(messageId: string, questionId: string): string {
    return answers[messageId]?.[questionId] ?? '';
  }

  function setAnswer(messageId: string, questionId: string, value: string): void {
    setAnswers((all) => ({ ...all, [messageId]: { ...all[messageId], [questionId]: value } }));
  }

  async function answerQuestions(messageId: string, block: QuestionsBlock): Promise<void> {
    const lines = block.questions.map((q, i) => `${i + 1}. ${q.prompt} — ${answerFor(messageId, q.id)}`);
    setSentAnswers((all) => ({ ...all, [messageId]: true }));
    await send(`Answers to your questions:\n${lines.join('\n')}`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const listing = showSessions && !entered;
  // never flash a half-streamed questions block: hide everything from the fence marker on
  const streamDisplay = (streamText ?? '').split(QUESTIONS_FENCE)[0] ?? '';

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
            onDelete={(s) => void deleteChat(s)}
            onClean={() => void cleanChats()}
          />
        )
      ) : booting ? (
        <p className="muted" role="status">
          Connecting to the teacher…
        </p>
      ) : session === null ? (
        // lazy: a sessionless chat is ready for its first message — sending mints it
        <>
          <div className="chat-log" aria-live="polite">
            <p className="muted">No messages yet — your first message starts this chat.</p>
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
              {lessonId === undefined && (
                <button type="button" className="btn btn-small" onClick={() => void send('Start the course setup interview. Ask me every onboarding question in ONE message as a numbered list — I will answer them all in one batch.')}>
                  Course setup
                </button>
              )}
              <button type="submit" className="btn-primary" disabled={draft.trim() === ''}>
                Send
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <div className="chat-log" aria-live="polite">
            {log.length === 0 && !streaming && (
              <p className="muted">No messages yet — ask anything about this subject.</p>
            )}
            {log.map((item, i) => {
              if (item.kind !== 'message') {
                return (
                  <p key={i} className="msg-note">
                    {item.text}{' '}
                    {item.lessonPath !== undefined && (
                      <button className="btn btn-small" onClick={() => openLesson(item.lessonPath as string)}>
                        Open lesson
                      </button>
                    )}
                  </p>
                );
              }
              const extracted =
                item.message.role === 'assistant' ? extractQuestions(item.message.text) : null;
              const questions = extracted?.questions ?? null;
              const answersFor = answers[item.message.id] ?? {};
              const complete =
                questions !== null &&
                questions.questions.every((q) => (answersFor[q.id] ?? '').trim() !== '');
              return (
                <article key={i} className={`msg msg-${item.message.role}`}>
                  <span className="msg-role">{item.message.role === 'user' ? 'You' : 'Teacher'}</span>
                  <div className="msg-text">
                    <CitationText text={extracted?.visibleText ?? item.message.text} />
                  </div>
                  {questions !== null &&
                    (sentAnswers[item.message.id] === true ? (
                      <p className="msg-note">Answers sent</p>
                    ) : (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (complete) void answerQuestions(item.message.id, questions);
                        }}
                      >
                        {questions.questions.map((q) => (
                          <fieldset key={q.id}>
                            <legend>{q.prompt}</legend>
                            {q.options !== undefined && q.options.length > 0 ? (
                              q.options.map((option, oi) => {
                                const id = `${item.message.id}-${q.id}-${oi}`;
                                return (
                                  <div key={oi} className="radio-row">
                                    <input
                                      type="radio"
                                      id={id}
                                      name={`${item.message.id}-${q.id}`}
                                      value={option}
                                      checked={answersFor[q.id] === option}
                                      onChange={() => setAnswer(item.message.id, q.id, option)}
                                      disabled={streaming}
                                    />
                                    <label htmlFor={id}>{option}</label>
                                  </div>
                                );
                              })
                            ) : (
                              <input
                                aria-label={q.prompt}
                                value={answersFor[q.id] ?? ''}
                                onChange={(e) => setAnswer(item.message.id, q.id, e.target.value)}
                                disabled={streaming}
                              />
                            )}
                          </fieldset>
                        ))}
                        <div className="btn-row">
                          <button type="submit" className="btn-primary" disabled={!complete || streaming}>
                            Send answers
                          </button>
                        </div>
                      </form>
                    ))}
                </article>
              );
            })}
            {streaming && (
              <article className="msg msg-assistant">
                <span className="msg-role">Teacher</span>
                <div className="msg-text">
                  {streamText === '' || streamDisplay === '' ? (
                    <span className="thinking" aria-label={tool === null ? 'Teacher is thinking' : undefined}>
                      {tool !== null && (
                        <span className="thinking-label">{TOOL_LABELS[tool] ?? 'Working…'}</span>
                      )}
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  ) : (
                    <CitationText text={streamDisplay} />
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
