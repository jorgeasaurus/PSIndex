/** Light/dark preference: a stored override, or null to follow the OS. */
export type Theme = 'light' | 'dark';

/** localStorage key; also read by the inline pre-paint script in src/pages/index.astro. */
export const THEME_KEY = 'psindex-theme';

export function readTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null; // storage blocked
  }
}

/** Store (or clear) the override and apply it to <html data-theme>. */
export function writeTheme(theme: Theme | null) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  try { theme ? localStorage.setItem(THEME_KEY, theme) : localStorage.removeItem(THEME_KEY); } catch {}
}

/** The theme actually shown: the override, else the OS preference. */
export const effectiveTheme = (theme: Theme | null): Theme =>
  theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
