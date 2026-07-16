import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell around the existing Vite/React PWA.
 *
 * CAP_SERVER_URL — live site the WebView loads (relative /api works).
 * Set in client/.env (loaded by android:sync) or export in the shell.
 * Default: production.
 */
const DEFAULT_SERVER_URL = 'https://coachman.eugen-bash.com/';

function normalizeServerUrl(raw: string | undefined): string {
  const url = (raw ?? '').trim() || DEFAULT_SERVER_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

const serverUrl = normalizeServerUrl(process.env.CAP_SERVER_URL);

const config: CapacitorConfig = {
  appId: 'com.coachman.app',
  appName: 'Ямщик',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    url: serverUrl,
    cleartext: serverUrl.startsWith('http://'),
    allowNavigation: [serverUrl.replace(/\/$/, ''), 'https://coachman.eugen-bash.com'],
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#ffffff',
  },
};

export default config;
