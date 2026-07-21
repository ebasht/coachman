import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

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

function detectKeyboardContext(): 'chat' | 'modal' | null {
  const el = document.activeElement;
  if (!el) return null;
  if (el.closest('.chat-compose')) return 'chat';
  if (el.closest('.shared-list-add')) return 'modal';
  if (el.closest('.modal-overlay')) return 'modal';
  return null;
}

/** @internal exported for tests */
export const keyboardContextForTests = detectKeyboardContext;

const KEYBOARD_MIN_INSET = 80;

function isAndroidShell(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return true;
  return /Android/i.test(navigator.userAgent);
}

/**
 * Keep the app shell inside the visual viewport while the soft keyboard is open.
 *
 * iOS Safari / PWA: keyboard overlays layout; we size .app to visualViewport.
 * Android (Capacitor adjustResize / Chrome): skip — combining this with layout
 * resize double-counts the IME and collapses the todo sheet to «Список» + ×.
 */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled || isAndroidShell()) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let focusOutTimer: number | undefined;
    const retryTimers: number[] = [];
    let baselineHeight = Math.max(window.innerHeight, vv.height);

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
      const layoutHeight = window.innerHeight;
      const vvHeight = vv.height;
      const vvTop = vv.offsetTop;
      const scrollY = window.scrollY || document.documentElement.scrollTop || 0;

      if (!focused) {
        baselineHeight = Math.max(baselineHeight, layoutHeight, vvHeight);
      }

      const insetFromVv = Math.max(0, layoutHeight - vvHeight - vvTop);
      const insetFromScroll = focused ? Math.max(0, scrollY + vvTop) : 0;
      const insetFromBaseline = focused ? Math.max(0, baselineHeight - layoutHeight) : 0;

      const inset = Math.max(insetFromVv, insetFromScroll, insetFromBaseline);
      const open = focused && inset >= KEYBOARD_MIN_INSET;
      const ctx = open ? detectKeyboardContext() : null;

      if (open) {
        const shellTop = Math.round(vvTop);
        const shellHeight = Math.round(Math.min(vvHeight, layoutHeight));
        root.style.setProperty('--app-top', `${shellTop}px`);
        root.style.setProperty('--app-height', `${Math.max(shellHeight, 200)}px`);
        root.style.setProperty('--keyboard-offset', `${Math.round(inset)}px`);
        root.dataset.keyboardOpen = '1';
        if (ctx) root.dataset.keyboardContext = ctx;
        else delete root.dataset.keyboardContext;

        if (scrollY !== 0) {
          window.scrollTo(0, 0);
        }
      } else {
        clearKeyboardShell();
        if (scrollY !== 0) window.scrollTo(0, 0);
      }
    };

    const syncWithRetries = () => {
      clearRetries();
      sync();
      for (const ms of [16, 50, 100, 150, 250, 400, 600, 900]) {
        retryTimers.push(window.setTimeout(sync, ms));
      }
    };

    const onFocusIn = () => {
      window.clearTimeout(focusOutTimer);
      syncWithRetries();
    };

    const onFocusOut = () => {
      clearRetries();
      focusOutTimer = window.setTimeout(() => {
        sync();
      }, 200);
    };

    clearKeyboardShell();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', syncWithRetries);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
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
