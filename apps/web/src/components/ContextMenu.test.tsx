import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
import type { MenuState } from './ContextMenu';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

function Harness({ items }: { items: MenuState['items'] }) {
  const [menu, setMenu] = useState<MenuState | null>({ x: 10, y: 10, items });
  return <ContextMenu menu={menu} onClose={() => setMenu(null)} />;
}

afterEach(cleanup);

describe('ContextMenu', () => {
  it('opens at the given position, selects an item and closes', () => {
    const onSelect = vi.fn();
    render(<Harness items={[{ label: 'Rename', onSelect }]} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('10px');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cancels on Escape without selecting', () => {
    const onSelect = vi.fn();
    render(<Harness items={[{ label: 'Rename', onSelect }]} />);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves focus with the arrow keys', () => {
    render(
      <Harness
        items={[
          { label: 'First', onSelect: () => {} },
          { label: 'Second', onSelect: () => {} },
        ]}
      />,
    );
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  });

  it('asks for confirmation in a dialog before running a confirm item, and closes even when declined', () => {
    const onSelect = vi.fn();
    render(
      <Harness
        items={[{ label: 'Delete files from disk', danger: true, confirm: 'sure?', onSelect }]}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete files from disk' }));
    // the menu closes and the in-app confirm dialog takes over
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('sure?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    // confirming runs the action
    render(
      <Harness
        items={[{ label: 'Delete files from disk', danger: true, confirm: 'sure?', onSelect }]}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete files from disk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete files from disk' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a submenu and picks a target from it', () => {
    const onPick = vi.fn();
    render(
      <Harness
        items={[
          {
            label: 'Move to group',
            submenu: [{ label: 'MATH', onSelect: onPick }, { label: 'No group' }],
          },
        ]}
      />,
    );
    expect(screen.queryByRole('menuitem', { name: 'MATH' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to group/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'MATH' }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on click-away', () => {
    render(<Harness items={[{ label: 'Rename', onSelect: () => {} }]} />);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
