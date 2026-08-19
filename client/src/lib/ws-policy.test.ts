import { describe, expect, it } from 'vitest';
import {
  reconnectDelayMs,
  shouldCloseSocketImmediately,
  shouldPauseWhenHidden,
  websocketURL,
} from './ws-policy';

describe('ws-policy', () => {
  it('pauses on mobile / standalone, not on desktop Chrome UA', () => {
    expect(shouldPauseWhenHidden('Mozilla/5.0 (Macintosh) Chrome/120', false)).toBe(false);
    expect(shouldPauseWhenHidden('Mozilla/5.0 (iPhone) Safari', false)).toBe(true);
    expect(shouldPauseWhenHidden('Mozilla/5.0 (Linux; Android 14)', false)).toBe(true);
    expect(shouldPauseWhenHidden('Mozilla/5.0 (Macintosh) Chrome/120', true)).toBe(true);
  });

  it('closes immediately only on native Android without keepAlive', () => {
    expect(shouldCloseSocketImmediately(true, false)).toBe(true);
    expect(shouldCloseSocketImmediately(true, true)).toBe(false);
    expect(shouldCloseSocketImmediately(false, false)).toBe(false);
  });

  it('reconnects immediately first, then backs off', () => {
    expect(reconnectDelayMs(1)).toBe(0);
    expect(reconnectDelayMs(2)).toBe(400);
    expect(reconnectDelayMs(3)).toBe(800);
    expect(reconnectDelayMs(6)).toBe(6400);
    expect(reconnectDelayMs(10)).toBe(8000);
  });

  it('uses the current origin and proxy route on every client', () => {
    expect(websocketURL({ protocol: 'http:', host: 'localhost:5173' } as Location))
      .toBe('ws://localhost:5173/ws');
    expect(websocketURL({ protocol: 'https:', host: 'chat.example.test' } as Location))
      .toBe('wss://chat.example.test/ws');
  });
});
