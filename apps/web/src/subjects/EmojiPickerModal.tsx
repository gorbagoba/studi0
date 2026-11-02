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
 * Focus is trapped: initial focus on the modal, Tab cycles modal ⇄ picker host,
 * focus that escapes the modal (shadow-DOM internals retarget to the host) is
 * pulled back, and focus returns to the opener on close.
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

  // focus management: initial focus, trap, restore
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const opener = document.activeElement as HTMLElement | null;
    root.focus();
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
      root.focus();
    };
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusout', onFocusOut);
      opener?.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    // single cycle: modal container ⇄ picker host (shadow internals retarget to the host)
    e.preventDefault();
    if (e.target === rootRef.current) {
      rootRef.current?.querySelector<HTMLElement>('emoji-picker')?.focus();
    } else {
      rootRef.current?.focus();
    }
  }

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
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h4>Pick an icon — {subjectName}</h4>
        <emoji-picker class="emoji-picker-el" />
      </div>
    </div>,
    document.body,
  );
}
