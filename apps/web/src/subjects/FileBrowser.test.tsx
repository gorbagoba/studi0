import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@studi0/shared';
import { FileBrowser } from './FileBrowser';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOW = '2026-10-31T00:00:00.000Z';
const pdf: FileEntry = {
  path: 'material/big-deck.pdf',
  dir: 'material',
  name: 'big-deck.pdf',
  ext: '.pdf',
  bytes: 1234,
  mtime: NOW,
};
const md: FileEntry = { ...pdf, path: 'material/notes.md', name: 'notes.md', ext: '.md' };

describe('FileBrowser split action', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('/tree')) {
          return Promise.resolve(jsonResponse({ dir: 'material', entries: [pdf, md] }));
        }
        if (url.endsWith('/split-pdf') && init?.method === 'POST')
          return Promise.resolve(
            jsonResponse({ parts: ['material/big-deck_p01.pdf', 'material/big-deck_p02.pdf'] }),
          );
        return Promise.resolve(jsonResponse({}, 500));
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers split only on PDFs, posts the file, lists the parts, and reloads', async () => {
    const onFilesChanged = vi.fn();
    const { rerender } = render(
      <FileBrowser subjectId="s1" version={0} onOpenLesson={() => {}} onFilesChanged={onFilesChanged} />,
    );

    expect(await screen.findByText('material/big-deck.pdf')).toBeTruthy();
    const splitButtons = screen.getAllByRole('button', { name: 'Split into parts' });
    expect(splitButtons).toHaveLength(1); // only the PDF row gets the action

    fireEvent.click(splitButtons[0]!);
    // in-app confirm dialog replaces window.confirm
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('big-deck.pdf');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Split' }));

    expect(await screen.findByText(/Split into 2 parts/)).toBeTruthy();
    expect(screen.getByText(/big-deck_p01\.pdf/)).toBeTruthy();
    expect(onFilesChanged).toHaveBeenCalledOnce();
    // the parent bumps `version` in response — that is what triggers the file-list reload
    rerender(
      <FileBrowser subjectId="s1" version={1} onOpenLesson={() => {}} onFilesChanged={onFilesChanged} />,
    );
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/tree')).length).toBe(2),
    );
    const post = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/split-pdf'));
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      file: 'material/big-deck.pdf',
    });
  });

  it('does nothing when the confirm is dismissed', async () => {
    const onFilesChanged = vi.fn();
    render(
      <FileBrowser subjectId="s1" version={0} onOpenLesson={() => {}} onFilesChanged={onFilesChanged} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Split into parts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/split-pdf'))).toHaveLength(0),
    );
    expect(onFilesChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/big-deck_p01/)).toBeNull();
  });

  it('surfaces split failures as an error banner', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tree'))
        return Promise.resolve(jsonResponse({ dir: 'material', entries: [pdf] }));
      return Promise.resolve(
        jsonResponse({ error: { code: 'INTERNAL', message: 'pypdf missing' } }, 500),
      );
    });
    render(
      <FileBrowser subjectId="s1" version={0} onOpenLesson={() => {}} onFilesChanged={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Split into parts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Split' }));
    expect(await screen.findByText(/pypdf missing/)).toBeTruthy();
    expect(screen.queryByText(/big-deck_p01/)).toBeNull();
  });
});
