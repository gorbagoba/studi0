import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function initial(): Theme {
  const stored = localStorage.getItem('studi0-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return 'dark'; // Blackboard identity: the board is the default until toggled
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('studi0-theme', theme);
  }, [theme]);
  return (
    <button
      type="button"
      className="btn btn-small theme-toggle"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  );
}
