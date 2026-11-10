import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import * as client from '../api/client';
import { AppProvider } from '../state/app';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

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
    getAgentStatus: vi.fn(),
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
  vi.mocked(client.getAgentStatus).mockResolvedValue({ busy: false, task: null, jobs: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    vi.mocked(client.deleteGroup).mockResolvedValue({ ok: true });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'MATH options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    // in-app confirm dialog replaces window.confirm
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 subject becomes ungrouped');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
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
    vi.mocked(client.deleteSubjectFiles).mockResolvedValue({ ok: true });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete files from disk' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(
      'This is irreversible. Type the subject name to confirm:',
    );
    const submit = screen.getByRole('button', { name: 'Delete files' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'linear algebra' } });
    expect(submit.disabled).toBe(true);
    expect(client.deleteSubjectFiles).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Linear Algebra' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.deleteSubjectFiles).toHaveBeenCalledWith('s1', { confirm: 'Linear Algebra' }),
    );
  });

  it('renames a subject from an in-app prompt dialog', async () => {
    vi.mocked(client.renameSubject).mockResolvedValue({ ...subjects[0], name: 'LinAlg' });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('New name');
    const submit = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // unchanged name
    fireEvent.change(input, { target: { value: 'LinAlg' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.renameSubject).toHaveBeenCalledWith('s1', { name: 'LinAlg' }),
    );
  });

  it('shows the moved/skipped report after a merge', async () => {
    vi.mocked(client.mergeSubject).mockResolvedValue({ moved: ['a.pdf'], skipped: ['b.pdf'] });
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear Algebra options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Merge into subject/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DB Systems' }));
    // the merge asks in an in-app dialog before moving files
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'DB Systems' }));
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

describe('Sidebar agent status', () => {
  it('shows "Agent idle" with a dim dot and an empty panel', async () => {
    renderSidebar();
    const btn = await screen.findByRole('button', { name: 'Agent idle' });
    expect(btn.querySelector('.agent-dot')?.className).not.toContain('busy');
    fireEvent.click(btn);
    expect(screen.getByText('No active jobs')).toBeTruthy();
  });

  it('shows the working label and task/job rows when busy', async () => {
    vi.mocked(client.getAgentStatus).mockResolvedValue({
      busy: true,
      task: { kind: 'lesson-generation', subjectId: 's1', subjectName: 'Linear Algebra', startedAt: NOW },
      jobs: [{ id: 'j1', kind: 'build', subject: 'DB Systems', status: 'running', done: 2, total: 5 }],
    });
    renderSidebar();
    const btn = await screen.findByRole('button', { name: 'Working: Linear Algebra' });
    expect(btn.querySelector('.agent-dot')?.className).toContain('busy');
    fireEvent.click(btn);
    expect(screen.getByText(/Writing lessons — Linear Algebra/)).toBeTruthy();
    expect(screen.getByText(/Graph build — DB Systems: running/)).toBeTruthy();
    expect(screen.getByText(/2\/5/)).toBeTruthy();
  });

  it('treats an in-flight chat turn (activity row, no task) as working', async () => {
    vi.mocked(client.getAgentStatus).mockResolvedValue({
      busy: false,
      task: null,
      jobs: [
        { id: 'a1', kind: 'chat', subjectName: 'Linear Algebra', startedAt: NOW },
        { id: 'a2', kind: 'lesson-generation', subjectName: 'DB Systems', startedAt: NOW },
      ],
    });
    renderSidebar();
    const btn = await screen.findByRole('button', { name: 'Working: Linear Algebra' });
    expect(btn.querySelector('.agent-dot')?.className).toContain('busy');
    fireEvent.click(btn);
    expect(screen.getByText(/Teacher turn — Linear Algebra/)).toBeTruthy();
    expect(screen.getByText(/Writing lessons — DB Systems/)).toBeTruthy();
  });

  it('shows "Finished" after a busy→idle transition, then returns to "Agent idle"', async () => {
    vi.useFakeTimers();
    vi.mocked(client.getAgentStatus)
      .mockResolvedValueOnce({
        busy: true,
        task: null,
        jobs: [{ id: 'a1', kind: 'chat', subjectName: 'Linear Algebra', startedAt: NOW }],
      })
      .mockResolvedValue({ busy: false, task: null, jobs: [] });
    renderSidebar();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Working: Linear Algebra' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const done = screen.getByRole('button', { name: 'Finished' });
    expect(done.querySelector('.agent-dot')?.className).toContain('done');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('button', { name: 'Agent idle' })).toBeTruthy();
  });

  it('does not show "Finished" on a cold idle start', async () => {
    vi.useFakeTimers();
    renderSidebar();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Agent idle' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole('button', { name: 'Finished' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Agent idle' })).toBeTruthy();
  });

  it('falls back to the raw kind when unknown', async () => {
    vi.mocked(client.getAgentStatus).mockResolvedValue({
      busy: false,
      task: null,
      jobs: [{ id: 'j9', kind: 'weird-kind', subject: 'DB Systems', status: 'queued' }],
    });
    renderSidebar();
    // jobs alone still count as work, even with no setup task
    fireEvent.click(await screen.findByRole('button', { name: /^Working/ }));
    expect(screen.getByText(/weird-kind — DB Systems: queued/)).toBeTruthy();
  });
});
