import { useState } from 'react';
import type { ID, TreeDir } from '@studi0/shared';
import { useTree } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatBytes, formatDateTime } from '../lib/format';

const ROOTS: readonly TreeDir[] = ['material', 'lessons', 'reference', 'graphify-out'];

export function FileBrowser({
  subjectId,
  version,
  onOpenLesson,
}: {
  subjectId: ID;
  version: number;
  onOpenLesson: (path: string) => void;
}) {
  const [dir, setDir] = useState<TreeDir>('material');
  const tree = useTree(subjectId, dir, version);

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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}
