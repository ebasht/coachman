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

/**
 * Lifts the app above the on-screen keyboard via --keyboard-offset.
 * Works with interactive-widget=overlays-content (Android) and iOS Safari.
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

    const setOffset = (px: number, ctx: 'chat' | 'modal' | null) => {
      const root = document.documentElement;
      const value = Math.max(0, Math.round(px));
      root.style.setProperty('--keyboard-offset', `${value}px`);
      if (value > 40) {
        root.dataset.keyboardOpen = '1';
        if (ctx) root.dataset.keyboardContext = ctx;
        else delete root.dataset.keyboardContext;
      } else {
        delete root.dataset.keyboardOpen;
        delete root.dataset.keyboardContext;
      }
    };

    const measure = () => {
      const focused = isTextField(document.activeElement);
      if (!focused) {
        setOffset(0, null);
        return;
      }

      // Layout viewport bottom minus visual viewport bottom = covered by keyboard (and browser UI).
      const layoutBottom = window.innerHeight;
      const visualBottom = vv.offsetTop + vv.height;
      const inset = Math.max(0, layoutBottom - visualBottom);

      // Fallback if innerHeight already shrank with the keyboard (resizes-content).
      const altInset = Math.max(0, document.documentElement.clientHeight - vv.height - vv.offsetTop);
      const offset = Math.max(inset, altInset);

      setOffset(offset, keyboardContext());
      window.scrollTo(0, 0);
    };

    const measureWithRetries = () => {
      clearRetries();
      measure();
      for (const ms of [16, 50, 100, 200, 350, 550]) {
        retryTimers.push(window.setTimeout(measure, ms));
      }
    };

    const onFocusIn = () => {
      window.clearTimeout(focusOutTimer);
      measureWithRetries();
    };

    const onFocusOut = () => {
      clearRetries();
      focusOutTimer = window.setTimeout(measure, 180);
    };

    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(focusOutTimer);
      clearRetries();
      const root = document.documentElement;
      root.style.setProperty('--keyboard-offset', '0px');
      delete root.dataset.keyboardOpen;
      delete root.dataset.keyboardContext;
    };
  }, [enabled]);
}
