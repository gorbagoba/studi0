import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatSession } from '@studi0/shared';
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
