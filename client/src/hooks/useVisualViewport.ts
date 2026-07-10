import { useEffect } from 'react';

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    return (
      type === 'text' ||
      type === 'search' ||
      type === 'email' ||
      type === 'password' ||
      type === 'tel' ||
      type === 'url' ||
      type === 'number' ||
      type === '' ||
      type === 'textarea'
    );
  }
  return el.getAttribute('contenteditable') === 'true';
}

function keyboardContext(): 'chat' | 'modal' | null {
  const el = document.activeElement;
  if (!el) return null;
  if (el.closest('.chat-compose')) return 'chat';
  if (el.closest('.modal-overlay')) return 'modal';
  return null;
}

/**
 * Shrinks the app shell to the visual viewport when the on-screen keyboard opens
 * (needed with interactive-widget=overlays-content on Android/iOS).
 */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;

    // Height with keyboard closed — never reset this on focus (Android shrinks vv first).
    let baselineHeight = Math.max(window.innerHeight, vv.height);
    let focusOutTimer: number | undefined;
    const syncTimers: number[] = [];

    const clearSyncTimers = () => {
      while (syncTimers.length) {
        window.clearTimeout(syncTimers.pop());
      }
    };

    const applyClosed = (root: HTMLElement) => {
      delete root.dataset.keyboardOpen;
      delete root.dataset.keyboardContext;
      root.style.setProperty('--vv-offset-top', '0px');
      root.style.setProperty('--vv-offset-left', '0px');
      root.style.removeProperty('--vv-width');
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-keyboard-inset');
    };

    const sync = () => {
      const root = document.documentElement;
      const focused = isTextField(document.activeElement);

      if (!focused) {
        baselineHeight = Math.max(baselineHeight, window.innerHeight, vv.height);
        applyClosed(root);
        return;
      }

      const heightLoss = baselineHeight - vv.height;
      const keyboardInset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      // Android often reports a smaller loss during the open animation; use either signal.
      const keyboardOpen = heightLoss > 80 || keyboardInset > 80;

      if (!keyboardOpen) {
        applyClosed(root);
        return;
      }

      root.dataset.keyboardOpen = '1';
      root.style.setProperty('--vv-offset-top', `${vv.offsetTop}px`);
      root.style.setProperty('--vv-offset-left', `${vv.offsetLeft}px`);
      root.style.setProperty('--vv-width', `${vv.width}px`);
      root.style.setProperty('--vv-height', `${vv.height}px`);
      root.style.setProperty('--vv-keyboard-inset', `${keyboardInset}px`);

      const ctx = keyboardContext();
      if (ctx) root.dataset.keyboardContext = ctx;
      else delete root.dataset.keyboardContext;

      // Keep layout viewport pinned; otherwise iOS/Android may scroll the page under the keyboard.
      window.scrollTo(0, 0);

      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        // After shell resize, ensure the focused field stays in the visible area.
        requestAnimationFrame(() => {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }
    };

    const scheduleSync = () => {
      clearSyncTimers();
      sync();
      // Android Chrome opens the keyboard after focus; re-measure during the animation.
      for (const ms of [50, 150, 300, 500]) {
        syncTimers.push(window.setTimeout(sync, ms));
      }
    };

    const onFocusIn = () => {
      window.clearTimeout(focusOutTimer);
      scheduleSync();
    };

    const onFocusOut = () => {
      clearSyncTimers();
      focusOutTimer = window.setTimeout(sync, 150);
    };

    const onOrientationChange = () => {
      baselineHeight = Math.max(window.innerHeight, vv.height);
      sync();
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('orientationchange', onOrientationChange);
    window.addEventListener('resize', sync);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('orientationchange', onOrientationChange);
      window.removeEventListener('resize', sync);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(focusOutTimer);
      clearSyncTimers();
      applyClosed(document.documentElement);
    };
  }, [enabled]);
}
