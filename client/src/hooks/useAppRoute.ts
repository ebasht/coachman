import { useCallback, useEffect, useState } from 'react';
import { buildPath, parseRoute, routesEqual, type AppRoute } from '../lib/routes';

function readRoute(): AppRoute {
  return parseRoute(window.location.pathname, window.location.search);
}

export function useAppRoute(stripAuthParams: boolean) {
  const [route, setRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback(
    (next: AppRoute, opts?: { replace?: boolean }) => {
      let search = window.location.search;
      if (stripAuthParams) {
        const params = new URLSearchParams(search);
        params.delete('invite');
        params.delete('bootstrap');
        search = params.toString() ? `?${params}` : '';
      }

      const url = buildPath(next, search);
      const current = buildPath(readRoute(), window.location.search);
      if (url === current) {
        if (!routesEqual(route, next)) setRoute(next);
        return;
      }

      if (opts?.replace) {
        window.history.replaceState(null, '', url);
      } else {
        window.history.pushState(null, '', url);
      }
      setRoute(next);
    },
    [route, stripAuthParams],
  );

  return { route, navigate };
}
