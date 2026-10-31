import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem('studi0-theme');
    delete document.documentElement.dataset.theme;
  });

  it('defaults to light and applies no theme attribute', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('studi0-theme')).toBe('light');
  });

  it('toggles to dark, persists, and toggles back', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('studi0-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('studi0-theme')).toBe('light');
  });

  it('restores a stored dark preference on mount', () => {
    localStorage.setItem('studi0-theme', 'dark');
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
  });
});
