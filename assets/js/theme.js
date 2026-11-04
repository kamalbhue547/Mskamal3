// Light/dark theme: first visit follows the system setting, an explicit choice
// made with the toggle is remembered, and the system setting is followed live
// until the visitor makes that choice.

export const THEME_KEY = 'mskamal3:theme';

// Browser UI colour per theme. Must equal --bg in styles.css (a test enforces it).
export const THEME_COLORS = { dark: '#0a0c12', light: '#f5f6fb' };

/** @param {{ stored?: string | null, prefersLight?: boolean }} input */
export function resolveTheme({ stored, prefersLight }) {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersLight ? 'light' : 'dark';
}

export const nextTheme = (theme) => (theme === 'light' ? 'dark' : 'light');

/**
 * Wires the toggle button. All environment access is injected so this can be
 * tested without a browser.
 *
 * @param {{ document: Document, storage?: Storage, matchMedia: (query: string) => MediaQueryList, button: HTMLElement }} env
 */
export function initThemeToggle({ document, storage, matchMedia, button }) {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: light)');

  const read = () => {
    try {
      return storage?.getItem(THEME_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const write = (theme) => {
    try {
      storage?.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked: the choice simply won't persist */
    }
  };

  let theme = resolveTheme({ stored: read(), prefersLight: system.matches });
  // Remembered in memory as well, so a choice still counts when storage is blocked.
  let chosen = false;

  const apply = () => {
    root.dataset.theme = theme;
    const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  };

  button.addEventListener('click', () => {
    chosen = true;
    theme = nextTheme(theme);
    write(theme);
    apply();
  });

  system.addEventListener?.('change', (event) => {
    if (!chosen && read() === null) {
      theme = event.matches ? 'light' : 'dark';
      apply();
    }
  });

  apply();
  return { get theme() { return theme; } };
}
