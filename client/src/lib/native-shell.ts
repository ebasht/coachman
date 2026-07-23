import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

/** Capacitor SystemBars only injects real --safe-area-inset-* when viewport-fit=cover. */
function enableAndroidSafeAreaViewport() {
  document.documentElement.classList.add('native-android');
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.getAttribute('content') || '';
  if (/viewport-fit\s*=/.test(content)) return;
  meta.setAttribute('content', `${content.replace(/\s+$/, '')}, viewport-fit=cover`);
}

/** Native shell hooks — no-ops in browser/PWA. */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  if (Capacitor.getPlatform() === 'android') {
    enableAndroidSafeAreaViewport();
    try {
      // Pre–Android 15: keep WebView below the status bar.
      // Android 15+: no-op; CSS safe-area insets handle edge-to-edge.
      await StatusBar.setOverlaysWebView({ overlay: false });
    } catch {
      // ignore
    }
  }

  try {
    await SplashScreen.hide();
  } catch {
    // ignore
  }

  // Theme module owns StatusBar colors; re-apply after shell init in case of race.
  try {
    const { applyTheme } = await import('./theme');
    applyTheme();
  } catch {
    // ignore
  }

  // Android back button: leave to WebView history; exit only at root.
  CapApp.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void CapApp.exitApp();
  });
}
