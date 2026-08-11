// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  isVisualViewportShellActive,
  keyboardContextForTests,
  markVisualViewportShellSettlingForTests,
  resetVisualViewportShellForTests,
} from './useVisualViewport';

describe('shared list keyboard context', () => {
  afterEach(() => {
    resetVisualViewportShellForTests();
  });

  it('marks draft input inside shared-list-add as modal', () => {
    document.body.innerHTML = `
      <div class="modal-overlay shared-list-overlay">
        <form class="shared-list-add"><input type="text" id="draft" /></form>
      </div>`;
    const input = document.getElementById('draft') as HTMLInputElement;
    input.focus();
    expect(keyboardContextForTests()).toBe('modal');
  });
});

describe('isVisualViewportShellActive (TASK-018)', () => {
  afterEach(() => {
    resetVisualViewportShellForTests();
  });

  it('is active while data-keyboard-open is set', () => {
    expect(isVisualViewportShellActive()).toBe(false);
    document.documentElement.dataset.keyboardOpen = '1';
    expect(isVisualViewportShellActive()).toBe(true);
  });

  it('stays active during post-close settle so close cannot pin', () => {
    markVisualViewportShellSettlingForTests(500);
    expect(isVisualViewportShellActive()).toBe(true);
  });

  it('is inactive after reset clears the keyboard dataset', () => {
    document.documentElement.dataset.keyboardOpen = '1';
    markVisualViewportShellSettlingForTests(500);
    resetVisualViewportShellForTests();
    expect(isVisualViewportShellActive()).toBe(false);
  });
});
