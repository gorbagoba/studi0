import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

let n = 0;

function Probe() {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(`toast ${n++}`, 'ok')}>
      fire
    </button>
  );
}

describe('Toast', () => {
  beforeEach(() => {
    n = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows a toast and auto-dismisses it after 6s', () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('toast 0')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('toast 0')).toBeNull();
  });

  it('dismisses on click and caps the stack at 4', () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    const fire = screen.getByRole('button', { name: 'fire' });
    fireEvent.click(fire);
    expect(screen.getByText('toast 0')).toBeTruthy();
    fireEvent.click(screen.getByText('toast 0'));
    expect(screen.queryByText('toast 0')).toBeNull();

    for (let i = 0; i < 6; i += 1) fireEvent.click(fire);
    expect(document.querySelectorAll('.toast').length).toBe(4);
  });
});
