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

const KEYBOARD_MIN_INSET = 180;

/**
 * Idle layout uses CSS inset:0 (full screen). Do NOT set --app-height while idle:
 * window.innerHeight is often shorter than the painted screen on iPhone, which
 * left a white strip under the compose bar.
 * Only while the keyboard is open we shrink the shell to visualViewport.
 */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;

    let focusOutTimer: number | undefined;
    const retryTimers: number[] = [];

    const clearRetries = () => {
      while (retryTimers.length) window.clearTimeout(retryTimers.pop());
    };

    const clearKeyboardShell = () => {
      const root = document.documentElement;
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
      root.style.setProperty('--keyboard-offset', '0px');
      delete root.dataset.keyboardOpen;
      delete root.dataset.keyboardContext;
    };

    const sync = () => {
      const root = document.documentElement;
      const focused = isTextField(document.activeElement);
      const vvHeight = vv ? vv.height : window.innerHeight;
      const vvTop = vv ? vv.offsetTop : 0;
      const inset = Math.max(0, window.innerHeight - (vvTop + vvHeight));
      const open = Boolean(vv) && focused && inset >= KEYBOARD_MIN_INSET;
      const ctx = open ? keyboardContext() : null;

      if (open && vv) {
        root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
        root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
        root.style.setProperty('--keyboard-offset', `${Math.round(inset)}px`);
        root.dataset.keyboardOpen = '1';
        if (ctx) root.dataset.keyboardContext = ctx;
        else delete root.dataset.keyboardContext;
      } else {
        clearKeyboardShell();
      }

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

    clearKeyboardShell();
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', syncWithRetries);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', syncWithRetries);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(focusOutTimer);
      clearRetries();
      clearKeyboardShell();
    };
  }, [enabled]);
}
