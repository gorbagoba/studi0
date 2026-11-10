import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatSession } from '@studi0/shared';
import { postChatStream } from '../api/sse';
import type { ChatStreamHandlers } from '../api/sse';
import { AppProvider } from '../state/app';

const NOW = '2026-10-31T00:00:00.000Z';

function session(id: string, title: string | null): ChatSession {
  return {
    id,
    subjectId: 's1',
    lessonId: null,
    active: true,
    messageCount: 3,
    summaryPath: null,
    createdAt: NOW,
    lastMessageAt: null,
    title,
  };
}

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getSessions: vi.fn(async () => [session('a', 'Heaps deep-dive'), session('b', null)]),
    createSession: vi.fn(async () => session('c', null)),
    getMessages: vi.fn(async () => []),
    renameChatSession: vi.fn(),
  };
});

vi.mock('../api/sse', () => ({ postChatStream: vi.fn() }));

function renderPanel(props: { subjectId: string; lessonId?: string; showSessions?: boolean }) {
  return render(
    <AppProvider>
      <ChatPanel {...props} />
    </AppProvider>,
  );
}

describe('ChatPanel session-list flow', () => {
  afterEach(cleanup);

  it('subject chats start on the session list — no composer until a chat is entered', async () => {
    renderPanel({ subjectId: 's1', showSessions: true });
    expect(await screen.findByRole('heading', { name: 'Your chats' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Heaps deep-dive')).toBeTruthy());
    expect(screen.queryByRole('textbox', { name: 'Message the teacher' })).toBeNull();
    // entering a chat reveals composer + history
    fireEvent.click(screen.getByText('Heaps deep-dive'));
    expect(await screen.findByRole('textbox', { name: 'Message the teacher' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← All chats' })).toBeTruthy();
  });

  it('lesson chats open straight into the conversation', async () => {
    renderPanel({ subjectId: 's1', lessonId: 'l1' });
    expect(await screen.findByRole('textbox', { name: 'Message the teacher' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your chats' })).toBeNull();
  });
});

describe('ChatPanel preference questions', () => {
  let handlers: ChatStreamHandlers | null = null;
  let releaseStream: (() => void) | null = null;

  const BLOCK =
    '```studi0-questions\n' +
    JSON.stringify({
      questions: [
        { id: 'pace', prompt: 'How long until your exam?', options: ['<1 week', '1-4 weeks', 'Semester+'] },
        { id: 'style', prompt: 'Examples first or theory first?' },
      ],
    }) +
    '\n```';

  beforeEach(() => {
    handlers = null;
    releaseStream = null;
    vi.mocked(postChatStream).mockImplementation((_sessionId, _body, h) => {
      handlers = h;
      return new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(postChatStream).mockReset();
  });

  async function startTurn(): Promise<void> {
    renderPanel({ subjectId: 's1', lessonId: 'l1' });
    const box = await screen.findByRole('textbox', { name: 'Message the teacher' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(handlers).not.toBeNull());
  }

  async function finishTurn(text: string): Promise<void> {
    act(() => handlers!.onToken!(text));
    act(() => handlers!.onDone!({ messageCount: 2 }));
    await act(async () => releaseStream!());
  }

  it('renders the form under the message, gates submit, and sends composed answers', async () => {
    await startTurn();
    await finishTurn('Quick check-in.\n\n' + BLOCK);

    expect(screen.getByText('Quick check-in.')).toBeTruthy();
    expect(screen.queryByText(/studi0-questions/)).toBeNull();
    expect(screen.getByText('How long until your exam?')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '1-4 weeks' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Examples first or theory first?' })).toBeTruthy();

    expect((screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: '1-4 weeks' }));
    expect((screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Examples first or theory first?' }), {
      target: { value: 'Examples first' },
    });
    expect((screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(await screen.findByText('Answers sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    await waitFor(() => expect(vi.mocked(postChatStream).mock.calls.length).toBe(2));
    expect(vi.mocked(postChatStream).mock.calls[1][1].content).toBe(
      'Answers to your questions:\n1. How long until your exam? — 1-4 weeks\n2. Examples first or theory first? — Examples first',
    );
  });

  it('never shows the raw block while streaming', async () => {
    await startTurn();
    act(() => handlers!.onToken!('Before\n```studi0-questions\n{"questions":[{"id":"pace"'));
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.queryByText(/studi0-questions/)).toBeNull();
    act(() => handlers!.onDone!({ messageCount: 1 }));
    await act(async () => releaseStream!());
  });
});

describe('ChatPanel tool activity', () => {
  let handlers: ChatStreamHandlers | null = null;
  let releaseStream: (() => void) | null = null;

  beforeEach(() => {
    handlers = null;
    releaseStream = null;
    // hold the stream open so tests can push tool/token/done events like the server does
    vi.mocked(postChatStream).mockImplementation((_sessionId, _body, h) => {
      handlers = h;
      return new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(postChatStream).mockReset();
  });

  async function startTurn(): Promise<void> {
    renderPanel({ subjectId: 's1', lessonId: 'l1' });
    const box = await screen.findByRole('textbox', { name: 'Message the teacher' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(handlers).not.toBeNull());
  }

  it('shows the friendly tool label before tokens, then the message text', async () => {
    await startTurn();
    act(() => handlers!.onTool!({ name: 'search_material', ok: true }));
    expect(screen.getByText('Searching your course material…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Streaming…' })).toBeTruthy();

    act(() => handlers!.onToken!('Heaps are fun'));
    expect(screen.queryByText('Searching your course material…')).toBeNull();
    expect(screen.getByText('Heaps are fun')).toBeTruthy();

    act(() => handlers!.onDone!({ messageCount: 2 }));
    await act(async () => releaseStream!());
  });

  it('clears the tool label when the turn is done (ok:false reads the same)', async () => {
    await startTurn();
    act(() => handlers!.onTool!({ name: 'write_lesson', ok: false }));
    expect(screen.getByText('Writing the lesson…')).toBeTruthy();

    act(() => handlers!.onDone!({ messageCount: 1 }));
    expect(screen.queryByText('Writing the lesson…')).toBeNull();
    await act(async () => releaseStream!());
  });
});
