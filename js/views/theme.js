/**
 * theme.js: applies the color theme. The choice is mirrored to localStorage so boot.js can set it
 * before the first paint, avoiding a flash of the wrong theme while the database opens.
 */
const THEME_KEY = 'personal-notes:theme';

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Only the flash-free start is lost. The saved setting still applies after loading.
  }
}
