import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

/** Native shell hooks — no-ops in browser/PWA. */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: '#ffffff' });
  } catch {
    // ignore — some devices reject status bar APIs
  }

  try {
    await SplashScreen.hide();
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
