import { formatDateTime } from '../lib/format';
import type { ChatSession, ID } from '@studi0/shared';

export function SessionList({
  sessions,
  currentId,
  onSelect,
  onNew,
}: {
  sessions: ChatSession[];
  currentId: ID | null;
  onSelect: (s: ChatSession) => void;
  onNew: () => void;
}) {
  const options = sessions.map((s) => ({
    id: s.id,
    label: `${formatDateTime(s.createdAt)}${s.lessonId !== null ? ' · lesson' : ''}${
      s.summaryPath !== null ? ' · rotated' : ''
    }`,
  }));
  // the current session may be newer than the fetched list (e.g. after rotation)
  if (currentId !== null && !options.some((o) => o.id === currentId)) {
    options.unshift({ id: currentId, label: 'Current chat' });
  }
  return (
    <div className="session-list">
      <button className="btn" onClick={onNew}>
        New chat
      </button>
      {options.length > 0 && (
        <>
          <label className="muted" htmlFor="chat-session">
            History
          </label>
          <select
            id="chat-session"
            value={currentId ?? ''}
            onChange={(e) => {
              const s = sessions.find((x) => x.id === e.target.value);
              if (s !== undefined) onSelect(s);
            }}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
