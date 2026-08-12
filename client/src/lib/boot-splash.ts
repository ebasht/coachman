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

export function hideBootSplash(opts?: { immediate?: boolean }): void {
  if (hidden || typeof document === 'undefined') return;
  hidden = true;
  const el = document.getElementById('boot-splash');
  if (!el) return;

  const elapsed = startedAt ? performance.now() - startedAt : MIN_VISIBLE_MS;
  const wait = opts?.immediate ? 0 : Math.max(0, MIN_VISIBLE_MS - elapsed);

  window.setTimeout(() => {
    el.classList.add('is-done');
    el.setAttribute('aria-busy', 'false');
    window.setTimeout(() => {
      el.remove();
    }, FADE_MS);
  }, wait);
}
