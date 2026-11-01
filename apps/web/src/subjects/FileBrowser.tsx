import { useState } from 'react';
import type { ID, TreeDir } from '@studi0/shared';
import { displayError, splitPdf } from '../api/client';
import { useTree } from '../api/hooks';
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
  const tree = useTree(subjectId, dir, version);

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
              {tree.data.entries.map((e) => (
                <tr key={e.path}>
                  <td>
                    <code>{e.path}</code>
                  </td>
                  <td>{formatBytes(e.bytes)}</td>
                  <td>{formatDateTime(e.mtime)}</td>
                  <td>
                    {dir === 'lessons' &&
                      e.ext.replace(/^\./, '').toLowerCase() === 'html' && (
                        <button className="btn btn-small" onClick={() => onOpenLesson(e.path)}>
                          Open
                        </button>
                      )}
                    {e.ext.replace(/^\./, '').toLowerCase() === 'pdf' && (
                      <button
                        className="btn btn-small"
                        disabled={splitting}
                        onClick={() => void onSplit(e.path)}
                      >
                        Split into parts
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}
