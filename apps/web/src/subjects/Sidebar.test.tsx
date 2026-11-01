import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import * as client from '../api/client';
import { AppProvider } from '../state/app';

const NOW = '2026-10-31T00:00:00.000Z';

const subjects = [
  {
    id: 's1',
    name: 'Linear Algebra',
    path: 'C:/t/la',
    createdAt: NOW,
    lastBuiltAt: null,
    stale: false,
    groupId: 'g1',
    groupName: 'MATH',
    icon: null,
  },
  {
    id: 's2',
    name: 'DB Systems',
    path: 'C:/t/db',
    createdAt: NOW,
    lastBuiltAt: null,
    stale: false,
    groupId: null,
    groupName: null,
    icon: null,
  },
];

const groups = [{ id: 'g1', name: 'MATH', subjectCount: 1, createdAt: NOW }];

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getSubjects: vi.fn(),
    getGroups: vi.fn(),
    renameSubject: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    mergeSubject: vi.fn(),
    deleteSubjectFiles: vi.fn(),
  };
});

function renderSidebar() {
  return render(
    <AppProvider>
      <Sidebar />
    </AppProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(client.getSubjects).mockResolvedValue(subjects);
  vi.mocked(client.getGroups).mockResolvedValue(groups);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Sidebar groups and menus', () => {
  it('renders groups as collapsible sections with nested subjects, ungrouped below', async () => {
    renderSidebar();
    expect(await screen.findByText('MATH')).toBeTruthy();
    const nested = screen.getByRole('button', { name: 'Linear Algebra' });
    expect(nested.closest('section')?.textContent).toContain('MATH');
    // ungrouped subjects sit under no group header
    expect(screen.getByRole('button', { name: 'DB Systems' }).closest('section')).toBeNull();
  });

  it('collapses a group and persists the state', async () => {
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse group MATH' }));
    expect(screen.queryByRole('button', { name: /Linear Algebra/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand group MATH' })).toBeTruthy();
    expect(localStorage.getItem('studi0.collapsed-groups')).toContain('g1');
  });

  it('moves a subject to a group (and back to "No group") from the menu', async () => {
    vi.mocked(client.renameSubject).mockResolvedValue(subjects[1]);
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'DB Systems options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to group/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'MATH' }));
    await waitFor(() =>
      expect(client.renameSubject).toHaveBeenCalledWith('s2', { groupId: 'g1' }),
    );
  });

  it('creates a group from the inline input', async () => {
    vi.mocked(client.createGroup).mockResolvedValue({
      id: 'g2',
      name: 'CS',
      subjectCount: 0,
      createdAt: NOW,
    });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }));
    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'CS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(client.createGroup).toHaveBeenCalledWith('CS'));
  });

  it('warns that deleting a group ungroups its subjects', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(client.deleteGroup).mockResolvedValue({ ok: true });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'MATH options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 subject becomes ungrouped'),
    );
    await waitFor(() => expect(client.deleteGroup).toHaveBeenCalledWith('g1'));
  });

  it('drag-and-drops an ungrouped subject onto a group header to move it', async () => {
    vi.mocked(client.renameSubject).mockResolvedValue({} as never);
    renderSidebar();
    const row = await screen.findByRole('button', { name: 'DB Systems' });
    fireEvent.dragStart(row);
    const header = screen.getByText('MATH').closest('.group-header') as HTMLElement;
    fireEvent.dragOver(header);
    expect(header.className).toContain('drag-over');
    fireEvent.drop(header);
    await waitFor(() =>
      expect(client.renameSubject).toHaveBeenCalledWith('s2', { groupId: 'g1' }),
    );
  });

  it('drop on the sidebar background ungroups a subject', async () => {
    vi.mocked(client.renameSubject).mockResolvedValue({} as never);
    renderSidebar();
    const row = await screen.findByRole('button', { name: 'Linear Algebra' });
    fireEvent.dragStart(row);
    const nav = screen.getByRole('navigation', { name: 'Subjects' });
    fireEvent.dragOver(nav);
    fireEvent.drop(nav);
    await waitFor(() =>
      expect(client.renameSubject).toHaveBeenCalledWith('s1', { groupId: null }),
    );
  });

  it('requires typing the subject name exactly to delete its files from disk', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('linear algebra');
    vi.mocked(client.deleteSubjectFiles).mockResolvedValue({ ok: true });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete files from disk' }));
    expect(client.deleteSubjectFiles).not.toHaveBeenCalled();

    promptSpy.mockReturnValue('Linear Algebra');
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete files from disk' }));
    await waitFor(() => expect(client.deleteSubjectFiles).toHaveBeenCalledWith('s1', { confirm: 'Linear Algebra' }));
  });

  it('shows the moved/skipped report after a merge', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(client.mergeSubject).mockResolvedValue({ moved: ['a.pdf'], skipped: ['b.pdf'] });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Merge into subject/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DB Systems' }));
    expect(await screen.findByText(/Merged 1 file into "DB Systems"/)).toBeTruthy();
    expect(screen.getByText(/b\.pdf/)).toBeTruthy();
  });

  it('opens the same menu on right-click', async () => {
    renderSidebar();
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'DB Systems' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete files from disk' })).toBeTruthy();
  });
});
