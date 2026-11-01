import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  /** window.confirm text shown before onSelect runs */
  confirm?: string;
  danger?: boolean;
  onSelect?: () => void;
  /** renders a second panel listing the nested items; the parent item itself has no action */
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Portal-rendered menu (right-click position or anchored to a kebab button).
 * Keyboard: ArrowUp/Down move between visible items, Enter activates,
 * Escape closes an open submenu first, then the menu.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [subOpen, setSubOpen] = useState<number | null>(null);

  useEffect(() => {
    if (menu === null) return;
    setSubOpen(null);
    openerRef.current = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
  }, [menu]);

  function close(restoreFocus = true) {
    onClose();
    if (restoreFocus) openerRef.current?.focus();
  }

  // click-away (right-clicking elsewhere reopens via the parent before this fires)
  useEffect(() => {
    if (menu === null) return;
    const away = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu, onClose]);

  // clamp into the viewport once rendered
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (menu === null || root === null) return;
    const r = root.getBoundingClientRect();
    root.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    root.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
  }, [menu]);

  function runItem(item: MenuItem) {
    close();
    if (item.confirm !== undefined && !window.confirm(item.confirm)) return;
    item.onSelect?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    const root = rootRef.current;
    if (root === null) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (subOpen !== null) setSubOpen(null);
      else close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('button.ctx-item'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? items[(current + 1) % items.length]
        : items[(current - 1 + items.length) % items.length];
    next?.focus();
  }

  if (menu === null) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
    >
      {menu.items.map((item, i) =>
        item.submenu !== undefined ? (
          <div
            key={item.label}
            className="ctx-sub"
            onMouseEnter={() => setSubOpen(i)}
            onMouseLeave={() => setSubOpen(null)}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="ctx-item"
              aria-haspopup="true"
              aria-expanded={subOpen === i}
              onClick={() => setSubOpen(i)}
            >
              {item.label} ▸
            </button>
            {subOpen === i && (
              <div className="ctx-menu ctx-submenu" role="menu" aria-label={item.label}>
                {item.submenu.map((sub) => (
                  <button
                    key={sub.label}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`ctx-item${sub.danger ? ' danger' : ''}`}
                    onClick={() => runItem(sub)}
                  >
                    {sub.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            onMouseEnter={() => setSubOpen(null)}
            onClick={() => runItem(item)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
