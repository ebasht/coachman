import { useEffect } from 'react';

function isTextField(el: Element | null): boolean {
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
      type === ''
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

/** Real keyboards are tall; ignore Safari chrome / home-indicator noise. */
const KEYBOARD_MIN_INSET = 180;

/**
 * Idle: CSS `inset: 0` fills the screen (no vv height — that left a white gap on iPhone).
 * Keyboard: pin shell to visualViewport so the compose bar stays above the keyboard.
 */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let focusOutTimer: number | undefined;
    const retryTimers: number[] = [];

    const clearRetries = () => {
      while (retryTimers.length) window.clearTimeout(retryTimers.pop());
    };

    const clearShellVars = () => {
      const root = document.documentElement;
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-left');
      root.style.removeProperty('--vv-width');
      root.style.removeProperty('--vv-height');
      root.style.setProperty('--keyboard-offset', '0px');
      delete root.dataset.keyboardOpen;
      delete root.dataset.keyboardContext;
    };

    const sync = () => {
      const root = document.documentElement;
      const focused = isTextField(document.activeElement);
      const inset = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
      const open = focused && inset >= KEYBOARD_MIN_INSET;
      const ctx = open ? keyboardContext() : null;

      if (!open) {
        clearShellVars();
        window.scrollTo(0, 0);
        return;
      }

      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
      root.style.setProperty('--vv-left', `${Math.round(vv.offsetLeft)}px`);
      root.style.setProperty('--vv-width', `${Math.round(vv.width)}px`);
      root.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--keyboard-offset', `${Math.round(inset)}px`);
      root.dataset.keyboardOpen = '1';
      if (ctx) root.dataset.keyboardContext = ctx;
      else delete root.dataset.keyboardContext;

      window.scrollTo(0, 0);
    };

    const syncWithRetries = () => {
      clearRetries();
      sync();
      for (const ms of [16, 50, 100, 200, 350, 550]) {
        retryTimers.push(window.setTimeout(sync, ms));
      }
    };

    const onFocusIn = () => {
      window.clearTimeout(focusOutTimer);
      syncWithRetries();
    };

    const onFocusOut = () => {
      clearRetries();
      focusOutTimer = window.setTimeout(sync, 180);
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(focusOutTimer);
      clearRetries();
      clearShellVars();
    };
  }, [enabled]);
}
