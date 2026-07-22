import { describe, expect, it } from 'vitest';
import {
  remoteHangupNeedsUnlock,
  shouldApplyPreviewSdp,
  shouldHideGateForCallUiReady,
  shouldSendPreviewOffer,
} from './call-preview';

describe('shouldSendPreviewOffer', () => {
  it('dedupes preview-ready by callId while outgoing', () => {
    expect(
      shouldSendPreviewOffer({
        phase: 'outgoing',
        callId: 'c1',
        signalCallId: 'c1',
        alreadySentForCallId: null,
      }),
    ).toBe(true);
    expect(
      shouldSendPreviewOffer({
        phase: 'outgoing',
        callId: 'c1',
        signalCallId: 'c1',
        alreadySentForCallId: 'c1',
      }),
    ).toBe(false);
  });

  it('only creates preview offer in outgoing state', () => {
    expect(
      shouldSendPreviewOffer({
        phase: 'incoming',
        callId: 'c1',
        signalCallId: 'c1',
        alreadySentForCallId: null,
      }),
    ).toBe(false);
  });
});

describe('shouldApplyPreviewSdp', () => {
  it('ignores late preview after active', () => {
    expect(shouldApplyPreviewSdp({ stage: 'preview', negotiationStage: 'active' })).toBe(false);
    expect(shouldApplyPreviewSdp({ stage: 'active', negotiationStage: 'preview' })).toBe(true);
    expect(shouldApplyPreviewSdp({ stage: 'preview', negotiationStage: 'preview' })).toBe(true);
  });
});

describe('remoteHangupNeedsUnlock', () => {
  it('does not unlock before answer', () => {
    expect(remoteHangupNeedsUnlock({ phase: 'incoming', accepted: false })).toBe(false);
  });

  it('unlocks after answer', () => {
    expect(remoteHangupNeedsUnlock({ phase: 'active', accepted: true })).toBe(true);
    expect(remoteHangupNeedsUnlock({ phase: 'connecting', accepted: true })).toBe(true);
  });
});

describe('shouldHideGateForCallUiReady', () => {
  it('only hides gate for matching callId', () => {
    expect(shouldHideGateForCallUiReady({ readyCallId: 'a', activeCallId: 'a' })).toBe(true);
    expect(shouldHideGateForCallUiReady({ readyCallId: 'a', activeCallId: 'b' })).toBe(false);
  });
});
