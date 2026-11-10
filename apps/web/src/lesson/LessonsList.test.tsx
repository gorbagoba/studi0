import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LessonsList } from './LessonsList';
import { AppProvider } from '../state/app';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

const NOW = '2026-11-01T00:00:00.000Z';

const lessons = [
  { id: 'l1', subjectId: 's1', path: 'lessons/a.html', title: 'Alpha', nodeTags: [], createdAt: NOW, updatedAt: NOW, reviewedAt: null },
  { id: 'l2', subjectId: 's1', path: 'lessons/b.html', title: 'Beta', nodeTags: [], createdAt: NOW, updatedAt: NOW, reviewedAt: null },
];

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getLessons: vi.fn(async () => lessons),
    renameLesson: vi.fn(async () => lessons[0]),
    deleteLesson: vi.fn(async () => ({ ok: true })),
  };
});

function renderList() {
  render(
    <AppProvider>
      <LessonsList subjectId="s1" version={0} />
    </AppProvider>,
  );
}

describe('LessonsList', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('right-clicking a lesson row opens the options menu', async () => {
    renderList();

    const row = (await screen.findByText('Alpha')).closest('button');
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('renames a lesson from the options menu and refreshes the list', async () => {
    const { renameLesson, getLessons } = await import('../api/client');
    renderList();

    const row = (await screen.findByText('Alpha')).closest('button');
    fireEvent.contextMenu(row!);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Alpha');
    fireEvent.change(input, { target: { value: 'Alpha revised' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(renameLesson).toHaveBeenCalledWith('l1', 'Alpha revised'));
    // initial fetch + reload after the rename
    await waitFor(() => expect(getLessons).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes a lesson after confirming and refreshes the list', async () => {
    const { deleteLesson, getLessons } = await import('../api/client');
    renderList();

    const row = (await screen.findByText('Alpha')).closest('button');
    fireEvent.contextMenu(row!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/removed permanently/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLesson).toHaveBeenCalledWith('l1'));
    // initial fetch + reload after the delete
    await waitFor(() => expect(getLessons).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
