import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'coachman_theme';
const THEME_EVENT = 'coachman-theme';

const LIGHT_BG = '#ffffff';
const DARK_BG = '#0b0b0f';

export function getThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function resolveTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

async function syncNativeStatusBar(resolved: ResolvedTheme): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (resolved === 'dark') {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: DARK_BG });
    } else {
      await StatusBar.setStyle({ style: Style.Light });
      await StatusBar.setBackgroundColor({ color: LIGHT_BG });
    }
  } catch {
    /* ignore */
  }
}

function syncDocumentChrome(resolved: ResolvedTheme): void {
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute('content', resolved === 'dark' ? DARK_BG : LIGHT_BG);
  }
  const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (apple) {
    apple.setAttribute('content', resolved === 'dark' ? 'black-translucent' : 'default');
  }
}

/** Apply preference to <html data-theme> and native chrome. */
export function applyTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  syncDocumentChrome(resolved);
  void syncNativeStatusBar(resolved);
  return resolved;
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { preference: pref } }));
}

export function initTheme(): void {
  applyTheme();
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemePreference() === 'system') applyTheme('system');
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else {
      // Safari < 14
      mq.addListener(onChange);
    }
  } catch {
    /* ignore */
  }
}

export function subscribeThemePreference(cb: (pref: ThemePreference) => void): () => void {
  const handler = () => cb(getThemePreference());
  window.addEventListener(THEME_EVENT, handler);
  return () => window.removeEventListener(THEME_EVENT, handler);
}

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];
