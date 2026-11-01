import { useState } from 'react';
import { formatDateTime } from '../lib/format';
import type { ChatSession, ID } from '@studi0/shared';
import { ContextMenu } from '../components/ContextMenu';

export function SessionList({
  sessions,
  currentId,
  onSelect,
  onNew,
  onRename,
}: {
  sessions: ChatSession[];
  currentId: ID | null;
  onSelect: (s: ChatSession) => void;
  onNew: () => void;
  onRename: (s: ChatSession, title: string) => void;
}) {
  const [menu, setMenu] = useState<{ s: ChatSession; x: number; y: number } | null>(null);

  const title = (s: ChatSession): string => s.title ?? `Chat — ${formatDateTime(s.createdAt)}`;

  return (
    <div className="session-list">
      <button type="button" className="btn" onClick={onNew}>
        + New chat
      </button>
      <div className="session-rows" role="list" aria-label="Chat history">
        {sessions.length === 0 && <p className="muted">No chats yet — start one above.</p>}
        {sessions.map((s) => (
          <div key={s.id} role="listitem" className="session-row-wrap">
            <button
              type="button"
              className={`session-row${s.id === currentId ? ' active' : ''}`}
              onClick={() => onSelect(s)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ s, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="session-row-title">{title(s)}</span>
              <span className="session-row-meta">
                {s.messageCount} message{s.messageCount === 1 ? '' : 's'}
                {s.lessonId !== null ? ' · lesson' : ''}
                {s.summaryPath !== null ? ' · rotated' : ''}
              </span>
            </button>
            <button
              type="button"
              className="kebab"
              aria-label={`${title(s)} options`}
              onClick={(e) => {
                e.stopPropagation();
                setMenu({ s, x: e.clientX, y: e.clientY });
              }}
            >
              ⋯
            </button>
          </div>
        ))}
        {currentId !== null && !sessions.some((s) => s.id === currentId) && (
          <div className="session-row-wrap">
            <button type="button" className="session-row active" onClick={() => onSelect}>
              <span className="session-row-title">Current chat</span>
            </button>
          </div>
        )}
      </div>
      {menu !== null && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            items: [
              {
                label: 'Rename',
                onSelect: () => {
                  const name = window.prompt('Rename chat', menu.s.title ?? title(menu.s));
                  if (name !== null && name.trim() !== '') onRename(menu.s, name.trim());
                },
              },
            ],
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
