import { useCallback, useEffect, useRef, useState } from 'react';
import { buildPath, parseRoute, routesEqual, type AppRoute } from '../lib/routes';

type ShellState = {
  appShell: true;
  /** Depth within the in-app stack (0 = chat list). */
  idx: number;
};

function readRoute(): AppRoute {
  return parseRoute(window.location.pathname, window.location.search);
}

function cleanSearch(search: string, stripAuthParams: boolean): string {
  if (!stripAuthParams) return search;
  const params = new URLSearchParams(search);
  params.delete('invite');
  params.delete('bootstrap');
  return params.toString() ? `?${params}` : '';
}

function shellState(idx: number): ShellState {
  return { appShell: true, idx };
}

function currentIdx(): number {
  const state = window.history.state as ShellState | null;
  return state?.appShell && typeof state.idx === 'number' ? state.idx : 0;
}

function isShellState(state: unknown): state is ShellState {
  return !!state && typeof state === 'object' && (state as ShellState).appShell === true;
}

/** Ensure a single bootstrap of the app history stack (survives React StrictMode). */
let historyBootstrapped = false;

/**
 * App-like history:
 * - chat list is always the root (idx 0)
 * - opening a chat / panel pushes
 * - switching chats replaces (back still returns to the list)
 * - closing chat/panel pops (or replaces if there is nothing to pop)
 * - backing past the app root stays on the chat list
 */
export function useAppRoute(stripAuthParams: boolean) {
  const [route, setRoute] = useState<AppRoute>(readRoute);
  const stripRef = useRef(stripAuthParams);
  stripRef.current = stripAuthParams;

  useEffect(() => {
    const onPopState = () => {
      if (!isShellState(window.history.state)) {
        const search = cleanSearch(window.location.search, stripRef.current);
        const listUrl = buildPath({ chatId: null, panel: null }, search);
        window.history.pushState(shellState(0), '', listUrl);
        setRoute({ chatId: null, panel: null });
        return;
      }
      setRoute(readRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (historyBootstrapped) return;
    historyBootstrapped = true;

    const search = cleanSearch(window.location.search, stripAuthParams);
    const current = readRoute();
    const listUrl = buildPath({ chatId: null, panel: null }, search);
    const currentUrl = buildPath(current, search);

    if (current.chatId || current.panel) {
      // Deep link / reload inside a chat: put the list underneath so swipe-back works.
      window.history.replaceState(shellState(0), '', listUrl);
      window.history.pushState(shellState(1), '', currentUrl);
      setRoute(current);
      return;
    }

    window.history.replaceState(shellState(0), '', currentUrl || listUrl);
  }, [stripAuthParams]);

  const navigate = useCallback(
    (next: AppRoute, opts?: { replace?: boolean }) => {
      const search = cleanSearch(window.location.search, stripAuthParams);
      const url = buildPath(next, search);
      const cur = readRoute();
      const curUrl = buildPath(cur, search);

      if (url === curUrl) {
        if (!routesEqual(route, next)) setRoute(next);
        if (!isShellState(window.history.state)) {
          window.history.replaceState(shellState(currentIdx()), '', url);
        }
        return;
      }

      if (opts?.replace) {
        const idx = !next.chatId && !next.panel ? 0 : Math.max(1, currentIdx());
        window.history.replaceState(shellState(idx), '', url);
        setRoute(next);
        return;
      }

      const goingToList = !next.chatId && !next.panel;
      const closingPanelOnly =
        !!cur.panel && !next.panel && !!next.chatId && next.chatId === cur.chatId;

      // UI / gesture "back to chats"
      if (goingToList && (cur.chatId || cur.panel)) {
        const idx = currentIdx();
        if (idx > 0) {
          window.history.go(-idx);
          return;
        }
        window.history.replaceState(shellState(0), '', url);
        setRoute(next);
        return;
      }

      // Close settings/group/etc. overlay
      if (closingPanelOnly) {
        if (currentIdx() > 0) {
          window.history.back();
          return;
        }
        window.history.replaceState(shellState(Math.max(1, currentIdx())), '', url);
        setRoute(next);
        return;
      }

      // Open or switch chat (keeps a single chat frame above the list)
      if (next.chatId && !next.panel) {
        if (!cur.chatId && !cur.panel) {
          window.history.pushState(shellState(currentIdx() + 1), '', url);
          setRoute(next);
          return;
        }
        window.history.replaceState(shellState(Math.max(1, currentIdx())), '', url);
        setRoute(next);
        return;
      }

      // Open a panel (or change panel)
      if (next.panel) {
        if (cur.panel) {
          window.history.replaceState(shellState(Math.max(1, currentIdx())), '', url);
        } else {
          window.history.pushState(shellState(currentIdx() + 1), '', url);
        }
        setRoute(next);
        return;
      }

      window.history.pushState(shellState(currentIdx() + 1), '', url);
      setRoute(next);
    },
    [route, stripAuthParams],
  );

  return { route, navigate };
}
