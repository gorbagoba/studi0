import { useEffect, useRef, useState } from 'react';
import { useGroups, useSubjects } from '../api/hooks';
import {
  createGroup,
  deleteGroup,
  deleteSubject,
  deleteSubjectFiles,
  displayError,
  getAgentStatus,
  getHealth,
  mergeSubject,
  renameGroup,
  renameSubject,
  shutdownServer,
} from '../api/client';
import type { AgentStatus } from '../api/client';
import type { Group, Subject } from '@studi0/shared';
import { useApp } from '../state/app';
import { AddSubjectDialog } from './AddSubjectDialog';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ContextMenu } from '../components/ContextMenu';
import type { MenuItem, MenuState } from '../components/ContextMenu';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmojiPickerModal } from './EmojiPickerModal';
import { PromptDialog } from '../components/PromptDialog';
import { ThemeToggle } from '../components/ThemeToggle';

const COLLAPSE_KEY = 'studi0.collapsed-groups';
const SIDEBAR_KEY = 'studi0.sidebar-collapsed';

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

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14,12.94a7.07,7.07 0 0,0 .06,-.94 7.07,7.07 0 0,0 -.06,-.94l2.03,-1.58a.5,.5 0 0,0 .12,-.64l-1.92,-3.32a.5,.5 0 0,0 -.61,-.22l-2.39,.96a7.3,7.3 0 0,0 -1.62,-.94l-.36,-2.54a.5,.5 0 0,0 -.5,-.42h-3.84a.5,.5 0 0,0 -.5,.42l-.36,2.54a7.3,7.3 0 0,0 -1.62,.94l-2.39,-.96a.5,.5 0 0,0 -.61,.22L2.74,8.84a.5,.5 0 0,0 .12,.64l2.03,1.58a7.07,7.07 0 0,0 -.06,.94 7.07,7.07 0 0,0 .06,.94L2.86,14.5a.5,.5 0 0,0 -.12,.64l1.92,3.32c.14,.24 .44,.34 .61,.22l2.39,-.96c.5,.4 1.04,.72 1.62,.94l.36,2.54a.5,.5 0 0,0 .5,.42h3.84a.5,.5 0 0,0 .5,-.42l.36,-2.54a7.3,7.3 0 0,0 1.62,-.94l2.39,.96c.24,.1 .55,0 .61,-.22l1.92,-3.32a.5,.5 0 0,0 -.12,-.64ZM12,15.5A3.5,3.5 0 1,1 12,8.5a3.5,3.5 0 0,1 0,7Z"
      />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M12 3v8" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        d="M6.3 6.5a8 8 0 1 0 11.4 0"
      />
    </svg>
  );
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
  const [dragSubject, setDragSubject] = useState<Subject | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [iconPickerFor, setIconPickerFor] = useState<Subject | null>(null);
  const [rail, setRail] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  // pending in-app dialog flows (replace window.prompt / window.confirm)
  const [renameTarget, setRenameTarget] = useState<Subject | null>(null);
  const [renameGroupTarget, setRenameGroupTarget] = useState<Group | null>(null);
  const [deleteFilesTarget, setDeleteFilesTarget] = useState<Subject | null>(null);
  const [shutdownSummary, setShutdownSummary] = useState<string | null>(null);

  function setRailPersist(v: boolean): void {
    setRail(v);
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0');
    } catch {
      // private mode etc. — the rail state just won't persist
    }
  }
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

  /** confirmation already happened in the menu's dialog — unregister only, files stay on disk */
  async function doRemove(s: Subject) {
    if (await run(() => deleteSubject(s.id))) {
      if (s.id === subjectId) selectSubject(null);
    }
  }

  async function doMerge(s: Subject, target: Subject) {
    try {
      setActionError(null);
      const r = await mergeSubject(s.id, target.id);
      setMergeResult({ moved: r.moved, skipped: r.skipped, into: target.name });
    } catch (e) {
      setActionError(displayError(e));
    }
    reload();
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
      { label: 'Rename', onSelect: () => setRenameTarget(s) },
      {
        label: 'Set icon…',
        onSelect: () => setIconPickerFor(s),
      },
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
          .map((o) => ({
            label: o.name,
            confirm: `Merge "${s.name}" into "${o.name}"? Its files move over.`,
            onSelect: () => void doMerge(s, o),
          })),
      },
      {
        label: 'Remove from studi0',
        confirm: `Remove "${s.name}" from studi0? Your files on disk are NOT deleted.`,
        onSelect: () => void doRemove(s),
      },
      {
        label: 'Delete files from disk',
        danger: true,
        onSelect: () => setDeleteFilesTarget(s),
      },
    ];
  }

  function groupMenuItems(g: Group): MenuItem[] {
    const count = inGroup(g.id).length;
    return [
      { label: 'Rename', onSelect: () => setRenameGroupTarget(g) },
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
        onDragStart={() => setDragSubject(s)}
        onDragEnd={() => {
          setDragSubject(null);
          setDragOverGroup(null);
        }}
      />
    );
  }

  /** gathers the shutdown summary, then asks for confirmation in an in-app dialog */
  async function askShutdown() {
    let summary: string;
    try {
      const h = await getHealth();
      const jobs =
        h.jobs.length === 0
          ? 'none'
          : h.jobs.map((j) => `${j.subject} — ${j.kind}, ${j.done}/${j.total}`).join('\n');
      summary = `Active jobs: ${jobs}\nTeacher: ${h.opencode.healthy ? 'healthy' : 'offline'}\n\nRunning graph builds are cancelled, the teacher goes offline, and you will need to restart with \`pnpm dev\`.`;
    } catch {
      summary =
        'Could not check running jobs (server unreachable).\n\nRunning graph builds are cancelled, the teacher goes offline, and you will need to restart with `pnpm dev`.';
    }
    setShutdownSummary(summary);
  }

  const emptyList =
    groupList.length === 0 && all.length === 0 && !subjects.loading && subjects.error === null;

  if (rail) {
    return (
      <aside className="sidebar sidebar-rail" aria-label="Sidebar (collapsed)">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setRailPersist(false)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          »
        </button>
        <ThemeToggle iconOnly />
        {all.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`icon-btn rail-subject${s.id === subjectId ? ' active' : ''}`}
            onClick={() => selectSubject(s.id)}
            aria-label={s.name}
            title={s.name}
          >
            {s.icon !== null ? <span className="subject-icon">{s.icon}</span> : s.name.charAt(0).toUpperCase()}
          </button>
        ))}
        <div className="sidebar-rail-spacer" />
        <div className="sidebar-footer">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings & diagnostics"
            title="Settings & diagnostics"
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className="icon-btn icon-danger"
            onClick={() => void askShutdown()}
            aria-label="Shut down studi0"
            title="Shut down"
          >
            <PowerIcon />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <h1 className="brand">
          <button type="button" className="brand-home" onClick={() => selectSubject(null)} title="Home">
            studi0
          </button>
        </h1>
        <div className="brand-actions">
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn"
            onClick={() => setRailPersist(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            «
          </button>
        </div>
      </div>
      {shuttingDown && (
        <p className="muted shutdown-note" role="status">
          Server shut down. Close this tab — restart with <code>pnpm dev</code>.{' '}
          <CopyRestartCommand />
        </p>
      )}
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
          className="btn new-group-btn"
          onClick={() => {
            setNewGroupOpen(true);
            setNewGroupName('');
          }}
        >
          New group
        </button>
      )}
      <button className="btn" onClick={() => setAddOpen(true)}>
        Add subject
      </button>
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
      <nav
        aria-label="Subjects"
        onDragOver={(e) => {
          if (dragSubject !== null) e.preventDefault();
        }}
        onDrop={(e) => {
          if (dragSubject === null) return;
          e.preventDefault();
          const s = dragSubject;
          setDragSubject(null);
          setDragOverGroup(null);
          if (s.groupId !== null) void run(() => renameSubject(s.id, { groupId: null }));
        }}
      >
        {subjects.loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {groupList.map((g) => {
              const isCollapsed = collapsed.has(g.id);
              return (
                <section key={g.id} className="group-section">
                  <div
                    className={`group-header${dragOverGroup === g.id ? ' drag-over' : ''}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openAt(e.clientX, e.clientY, groupMenuItems(g));
                    }}
                    onDragOver={(e) => {
                      if (dragSubject === null) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverGroup(g.id);
                    }}
                    onDragLeave={() => setDragOverGroup((cur) => (cur === g.id ? null : cur))}
                    onDrop={(e) => {
                      if (dragSubject === null) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const s = dragSubject;
                      setDragSubject(null);
                      setDragOverGroup(null);
                      if (s.groupId !== g.id) void run(() => renameSubject(s.id, { groupId: g.id }));
                    }}
                  >
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${g.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroup(g.id);
                      }}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <button
                      type="button"
                      className="group-name"
                      title={g.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroup(g.id);
                      }}
                    >
                      {g.name}
                    </button>
                    <button
                      type="button"
                      className="kebab"
                      aria-label={`${g.name} options`}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        anchor(e, groupMenuItems(g));
                      }}
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
      <div className="sidebar-bottom">
        <AgentSection />
        <div className="sidebar-footer">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings & diagnostics"
            title="Settings & diagnostics — probe servers, restart the teacher, cancel stuck jobs"
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className="icon-btn icon-danger"
            onClick={() => void askShutdown()}
            aria-label="Shut down studi0"
            title="Shut down — cancels running builds, stops the teacher and API"
          >
            <PowerIcon />
          </button>
        </div>
      </div>
      <AddSubjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          selectSubject(s.id);
          subjects.reload();
        }}
      />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <PromptDialog
        open={renameTarget !== null}
        title="Rename subject"
        label="New name"
        initialValue={renameTarget?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await run(() => renameSubject(renameTarget!.id, { name }));
        }}
        onClose={() => setRenameTarget(null)}
      />
      <PromptDialog
        open={renameGroupTarget !== null}
        title="Rename group"
        label="New name"
        initialValue={renameGroupTarget?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await run(() => renameGroup(renameGroupTarget!.id, name));
        }}
        onClose={() => setRenameGroupTarget(null)}
      />
      <PromptDialog
        open={deleteFilesTarget !== null}
        title={`Delete ALL files of "${deleteFilesTarget?.name}" from disk?`}
        label="This is irreversible. Type the subject name to confirm:"
        mustMatch={deleteFilesTarget?.name ?? ''}
        submitLabel="Delete files"
        danger
        onSubmit={async (confirm) => {
          await run(() => deleteSubjectFiles(deleteFilesTarget!.id, { confirm }));
        }}
        onClose={() => setDeleteFilesTarget(null)}
      />
      <ConfirmDialog
        open={shutdownSummary !== null}
        title="Shut down studi0?"
        body={shutdownSummary ?? ''}
        confirmLabel="Shut down"
        danger
        onConfirm={() => {
          setShutdownSummary(null);
          setShuttingDown(true);
          void shutdownServer().catch(() => undefined);
        }}
        onClose={() => setShutdownSummary(null)}
      />
      {iconPickerFor !== null && (
        <EmojiPickerModal
          subjectName={iconPickerFor.name}
          onSelect={(emoji) => void run(() => renameSubject(iconPickerFor.id, { icon: emoji }))}
          onClose={() => setIconPickerFor(null)}
        />
      )}
    </aside>
  );
}

function SubjectRow({
  s,
  active,
  onOpen,
  items,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  s: Subject;
  active: boolean;
  onOpen: () => void;
  items: MenuItem[];
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <li
      className="subject-row"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
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
        {s.icon !== null && <span className="subject-icon">{s.icon}</span>}
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

const AGENT_KIND_LABELS: Record<string, string> = {
  chat: 'Teacher turn',
  'lesson-generation': 'Writing lessons',
  build: 'Graph build',
  update: 'Graph build',
  recluster: 'Graph build',
  extract: 'Graph build',
};

function kindLabel(kind: string): string {
  return AGENT_KIND_LABELS[kind] ?? kind;
}

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  return Number.isFinite(ms) ? `started ${Math.max(1, Math.round(ms / 60000))}m ago` : '';
}

/** Best-effort agent status: polls every 3s, never surfaces errors (status is informational). */
function AgentSection() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  // null until the first poll, so a cold idle start never shows "Finished"
  const prevBusy = useRef<boolean | null>(null);
  const finishTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      getAgentStatus()
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          const nowBusy = s.busy === true || s.jobs.length > 0;
          if (prevBusy.current === true && !nowBusy) {
            setFinished(true);
            if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
            finishTimer.current = window.setTimeout(() => {
              finishTimer.current = null;
              setFinished(false);
            }, 5000);
          } else if (nowBusy && finishTimer.current !== null) {
            window.clearTimeout(finishTimer.current);
            finishTimer.current = null;
            setFinished(false);
          }
          prevBusy.current = nowBusy;
        })
        .catch(() => undefined);
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
    };
  }, []);

  const task = status?.task ?? null;
  const jobs = status?.jobs ?? [];
  const busy = status?.busy === true || jobs.length > 0;
  // a chat/activity row has no task row, so fall back to its subject name
  const busySubject = task?.subjectName ?? jobs.find((j) => j.subjectName !== undefined)?.subjectName;

  let text = 'Agent idle';
  if (busy) text = busySubject !== undefined ? `Working: ${busySubject}` : 'Working…';
  else if (finished) text = 'Finished';

  return (
    <div className="agent-section">
      <button
        type="button"
        className="agent-btn"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`agent-dot${busy ? ' busy' : finished ? ' done' : ''}`} aria-hidden="true" />
        <span aria-live="polite">{text}</span>
      </button>
      {open && (
        <div className="agent-popover">
          <p className="agent-popover-title">Current jobs</p>
          {busy && task !== null && (
            <p className="agent-task">
              {kindLabel(task.kind)} — {task.subjectName}
              {elapsed(task.startedAt) !== '' && (
                <span className="muted"> ({elapsed(task.startedAt)})</span>
              )}
            </p>
          )}
          {jobs.map((j) => {
            const subject = j.subject ?? j.subjectName ?? '';
            const jobElapsed = j.startedAt !== undefined ? elapsed(j.startedAt) : '';
            return (
              <p key={j.id} className="agent-task">
                {kindLabel(j.kind)} — {subject}
                {j.status !== undefined && `: ${j.status}`}
                {j.done !== undefined && j.total !== undefined && (
                  <span className="muted">
                    {' '}
                    ({j.done}/{j.total})
                  </span>
                )}
                {jobElapsed !== '' && <span className="muted"> ({jobElapsed})</span>}
              </p>
            );
          })}
          {!busy && jobs.length === 0 && <p className="agent-task muted">No active jobs</p>}
        </div>
      )}
    </div>
  );
}
