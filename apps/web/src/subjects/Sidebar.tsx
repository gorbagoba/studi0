import { useState } from 'react';
import { useGroups, useSubjects } from '../api/hooks';
import {
  createGroup,
  deleteGroup,
  deleteSubject,
  deleteSubjectFiles,
  displayError,
  getHealth,
  mergeSubject,
  renameGroup,
  renameSubject,
  shutdownServer,
} from '../api/client';
import type { Group, Subject } from '@studi0/shared';
import { useApp } from '../state/app';
import { AddSubjectDialog } from './AddSubjectDialog';
import { Badge } from '../components/Badge';
import { ContextMenu } from '../components/ContextMenu';
import type { MenuItem, MenuState } from '../components/ContextMenu';
import { ErrorBanner } from '../components/ErrorBanner';

const COLLAPSE_KEY = 'studi0.collapsed-groups';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const ids: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function Sidebar() {
  const { subjectId, selectSubject, setSettingsOpen } = useApp();
  const subjects = useSubjects();
  const groups = useGroups();
  const [addOpen, setAddOpen] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<{
    moved: string[];
    skipped: string[];
    into: string;
  } | null>(null);

  const all = subjects.data ?? [];
  // tolerate odd group payloads (e.g. before the server lands) — groups are additive
  const groupList = Array.isArray(groups.data) ? groups.data : [];
  const inGroup = (gid: string) => all.filter((s) => s.groupId === gid);
  const ungrouped = all.filter((s) => s.groupId == null);

  const reload = () => {
    subjects.reload();
    groups.reload();
  };

  /** runs a mutation, surfaces failures in the sidebar banner, refreshes both lists */
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      setActionError(null);
      await fn();
      reload();
      return true;
    } catch (e) {
      setActionError(displayError(e));
      return false;
    }
  }

  async function onRemove(s: Subject) {
    // unregister only — server never touches the files on disk
    if (!window.confirm(`Remove "${s.name}" from studi0? Your files on disk are NOT deleted.`))
      return;
    await deleteSubject(s.id);
    if (s.id === subjectId) selectSubject(null);
    subjects.reload();
  }

  async function onRenameSubject(s: Subject) {
    const name = window.prompt(`Rename subject "${s.name}"`, s.name);
    if (name === null || name.trim() === '' || name.trim() === s.name) return;
    await run(() => renameSubject(s.id, { name: name.trim() }));
  }

  async function onMerge(s: Subject, target: Subject) {
    if (!window.confirm(`Merge "${s.name}" into "${target.name}"? Its files move over.`)) return;
    try {
      setActionError(null);
      const r = await mergeSubject(s.id, target.id);
      setMergeResult({ moved: r.moved, skipped: r.skipped, into: target.name });
    } catch (e) {
      setActionError(displayError(e));
    }
    reload();
  }

  async function onDeleteFiles(s: Subject) {
    const typed = window.prompt(
      `Delete ALL files of "${s.name}" from disk? This is irreversible.\nType the subject name to confirm:`,
    );
    if (typed !== s.name) return;
    await run(() => deleteSubjectFiles(s.id, { confirm: typed }));
  }

  async function onRenameGroup(g: Group) {
    const name = window.prompt(`Rename group "${g.name}"`, g.name);
    if (name === null || name.trim() === '' || name.trim() === g.name) return;
    await run(() => renameGroup(g.id, name.trim()));
  }

  async function onCreateGroup() {
    const name = newGroupName.trim();
    if (name === '') return;
    if (await run(() => createGroup(name))) {
      setNewGroupName('');
      setNewGroupOpen(false);
    }
  }

  function toggleGroup(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // private mode etc. — collapse just won't persist
      }
      return next;
    });
  }

  function openAt(x: number, y: number, items: MenuItem[]) {
    setMenu({ x, y, items });
  }

  function anchor(e: { currentTarget: HTMLElement }, items: MenuItem[]) {
    const r = e.currentTarget.getBoundingClientRect();
    openAt(r.left, r.bottom + 4, items);
  }

  function subjectMenuItems(s: Subject): MenuItem[] {
    return [
      { label: 'Open', onSelect: () => selectSubject(s.id) },
      { label: 'Rename', onSelect: () => void onRenameSubject(s) },
      {
        label: 'Move to group',
        submenu: [
          ...groupList.map((g) => ({
            label: g.name,
            onSelect: () => void run(() => renameSubject(s.id, { groupId: g.id })),
          })),
          // groupId null = ungroup
          {
            label: 'No group',
            onSelect: () => void run(() => renameSubject(s.id, { groupId: null })),
          },
        ],
      },
      {
        label: 'Merge into subject…',
        submenu: all
          .filter((o) => o.id !== s.id)
          .map((o) => ({ label: o.name, onSelect: () => void onMerge(s, o) })),
      },
      {
        label: 'Remove from studi0',
        confirm: `Remove "${s.name}" from studi0? Your files on disk are NOT deleted.`,
        onSelect: () => void onRemove(s),
      },
      {
        label: 'Delete files from disk',
        danger: true,
        onSelect: () => void onDeleteFiles(s),
      },
    ];
  }

  function groupMenuItems(g: Group): MenuItem[] {
    const count = inGroup(g.id).length;
    return [
      { label: 'Rename', onSelect: () => void onRenameGroup(g) },
      {
        label: 'Delete',
        danger: true,
        confirm:
          count > 0
            ? `Delete group "${g.name}"? ${count} ${
                count === 1 ? 'subject becomes' : 'subjects become'
              } ungrouped.`
            : `Delete group "${g.name}"?`,
        onSelect: () => void run(() => deleteGroup(g.id)),
      },
    ];
  }

  function renderSubjectRow(s: Subject) {
    return (
      <SubjectRow
        key={s.id}
        s={s}
        active={s.id === subjectId}
        onOpen={() => selectSubject(s.id)}
        items={subjectMenuItems(s)}
        onMenu={openAt}
      />
    );
  }

  async function onShutdown() {
    let summary: string;
    try {
      const h = await getHealth();
      const jobs =
        h.jobs.length === 0
          ? 'none'
          : h.jobs.map((j) => `${j.subject} — ${j.kind}, ${j.done}/${j.total}`).join('\n');
      summary = `Active jobs: ${jobs}\nTeacher: ${h.opencode.healthy ? 'healthy' : 'offline'}`;
    } catch {
      summary = 'Could not check running jobs (server unreachable).';
    }
    if (
      !window.confirm(
        `Shut down studi0?\n\n${summary}\n\nRunning graph builds are cancelled, the teacher goes offline, and you will need to restart with \`pnpm dev\`.`,
      )
    ) {
      return;
    }
    setShuttingDown(true);
    void shutdownServer().catch(() => undefined);
  }

  const emptyList =
    groupList.length === 0 && all.length === 0 && !subjects.loading && subjects.error === null;

  return (
    <aside className="sidebar">
      <h1 className="brand">studi0</h1>
      <button className="btn" onClick={() => setAddOpen(true)}>
        Add subject
      </button>
      {newGroupOpen ? (
        <form
          className="new-group"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreateGroup();
          }}
        >
          <input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Group name"
            aria-label="New group name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setNewGroupOpen(false);
                setNewGroupName('');
              }
            }}
          />
          <button type="submit" className="btn btn-small">
            Create
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            setNewGroupOpen(true);
            setNewGroupName('');
          }}
        >
          New group
        </button>
      )}
      {actionError !== null && <ErrorBanner message={actionError} />}
      {mergeResult !== null && (
        <div
          className={`banner ${mergeResult.skipped.length > 0 ? 'banner-warn' : 'banner-ok'}`}
          role="status"
        >
          Merged {mergeResult.moved.length} file
          {mergeResult.moved.length === 1 ? '' : 's'} into "{mergeResult.into}".
          {mergeResult.skipped.length > 0 && (
            <>
              {' '}
              Skipped (name already exists):
              <ul>
                {mergeResult.skipped.map((n) => (
                  <li key={n}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <nav aria-label="Subjects">
        {subjects.loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {groupList.map((g) => {
              const isCollapsed = collapsed.has(g.id);
              return (
                <section key={g.id} className="group-section">
                  <div
                    className="group-header"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openAt(e.clientX, e.clientY, groupMenuItems(g));
                    }}
                  >
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${g.name}`}
                      onClick={() => toggleGroup(g.id)}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <span className="group-name" title={g.name}>
                      {g.name}
                    </span>
                    <button
                      type="button"
                      className="kebab"
                      aria-label={`${g.name} options`}
                      aria-haspopup="menu"
                      onClick={(e) => anchor(e, groupMenuItems(g))}
                    >
                      ⋯
                    </button>
                  </div>
                  {!isCollapsed && (
                    <ul className="subject-list nested">
                      {inGroup(g.id).map(renderSubjectRow)}
                    </ul>
                  )}
                </section>
              );
            })}
            {ungrouped.length > 0 && <ul className="subject-list">{ungrouped.map(renderSubjectRow)}</ul>}
            {emptyList && <p className="muted">No subjects yet.</p>}
          </>
        )}
      </nav>
      {subjects.error !== null && <ErrorBanner message={subjects.error} />}
      <button
        type="button"
        className="btn btn-small"
        onClick={() => setSettingsOpen(true)}
        title="Probe servers, restart the teacher, cancel stuck jobs"
      >
        Settings &amp; diagnostics
      </button>
      {shuttingDown ? (
        <p className="muted shutdown-note" role="status">
          Server shut down. Close this tab — restart with <code>pnpm dev</code>.{' '}
          <CopyRestartCommand />
        </p>
      ) : (
        <button type="button" className="btn btn-small shutdown-btn" onClick={onShutdown}>
          Shut down
        </button>
      )}
      <AddSubjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          selectSubject(s.id);
          subjects.reload();
        }}
      />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}

function SubjectRow({
  s,
  active,
  onOpen,
  items,
  onMenu,
}: {
  s: Subject;
  active: boolean;
  onOpen: () => void;
  items: MenuItem[];
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}) {
  return (
    <li
      className="subject-row"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY, items);
      }}
    >
      <button
        className={`subject-item${active ? ' active' : ''}`}
        aria-current={active || undefined}
        onClick={onOpen}
      >
        <span>{s.name}</span>
        {s.stale && <Badge tone="warn">stale</Badge>}
      </button>
      <button
        type="button"
        className="kebab"
        aria-label={`${s.name} options`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4, items);
        }}
      >
        ⋯
      </button>
    </li>
  );
}

function CopyRestartCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() => {
        void navigator.clipboard.writeText('pnpm dev');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : 'Copy restart command'}
    </button>
  );
}
