export type AppPanel = 'group' | 'invite' | 'users' | 'settings';

export interface AppRoute {
  chatId: string | null;
  panel: AppPanel | null;
}

const PANELS = new Set<AppPanel>(['group', 'invite', 'users', 'settings']);

export function parseRoute(pathname: string, search: string): AppRoute {
  const params = new URLSearchParams(search);
  const panelRaw = params.get('panel');
  const panel = PANELS.has(panelRaw as AppPanel) ? (panelRaw as AppPanel) : null;

  const match = pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    return { chatId: decodeURIComponent(match[1]), panel };
  }

  if (pathname === '/' || pathname === '') {
    return { chatId: null, panel };
  }

  return { chatId: null, panel: null };
}

export function buildPath(route: AppRoute, search = ''): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  params.delete('panel');
  if (route.panel) params.set('panel', route.panel);

  const qs = params.toString();
  const path = route.chatId ? `/c/${encodeURIComponent(route.chatId)}` : '/';
  return qs ? `${path}?${qs}` : path;
}

export function routesEqual(a: AppRoute, b: AppRoute): boolean {
  return a.chatId === b.chatId && a.panel === b.panel;
}
