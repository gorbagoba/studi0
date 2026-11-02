import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function initial(): Theme {
  const stored = localStorage.getItem('studi0-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return 'dark'; // Blackboard identity: the board is the default until toggled
}

export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('studi0-theme', theme);
  }, [theme]);
  const glyph = theme === 'dark' ? '☀' : '☾';
  return (
    <button
      type="button"
      className={iconOnly ? 'icon-btn' : 'btn btn-small'}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      {iconOnly ? glyph : `${glyph} ${theme === 'dark' ? 'Light' : 'Dark'}`}
    </button>
  );
}
