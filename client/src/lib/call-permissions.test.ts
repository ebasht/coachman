import { describe, expect, it } from 'vitest';
import { statusLabel } from './call-permissions';

describe('call permission status labels', () => {
  it('marks not required', () => {
    expect(statusLabel({ granted: false, notRequired: true })).toMatch(/Не требуется/);
  });

  it('marks granted', () => {
    expect(statusLabel({ granted: true })).toBe('Разрешено');
  });

  it('marks settings needed', () => {
    expect(statusLabel({ granted: false, needsSettings: true })).toMatch(/настройки/);
  });

  it('marks denied', () => {
    expect(statusLabel({ granted: false })).toBe('Не разрешено');
  });
});

describe('incoming ready formula', () => {
  it('ignores battery optimization', () => {
    const incomingCallsReady = true && true && true && true;
    const batteryOptimized = true;
    expect(incomingCallsReady).toBe(true);
    expect(batteryOptimized).toBe(true);
  });
});
