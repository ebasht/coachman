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

/** Keeps layout aligned with the visible area when the iOS keyboard opens. */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let baselineHeight = vv.height;
    let focusOutTimer: number | undefined;

    const sync = () => {
      const root = document.documentElement;
      const focused = isTextField(document.activeElement);

      if (!focused) {
        baselineHeight = Math.max(baselineHeight, vv.height);
      }

      const heightLoss = baselineHeight - vv.height;
      const keyboardOpen = focused && heightLoss > 120;

      if (keyboardOpen) {
        const keyboardInset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
        root.dataset.keyboardOpen = '1';
        root.style.setProperty('--vv-offset-top', `${vv.offsetTop}px`);
        root.style.setProperty('--vv-offset-left', `${vv.offsetLeft}px`);
        root.style.setProperty('--vv-width', `${vv.width}px`);
        root.style.setProperty('--vv-height', `${vv.height}px`);
        root.style.setProperty('--vv-keyboard-inset', `${keyboardInset}px`);

        const ctx = keyboardContext();
        if (ctx) {
          root.dataset.keyboardContext = ctx;
        } else {
          delete root.dataset.keyboardContext;
        }

        // iOS scrolls the layout viewport when focusing inputs — keep the shell pinned.
        window.scrollTo(0, 0);
      } else {
        delete root.dataset.keyboardOpen;
        delete root.dataset.keyboardContext;
        root.style.setProperty('--vv-offset-top', '0px');
        root.style.setProperty('--vv-offset-left', '0px');
        root.style.removeProperty('--vv-width');
        root.style.removeProperty('--vv-height');
        root.style.removeProperty('--vv-keyboard-inset');
      }
    };

    const onFocusIn = () => {
      window.clearTimeout(focusOutTimer);
      baselineHeight = vv.height;
      sync();
    };

    const onFocusOut = () => {
      focusOutTimer = window.setTimeout(sync, 120);
    };

    const onOrientationChange = () => {
      baselineHeight = vv.height;
      sync();
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('orientationchange', onOrientationChange);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('orientationchange', onOrientationChange);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(focusOutTimer);
      const root = document.documentElement;
      delete root.dataset.keyboardOpen;
      delete root.dataset.keyboardContext;
      root.style.removeProperty('--vv-offset-top');
      root.style.removeProperty('--vv-offset-left');
      root.style.removeProperty('--vv-width');
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-keyboard-inset');
    };
  }, [enabled]);
}
