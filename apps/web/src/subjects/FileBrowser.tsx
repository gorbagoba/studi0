import { useState } from 'react';
import type { FileRow, ID, TreeDir } from '@studi0/shared';
import {
  deleteFile,
  displayError,
  moveFile,
  renameFile,
  splitPdf,
} from '../api/client';
import { useSubjects, useTree } from '../api/hooks';
import { ContextMenu } from '../components/ContextMenu';
import type { MenuItem, MenuState } from '../components/ContextMenu';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatBytes, formatDateTime } from '../lib/format';

const ROOTS: readonly TreeDir[] = ['material', 'lessons', 'reference', 'graphify-out'];

export function FileBrowser({
  subjectId,
  version,
  onOpenLesson,
  onFilesChanged,
}: {
  subjectId: ID;
  version: number;
  onOpenLesson: (path: string) => void;
  onFilesChanged: () => void;
}) {
  const [dir, setDir] = useState<TreeDir>('material');
  const [splitting, setSplitting] = useState(false);
  const [splitParts, setSplitParts] = useState<string[] | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const tree = useTree(subjectId, dir, version);
  const subjects = useSubjects();

  async function onSplit(path: string): Promise<void> {
    if (!window.confirm(`Split "${path}" into per-lecture PDFs? The original file is kept.`)) return;
    setSplitting(true);
    setSplitError(null);
    try {
      const { parts } = await splitPdf(subjectId, path);
      setSplitParts(parts);
      onFilesChanged();
    } catch (e) {
      setSplitError(displayError(e));
    } finally {
      setSplitting(false);
    }
  }

  async function onRenameFile(e: FileRow): Promise<void> {
    const name = window.prompt(`Rename "${e.name}"`, e.name);
    if (name === null || name.trim() === '' || name.trim() === e.name) return;
    setActionError(null);
    try {
      await renameFile(e.id, name.trim());
      onFilesChanged();
    } catch (err) {
      setActionError(displayError(err));
    }
  }

  async function onDeleteFile(e: FileRow): Promise<void> {
    setActionError(null);
    try {
      await deleteFile(e.id);
      onFilesChanged();
    } catch (err) {
      setActionError(displayError(err));
    }
  }

  /** 409 (NAME_TAKEN) when the target already has a file with this name — surfaces in the banner */
  async function onMoveFile(e: FileRow, targetSubjectId: ID): Promise<void> {
    setActionError(null);
    try {
      await moveFile(e.id, targetSubjectId);
      onFilesChanged();
    } catch (err) {
      setActionError(displayError(err));
    }
  }

  function fileMenuItems(e: FileRow): MenuItem[] {
    const others = (subjects.data ?? []).filter((o) => o.id !== subjectId);
    const items: MenuItem[] = [
      { label: 'Rename', onSelect: () => void onRenameFile(e) },
      {
        label: 'Delete',
        danger: true,
        confirm: `Delete "${e.path}"? This cannot be undone.`,
        onSelect: () => void onDeleteFile(e),
      },
    ];
    if (others.length > 0) {
      items.push({
        label: 'Move to subject',
        submenu: others.map((o) => ({
          label: o.name,
          onSelect: () => void onMoveFile(e, o.id),
        })),
      });
    }
    return items;
  }

  function openFileMenu(e: { clientX: number; clientY: number }, file: FileRow) {
    setMenu({ x: e.clientX, y: e.clientY, items: fileMenuItems(file) });
  }

  return (
    <section aria-labelledby="files-title" className="panel">
      <h3 id="files-title">Files</h3>
      <div className="btn-row" role="group" aria-label="Folder">
        {ROOTS.map((r) => (
          <button
            key={r}
            className={`tab${dir === r ? ' active' : ''}`}
            aria-pressed={dir === r}
            onClick={() => setDir(r)}
          >
            {r}/
          </button>
        ))}
      </div>
      {tree.loading && <p className="muted">Loading…</p>}
      {tree.error !== null && <ErrorBanner message={tree.error} />}
      {splitError !== null && <ErrorBanner message={splitError} />}
      {actionError !== null && <ErrorBanner message={actionError} />}
      {splitParts !== null && (
        <p className="muted" role="status">
          Split into {splitParts.length} part{splitParts.length === 1 ? '' : 's'}:{' '}
          <code>{splitParts.join(', ')}</code>
        </p>
      )}
      {tree.data !== null &&
        (tree.data.entries.length === 0 ? (
          <EmptyState title={`Nothing in ${dir}/ yet`} />
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col">Size</th>
                <th scope="col">Modified</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tree.data.entries.map((entry) => {
                // TODO(server): listTree must expose the files-table row id — until it does,
                // file.id is undefined at runtime and move/rename/delete surface a 404
                const file = entry as FileRow;
                // menus (right-click + kebab) only on files inside material/
                const isMaterial = dir === 'material';
                return (
                  <tr
                    key={entry.path}
                    onContextMenu={
                      isMaterial
                        ? (e) => {
                            e.preventDefault();
                            openFileMenu(e, file);
                          }
                        : undefined
                    }
                  >
                    <td>
                      <code>{entry.path}</code>
                    </td>
                    <td>{formatBytes(entry.bytes)}</td>
                    <td>{formatDateTime(entry.mtime)}</td>
                    <td>
                      {dir === 'lessons' &&
                        entry.ext.replace(/^\./, '').toLowerCase() === 'html' && (
                          <button className="btn btn-small" onClick={() => onOpenLesson(entry.path)}>
                            Open
                          </button>
                        )}
                      {entry.ext.replace(/^\./, '').toLowerCase() === 'pdf' && (
                        <button
                          className="btn btn-small"
                          disabled={splitting}
                          onClick={() => void onSplit(entry.path)}
                        >
                          Split into parts
                        </button>
                      )}
                      {isMaterial && (
                        <button
                          type="button"
                          className="kebab"
                          aria-label={`${entry.name} options`}
                          aria-haspopup="menu"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            openFileMenu({ clientX: r.left, clientY: r.bottom + 4 }, file);
                          }}
                        >
                          ⋯
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </section>
  );
}
