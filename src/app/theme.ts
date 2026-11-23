import { useEffect, useState } from 'preact/hooks';

export type Theme = 'light' | 'dark';

/** localStorage key; also read by the inline pre-paint script in src/pages/index.astro. */
export const THEME_KEY = 'psindex-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null; // storage blocked
  }
}

/** Store the override and apply it to <html data-theme>. */
function writeTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}

/**
 * The theme on screen: a stored override if the user picked one, else the OS preference,
 * kept live as the OS setting changes. `toggle` stores the opposite as the new override.
 */
export function useTheme() {
  const [override, setOverride] = useState<Theme | null>(readTheme);
  const [osDark, setOsDark] = useState(() => matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const theme: Theme = override ?? (osDark ? 'dark' : 'light');
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    writeTheme(next);
    setOverride(next);
  };
  return { theme, toggle };
}
