import { useEffect } from 'react';

/** Keeps layout aligned with the visible area when the iOS keyboard opens. */
export function useVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const sync = () => {
      const root = document.documentElement;
      root.style.setProperty('--vv-offset-top', `${vv.offsetTop}px`);
      root.style.setProperty('--vv-offset-left', `${vv.offsetLeft}px`);
      root.style.setProperty('--vv-width', `${vv.width}px`);
      root.style.setProperty('--vv-height', `${vv.height}px`);
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('orientationchange', sync);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('orientationchange', sync);
      const root = document.documentElement;
      root.style.removeProperty('--vv-offset-top');
      root.style.removeProperty('--vv-offset-left');
      root.style.removeProperty('--vv-width');
      root.style.removeProperty('--vv-height');
    };
  }, [enabled]);
}
