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
  onDelete,
  onClean,
}: {
  sessions: ChatSession[];
  currentId: ID | null;
  onSelect: (s: ChatSession) => void;
  onNew: () => void;
  onRename: (s: ChatSession, title: string) => void;
  onDelete: (s: ChatSession) => void;
  onClean: () => void;
}) {
  const [menu, setMenu] = useState<{ s: ChatSession; x: number; y: number } | null>(null);
  const [filter, setFilter] = useState('');

  const title = (s: ChatSession): string => s.title ?? `Chat — ${formatDateTime(s.createdAt)}`;
  const q = filter.trim().toLowerCase();
  const visible = q === '' ? sessions : sessions.filter((s) => title(s).toLowerCase().includes(q));
  const emptyCount = sessions.filter((s) => s.messageCount === 0).length;

  return (
    <div className="session-list">
      <div className="session-tools">
        <button type="button" className="btn" onClick={onNew}>
          + New chat
        </button>
        <input
          type="search"
          className="session-filter"
          placeholder="Filter chats…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter chats"
        />
        {emptyCount > 0 && (
          <button
            type="button"
            className="btn btn-small"
            title="Remove chats that never got a message"
            onClick={() => {
              if (window.confirm(`Delete ${emptyCount} empty chat${emptyCount === 1 ? '' : 's'}? No messages are lost.`)) {
                onClean();
              }
            }}
          >
            Clean empty ({emptyCount})
          </button>
        )}
      </div>
      <div className="session-rows" role="list" aria-label="Chat history">
        {visible.length === 0 && <p className="muted">{q === '' ? 'No chats yet — start one above.' : 'No chats match that filter.'}</p>}
        {visible.map((s) => (
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
              {
                label: 'Delete chat',
                danger: true,
                confirm: `Delete "${title(menu.s)}" from your chat list? The conversation history stays in opencode's storage; only this list entry goes.`,
                onSelect: () => onDelete(menu.s),
              },
            ],
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
