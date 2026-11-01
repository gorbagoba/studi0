import { useEffect, useRef } from 'react';
import 'emoji-picker-element';
import { createPortal } from 'react-dom';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace React.JSX {
    interface IntrinsicElements {
      'emoji-picker': Record<string, string>;
    }
  }
}

/**
 * Centered emoji-picker modal (emoji-picker-element web component, lazy ~150KB).
 * The element is registered once on import; picking fires 'emoji-click'.
 */
export function EmojiPickerModal({
  subjectName,
  onSelect,
  onClose,
}: {
  subjectName: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const picker = rootRef.current?.querySelector('emoji-picker');
    if (picker === null) return;
    const el = picker as EventTarget;
    const onPick = (e: Event): void => {
      const detail = (e as CustomEvent<{ emoji: { unicode: string } }>).detail;
      if (detail?.emoji?.unicode !== undefined) {
        onSelectRef.current(detail.emoji.unicode);
        onCloseRef.current();
      }
    };
    el.addEventListener('emoji-click', onPick);
    return () => el.removeEventListener('emoji-click', onPick);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className="emoji-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={rootRef}
        className="emoji-modal"
        role="dialog"
        aria-label={`Pick an icon for ${subjectName}`}
      >
        <h4>Pick an icon — {subjectName}</h4>
        <emoji-picker class="emoji-picker-el" />
      </div>
    </div>,
    document.body,
  );
}
