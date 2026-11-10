import { useState } from 'react';
import { useApp } from '../state/app';
import { useLessons } from '../api/hooks';
import { deleteLesson, displayError, renameLesson } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ContextMenu } from '../components/ContextMenu';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { PromptDialog } from '../components/PromptDialog';
import { formatDateTime } from '../lib/format';
import type { ID, Lesson } from '@studi0/shared';

export function LessonsList({
  subjectId,
  version,
}: {
  subjectId: ID;
  version: number;
}) {
  const { openLesson } = useApp();
  const lessons = useLessons(subjectId, version);
  const [menu, setMenu] = useState<{ lesson: Lesson; x: number; y: number } | null>(null);
  const [renameFor, setRenameFor] = useState<Lesson | null>(null);
  const [deleteFor, setDeleteFor] = useState<ID | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const reviewed = lessons.data?.filter((l) => l.reviewedAt !== null).length ?? 0;
  const total = lessons.data?.length ?? 0;

  async function confirmDelete(): Promise<void> {
    if (deleteFor === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteLesson(deleteFor);
      setDeleteFor(null);
      lessons.reload();
    } catch (err) {
      setDeleteError(displayError(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <nav aria-labelledby="lessons-title" className="lessons-list">
      <h3 id="lessons-title">
        Lessons{total > 0 ? <span className="muted"> — {reviewed}/{total} reviewed</span> : null}
      </h3>
      {lessons.loading && <p className="muted">Loading…</p>}
      {lessons.error !== null && <ErrorBanner message={lessons.error} />}
      {lessons.data !== null &&
        (lessons.data.length === 0 ? (
          <EmptyState title="No lessons yet" hint="Ask the teacher in Chat to write one." />
        ) : (
          <div className="lesson-rows" role="list" aria-label="All lessons">
            {lessons.data.map((l) => (
              <div key={l.id} role="listitem" className="lesson-row-wrap">
                <button
                  type="button"
                  className="lesson-row"
                  onClick={() => openLesson(l.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ lesson: l, x: e.clientX, y: e.clientY });
                  }}
                >
                  <span className="lesson-row-title">
                    {l.reviewedAt !== null && (
                      <span className="review-tick" title={`Reviewed ${formatDateTime(l.reviewedAt)}`}>
                        ✓
                      </span>
                    )}
                    {l.title}
                  </span>
                  <span className="lesson-row-meta">
                    updated {formatDateTime(l.updatedAt)}
                    {l.nodeTags.length > 0 ? ` · ${l.nodeTags.length} graph topics` : ''}
                  </span>
                </button>
              </div>
            ))}
          </div>
        ))}
      {menu !== null && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            items: [
              { label: 'Rename', onSelect: () => setRenameFor(menu.lesson) },
              {
                label: 'Delete',
                danger: true,
                onSelect: () => {
                  setDeleteError(null);
                  setDeleteFor(menu.lesson.id);
                },
              },
            ],
          }}
          onClose={() => setMenu(null)}
        />
      )}
      <PromptDialog
        open={renameFor !== null}
        title="Rename lesson"
        label="Title"
        initialValue={renameFor?.title ?? ''}
        submitLabel="Rename"
        onSubmit={async (title) => {
          if (renameFor === null) return;
          await renameLesson(renameFor.id, title);
          lessons.reload();
        }}
        onClose={() => setRenameFor(null)}
      />
      <ConfirmDialog
        open={deleteFor !== null}
        title="Delete this lesson?"
        body="The lesson file and its generated practice questions, attempts and review schedule are removed permanently."
        confirmLabel="Delete"
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setDeleteFor(null);
          setDeleteError(null);
        }}
      />
    </nav>
  );
}
