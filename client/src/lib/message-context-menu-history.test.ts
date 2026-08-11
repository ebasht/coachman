// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimContextMenuHistory,
  releaseContextMenuHistory,
  resetContextMenuHistoryForTests,
} from './message-context-menu-history';
import { isContextMenuHistoryState } from './message-context-menu';

describe('context menu history (MOB-071)', () => {
  afterEach(() => {
    resetContextMenuHistoryForTests();
    vi.useRealTimers();
    // Reset jsdom history to a known shell root.
    window.history.replaceState({ appShell: true, idx: 1 }, '', '/chat/c1');
  });

  it('system Back pops the menu marker (closedViaPop)', () => {
    window.history.replaceState({ appShell: true, idx: 1 }, '', '/chat/c1');
    const { epoch } = claimContextMenuHistory();
    expect(isContextMenuHistoryState(window.history.state)).toBe(true);

    // Simulate popstate from system Back (jsdom history.back is unreliable here).
    window.history.replaceState({ appShell: true, idx: 1 }, '', '/chat/c1');
    expect(isContextMenuHistoryState(window.history.state)).toBe(false);

    releaseContextMenuHistory({ epoch, closedViaPop: true });
    // No deferred back — stack stays on chat shell.
    expect(window.history.state).toEqual({ appShell: true, idx: 1 });
  });

  it('backdrop dismiss pops the history entry (no phantom Back)', () => {
    vi.useFakeTimers();
    window.history.replaceState({ appShell: true, idx: 0 }, '', '/');
    window.history.pushState({ appShell: true, idx: 1 }, '', '/chat/c1');
    const depthBefore = window.history.length;

    const { epoch } = claimContextMenuHistory();
    expect(isContextMenuHistoryState(window.history.state)).toBe(true);
    expect(window.history.length).toBeGreaterThanOrEqual(depthBefore);

    releaseContextMenuHistory({ epoch, closedViaPop: false });
    vi.runAllTimers();

    expect(isContextMenuHistoryState(window.history.state)).toBe(false);
    expect(window.history.state).toEqual({ appShell: true, idx: 1 });
  });

  it('Strict Mode remount does not double-push or premature-pop', () => {
    vi.useFakeTimers();
    window.history.replaceState({ appShell: true, idx: 1 }, '', '/chat/c1');

    const first = claimContextMenuHistory();
    // Simulate Strict Mode cleanup + remount before the deferred pop runs.
    releaseContextMenuHistory({ epoch: first.epoch, closedViaPop: false });
    const second = claimContextMenuHistory();
    vi.runAllTimers();

    // Still on a single menu marker after remount.
    expect(isContextMenuHistoryState(window.history.state)).toBe(true);

    releaseContextMenuHistory({ epoch: second.epoch, closedViaPop: false });
    vi.runAllTimers();
    expect(isContextMenuHistoryState(window.history.state)).toBe(false);
  });
});
