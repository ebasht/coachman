/**
 * Hide the HTML boot splash once React is ready to paint real UI.
 * Keeps a short minimum so the brand animation is readable on fast devices.
 */
const MIN_VISIBLE_MS = 700;
const FADE_MS = 340;

let startedAt = 0;
let hidden = false;

export function markBootSplashStarted(): void {
  if (!startedAt) startedAt = performance.now();
}

function finishBootChrome(): void {
  document.documentElement.classList.remove('is-booting');
  document.documentElement.style.removeProperty('background');
  if (document.body) {
    document.body.style.removeProperty('background');
    document.body.style.removeProperty('color');
    // keep margin:0 — index.css also sets layout
  }
  try {
    // Restore theme-color / status bar after navy launch chrome.
    void import('./theme').then((m) => m.applyTheme());
  } catch {
    /* ignore */
  }
}

export function hideBootSplash(opts?: { immediate?: boolean }): void {
  if (hidden || typeof document === 'undefined') return;
  hidden = true;
  const el = document.getElementById('boot-splash');
  if (!el) {
    finishBootChrome();
    return;
  }

  const elapsed = startedAt ? performance.now() - startedAt : MIN_VISIBLE_MS;
  const wait = opts?.immediate ? 0 : Math.max(0, MIN_VISIBLE_MS - elapsed);

  window.setTimeout(() => {
    el.classList.add('is-done');
    el.setAttribute('aria-busy', 'false');
    window.setTimeout(() => {
      el.remove();
      finishBootChrome();
    }, FADE_MS);
  }, wait);
}
