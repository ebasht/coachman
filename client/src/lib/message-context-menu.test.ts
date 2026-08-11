// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_CONTEXT_MENU_MARGIN_PX,
  canSaveMessageMedia,
  messageClipboardText,
  placeMessageContextMenu,
  type ViewportBounds,
} from './message-context-menu';

const viewport: ViewportBounds = {
  left: 0,
  top: 0,
  right: 390,
  bottom: 844,
  width: 390,
  height: 844,
};

describe('placeMessageContextMenu', () => {
  it('places menu below when there is room (message near header)', () => {
    const placement = placeMessageContextMenu({
      messageRect: { left: 40, top: 80, right: 280, bottom: 140, width: 240, height: 60 },
      menuSize: { width: 160, height: 132 },
      viewport,
      alignment: 'incoming',
    });
    expect(placement.placedBelow).toBe(true);
    expect(placement.menuTop).toBe(140 + MESSAGE_CONTEXT_MENU_MARGIN_PX);
    expect(placement.menuLeft).toBe(40);
    expect(placement.overlayShiftY).toBe(0);
  });

  it('places menu above when message is near the composer', () => {
    const placement = placeMessageContextMenu({
      messageRect: { left: 100, top: 720, right: 350, bottom: 800, width: 250, height: 80 },
      menuSize: { width: 160, height: 132 },
      viewport,
      alignment: 'own',
    });
    expect(placement.placedBelow).toBe(false);
    expect(placement.menuTop).toBe(720 - MESSAGE_CONTEXT_MENU_MARGIN_PX - 132);
    expect(placement.menuLeft).toBe(350 - 160);
    expect(placement.overlayShiftY).toBe(0);
  });

  it('clamps horizontally to viewport edges', () => {
    const placement = placeMessageContextMenu({
      messageRect: { left: 300, top: 200, right: 420, bottom: 260, width: 120, height: 60 },
      menuSize: { width: 180, height: 100 },
      viewport,
      alignment: 'own',
    });
    const maxLeft = viewport.right - MESSAGE_CONTEXT_MENU_MARGIN_PX - 180;
    expect(placement.menuLeft).toBe(maxLeft);
  });

  it('shifts overlay when message + menu cannot both fit', () => {
    // Neither side has room for a tall menu — shift the overlay representation.
    const placement = placeMessageContextMenu({
      messageRect: { left: 40, top: 400, right: 300, bottom: 500, width: 260, height: 100 },
      menuSize: { width: 160, height: 500 },
      viewport,
      alignment: 'incoming',
      margin: MESSAGE_CONTEXT_MENU_MARGIN_PX,
    });
    expect(placement.overlayShiftY).not.toBe(0);
    expect(placement.menuTop).toBeGreaterThanOrEqual(MESSAGE_CONTEXT_MENU_MARGIN_PX);
    expect(placement.menuTop + 500).toBeLessThanOrEqual(
      viewport.bottom - MESSAGE_CONTEXT_MENU_MARGIN_PX + 0.5,
    );
  });

  it('keeps every menu pixel inside the safe viewport for a mid-screen bubble', () => {
    const menuSize = { width: 170, height: 176 };
    const placement = placeMessageContextMenu({
      messageRect: { left: 50, top: 400, right: 300, bottom: 460, width: 250, height: 60 },
      menuSize,
      viewport,
      alignment: 'incoming',
    });
    expect(placement.menuLeft).toBeGreaterThanOrEqual(MESSAGE_CONTEXT_MENU_MARGIN_PX);
    expect(placement.menuLeft + menuSize.width).toBeLessThanOrEqual(
      viewport.right - MESSAGE_CONTEXT_MENU_MARGIN_PX,
    );
    expect(placement.menuTop).toBeGreaterThanOrEqual(MESSAGE_CONTEXT_MENU_MARGIN_PX);
    expect(placement.menuTop + menuSize.height).toBeLessThanOrEqual(
      viewport.bottom - MESSAGE_CONTEXT_MENU_MARGIN_PX,
    );
  });
});

describe('messageClipboardText', () => {
  it('returns text body for text messages', () => {
    expect(messageClipboardText({ type: 'text', text: 'привет' })).toBe('привет');
  });

  it('hides placeholder / encrypted stubs', () => {
    expect(messageClipboardText({ type: 'text', text: '[не удалось расшифровать]' })).toBeNull();
  });

  it('hides photo placeholder labels but keeps real captions', () => {
    expect(messageClipboardText({ type: 'image', text: '📷 Изображение' })).toBeNull();
    expect(messageClipboardText({ type: 'image', text: 'на закате' })).toBe('на закате');
  });

  it('hides video placeholders', () => {
    expect(messageClipboardText({ type: 'video', text: '🎬 Видео' })).toBeNull();
  });
});

describe('canSaveMessageMedia', () => {
  it('allows save when media URL is present', () => {
    expect(canSaveMessageMedia({ type: 'image', imageUrl: 'blob:x' })).toBe(true);
    expect(canSaveMessageMedia({ type: 'video', imageUrl: 'blob:y' })).toBe(true);
  });

  it('rejects text and unloaded media', () => {
    expect(canSaveMessageMedia({ type: 'text', imageUrl: 'blob:x' })).toBe(false);
    expect(canSaveMessageMedia({ type: 'image', imageUrl: null })).toBe(false);
  });
});
