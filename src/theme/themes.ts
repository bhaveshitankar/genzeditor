// Theme system: each theme is applied by setting `data-theme` on <html>. The
// actual colors live in CSS (html[data-theme="…"] blocks in app.css) so both the
// app chrome AND the CodeMirror editor (which reads --cm-* CSS variables) update
// live via the cascade — no editor teardown needed on theme change. Animated
// themes add a moving-gradient backdrop via body::before, gated by
// prefers-reduced-motion in CSS.

export interface ThemeDef {
  id: string;
  label: string;
  /** Small preview swatch: [background, accent] used in the picker. */
  swatch: [string, string];
  animated?: boolean;
}

export const THEMES: ThemeDef[] = [
  { id: 'system', label: 'System', swatch: ['#F3F1FA', '#FF4D8D'] },
  { id: 'aurora', label: 'Midnight Aurora', swatch: ['#0b1020', '#7c5cff'], animated: true },
  { id: 'sunset', label: 'Sunset', swatch: ['#1a1024', '#ff7a59'], animated: true },
  { id: 'ocean', label: 'Ocean', swatch: ['#071a2b', '#22d3ee'], animated: true },
  { id: 'dracula', label: 'Dracula', swatch: ['#282a36', '#bd93f9'] },
  { id: 'solarized', label: 'Solarized', swatch: ['#fdf6e3', '#268bd2'] },
  { id: 'forest', label: 'Forest', swatch: ['#0f1c14', '#34d399'], animated: true },
];

const STORAGE_KEY = 'genzeditor.theme';

export function getSavedTheme(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  const root = document.documentElement;
  if (theme.id === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme.id);
  }
  root.toggleAttribute('data-theme-animated', !!theme.animated);
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    /* private mode / storage disabled — theme still applies for this session */
  }
}

/** Apply the persisted theme on boot. Call once from main. */
export function initTheme(): void {
  applyTheme(getSavedTheme());
}
