import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRow } from '@studi0/shared';
import { FileBrowser } from './FileBrowser';
import * as client from '../api/client';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

const NOW = '2026-10-31T00:00:00.000Z';

const pdf: FileRow = {
  id: 'f1',
  subjectId: 's1',
  origin: 'upload',
  path: 'material/big-deck.pdf',
  dir: 'material',
  name: 'big-deck.pdf',
  ext: '.pdf',
  bytes: 1234,
  mtime: NOW,
};

const lesson = {
  id: 'f2',
  path: 'lessons/intro.html',
  dir: 'lessons',
  name: 'intro.html',
  ext: '.html',
  bytes: 10,
  mtime: NOW,
};

const subjects = [
  {
    id: 's1',
    name: 'QA Subject',
    path: 'C:/t/qa',
    createdAt: NOW,
    lastBuiltAt: null,
    stale: false,
    groupId: null,
    groupName: null,
    icon: null,
  },
  {
    id: 's2',
    name: 'Other Subject',
    path: 'C:/t/other',
    createdAt: NOW,
    lastBuiltAt: null,
    stale: false,
    groupId: null,
    groupName: null,
    icon: null,
  },
];

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getTree: vi.fn(),
    getSubjects: vi.fn(),
    moveFile: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
  };
});

function renderBrowser(onFilesChanged: () => void = () => {}) {
  return render(
    <FileBrowser subjectId="s1" version={0} onOpenLesson={() => {}} onFilesChanged={onFilesChanged} />,
  );
}

beforeEach(() => {
  vi.mocked(client.getSubjects).mockResolvedValue(subjects);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileBrowser context menu', () => {
  it('offers rename/delete/move on material files via kebab and right-click', async () => {
    vi.mocked(client.getTree).mockResolvedValue({ dir: 'material', entries: [pdf] });
    renderBrowser();
    fireEvent.click(await screen.findByRole('button', { name: 'big-deck.pdf options' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Move to subject/ })).toBeTruthy();
    // right-click opens the same menu
    fireEvent.contextMenu(screen.getByText('material/big-deck.pdf'));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('deletes a file after confirming in the dialog and refreshes the list', async () => {
    vi.mocked(client.getTree).mockResolvedValue({ dir: 'material', entries: [pdf] });
    vi.mocked(client.deleteFile).mockResolvedValue({ ok: true });
    const onFilesChanged = vi.fn();
    renderBrowser(onFilesChanged);
    fireEvent.click(await screen.findByRole('button', { name: 'big-deck.pdf options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('material/big-deck.pdf');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteFile).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledOnce());
  });

  it('moves a file to another subject via the submenu', async () => {
    vi.mocked(client.getTree).mockResolvedValue({ dir: 'material', entries: [pdf] });
    vi.mocked(client.moveFile).mockResolvedValue(pdf);
    const onFilesChanged = vi.fn();
    renderBrowser(onFilesChanged);
    fireEvent.click(await screen.findByRole('button', { name: 'big-deck.pdf options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to subject/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other Subject' }));
    await waitFor(() => expect(client.moveFile).toHaveBeenCalledWith('f1', 's2'));
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledOnce());
  });

  it('renames a file via the prompt dialog', async () => {
    vi.mocked(client.getTree).mockResolvedValue({ dir: 'material', entries: [pdf] });
    vi.mocked(client.renameFile).mockResolvedValue({ ...pdf, name: 'deck.pdf', path: 'material/deck.pdf' });
    renderBrowser();
    fireEvent.click(await screen.findByRole('button', { name: 'big-deck.pdf options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'deck.pdf' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(client.renameFile).toHaveBeenCalledWith('f1', 'deck.pdf'));
  });

  it('offers no file menu outside material/', async () => {
    vi.mocked(client.getTree).mockResolvedValue({ dir: 'lessons', entries: [lesson] });
    renderBrowser();
    // switch to the lessons/ tab — the browser always boots on material/
    fireEvent.click(screen.getByRole('button', { name: 'lessons/' }));
    await screen.findByText('lessons/intro.html');
    fireEvent.contextMenu(screen.getByText('lessons/intro.html'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: /options/ })).toBeNull();
    // the existing lessons Open button still works
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });
});
