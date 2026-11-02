import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from './SessionList';
import type { ChatSession } from '@studi0/shared';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

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
        onDelete={vi.fn()}
        onClean={vi.fn()}
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

  it('renames via the row kebab menu and its dialog', async () => {
    const onRename = vi.fn();
    render(
      <SessionList
        sessions={[session('a', 'Heaps deep-dive')]}
        currentId="a"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        onClean={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Heaps deep-dive options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'My study thread' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'My study thread'),
    );
  });

  it('does not rename when the dialog is cancelled', async () => {
    const onRename = vi.fn();
    render(
      <SessionList
        sessions={[session('a', 'Heaps deep-dive')]}
        currentId="a"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        onClean={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Heaps deep-dive options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
