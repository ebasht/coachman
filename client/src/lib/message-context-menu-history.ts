/**
 * History stack ownership for the message context menu (MOB-071).
 *
 * System Back must close the menu before leaving the chat. Backdrop / Escape /
 * action dismiss must pop the menu history entry (not replaceState), otherwise
 * the next Back is a no-op phantom step.
 *
 * React Strict Mode remounts are handled with a deferred pop: if the effect
 * remounts before the timeout, we keep the existing menu marker and skip the
 * extra push / pop.
 */

import { CONTEXT_MENU_HISTORY_KEY, isContextMenuHistoryState } from './message-context-menu';

type ShellishState = {
  appShell?: boolean;
  idx?: number;
  [CONTEXT_MENU_HISTORY_KEY]?: boolean;
};

let menuHistoryAlive = false;
let menuHistoryEpoch = 0;

/** Test seam — reset module guards between cases. */
export function resetContextMenuHistoryForTests(): void {
  menuHistoryAlive = false;
  menuHistoryEpoch = 0;
}

function baseShellState(state: unknown): ShellishState {
  if (
    state &&
    typeof state === 'object' &&
    (state as ShellishState).appShell === true &&
    typeof (state as ShellishState).idx === 'number'
  ) {
    return {
      appShell: true,
      idx: (state as ShellishState).idx,
    };
  }
  return { appShell: true, idx: 1 };
}

/**
 * Push a menu marker (once) when the menu mounts.
 * Returns the epoch used for the matching {@link releaseContextMenuHistory}.
 */
export function claimContextMenuHistory(
  win: Window = window,
): { epoch: number } {
  menuHistoryAlive = true;
  const epoch = ++menuHistoryEpoch;
  if (!isContextMenuHistoryState(win.history.state)) {
    const marker: ShellishState = {
      ...baseShellState(win.history.state),
      [CONTEXT_MENU_HISTORY_KEY]: true,
    };
    win.history.pushState(marker, '');
  }
  return { epoch };
}

/**
 * Release the menu history entry on unmount.
 * - System Back already popped → no-op.
 * - Strict Mode remount → keep marker.
 * - Real dismiss → deferred history.back() so length shrinks.
 */
export function releaseContextMenuHistory(
  input: { epoch: number; closedViaPop: boolean },
  win: Window = window,
  schedule: (fn: () => void) => void = (fn) => {
    win.setTimeout(fn, 0);
  },
): void {
  menuHistoryAlive = false;
  if (input.closedViaPop) return;
  const epoch = input.epoch;
  schedule(() => {
    // Remounted (Strict Mode or rapid re-open) — new owner keeps the marker.
    if (menuHistoryAlive) return;
    // A newer claim superseded this release.
    if (menuHistoryEpoch !== epoch) return;
    if (!isContextMenuHistoryState(win.history.state)) return;
    win.history.back();
  });
}
