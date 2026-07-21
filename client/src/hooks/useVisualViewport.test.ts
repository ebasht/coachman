// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { keyboardContextForTests } from './useVisualViewport';

describe('shared list keyboard context', () => {
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
