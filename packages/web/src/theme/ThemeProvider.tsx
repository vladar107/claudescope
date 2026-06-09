/**
 * Theme state: a tri-state choice (`system` | `light` | `dark`) that resolves to
 * a concrete `light`/`dark` applied to `document.documentElement[data-theme]`.
 *
 * The actual paint-time application happens in a tiny inline script in
 * index.html (so there's no flash of the wrong theme before React mounts); this
 * provider keeps the React tree in sync, persists the explicit choice to
 * localStorage, and tracks OS changes while in `system` mode. `resolvedTheme`
 * is consumed by non-CSS theming (Shiki, Recharts).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key — kept in sync with the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = 'claudescope-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* localStorage may be unavailable (private mode) — fall through */
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia !== 'undefined' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readStored);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolve(theme));

  // Apply the resolved theme to <html>, and (only while in `system`) keep it in
  // sync with OS appearance changes.
  useEffect(() => {
    const apply = () => {
      const r = resolve(theme);
      setResolvedTheme(r);
      document.documentElement.dataset.theme = r;
    };
    apply();
    if (theme !== 'system') return;
    const mq = matchMedia(DARK_QUERY);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = (t: ThemeChoice) => {
    setThemeState(t);
    try {
      // Absence of the key means "follow system"; an explicit value pins it.
      if (t === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* ignore persistence failures */
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
