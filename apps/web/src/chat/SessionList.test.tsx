import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from './SessionList';
import type { ChatSession } from '@studi0/shared';

const NOW = '2026-10-31T00:00:00.000Z';

function session(id: string, title: string | null): ChatSession {
  return {
    id,
    subjectId: 'sub1',
    lessonId: null,
    active: true,
    messageCount: 3,
    summaryPath: null,
    createdAt: NOW,
    lastMessageAt: null,
    title,
  };
}

describe('SessionList (vertical list)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders every session as a list row, active one highlighted, click enters the chat', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[session('a', 'Heaps deep-dive'), session('b', null)]}
        currentId="b"
        onSelect={onSelect}
        onNew={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const heaps = screen.getByText('Heaps deep-dive').closest('button') as HTMLButtonElement;
    const fallback = screen
      .getByText((c) => c.startsWith('Chat —'))
      .closest('button') as HTMLButtonElement;
    expect(fallback.className).toContain('active');
    expect(heaps.className).not.toContain('active');
    expect(heaps.className).not.toContain('active');
    fireEvent.click(heaps);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('renames via the row kebab menu', async () => {
    const onRename = vi.fn();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('My study thread');
    render(
      <SessionList
        sessions={[session('a', 'Heaps deep-dive')]}
        currentId="a"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Heaps deep-dive options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'My study thread'),
    );
    expect(promptSpy).toHaveBeenCalled();
  });

  it('does not rename when the prompt is cancelled', async () => {
    const onRename = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(
      <SessionList
        sessions={[session('a', 'Heaps deep-dive')]}
        currentId="a"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Heaps deep-dive options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(onRename).not.toHaveBeenCalled();
  });
});
