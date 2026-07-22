import { describe, expect, it } from 'vitest';
import {
  assertLiveVideoSender,
  diagnoseLocalDescription,
  isNativeAndroidTransport,
  previewOfferHasNoSendingAudio,
  previewOfferHasSendonlyVideo,
} from './webrtc-offer-diagnostics';
import { shouldSendPreviewOffer } from './call-preview';

describe('browser vs native transport separation', () => {
  it('browser flow helpers do not treat native transport as browser', () => {
    expect(isNativeAndroidTransport({ transport: 'native-android' })).toBe(true);
    expect(isNativeAndroidTransport({ transport: 'browser' })).toBe(false);
    expect(isNativeAndroidTransport({})).toBe(false);
  });

  it('legacy preview-ready gate stays false for idle browser phases', () => {
    expect(
      shouldSendPreviewOffer({
        phase: 'idle',
        callId: 'a',
        signalCallId: 'a',
        alreadySentForCallId: null,
      }),
    ).toBe(false);
  });
});

describe('preview SDP shape helpers', () => {
  it('detects sendonly video without sending audio', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=sendonly',
      'a=rtpmap:96 H264/90000',
      'm=audio 0 UDP/TLS/RTP/SAVPF 111',
      'a=inactive',
      'a=rtpmap:111 opus/48000/2',
    ].join('\n');
    expect(previewOfferHasSendonlyVideo(sdp)).toBe(true);
    expect(previewOfferHasNoSendingAudio(sdp)).toBe(true);
  });

  it('rejects sendrecv audio in preview', () => {
    const sdp = [
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=sendonly',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=sendrecv',
    ].join('\n');
    expect(previewOfferHasNoSendingAudio(sdp)).toBe(false);
  });
});

describe('live video sender assertion', () => {
  it('throws when no video sender', () => {
    const pc = {
      getSenders: () => [],
    } as unknown as RTCPeerConnection;
    expect(() => assertLiveVideoSender(pc)).toThrow(/no video sender/);
  });

  it('passes for live enabled video track', () => {
    const track = { kind: 'video', readyState: 'live', enabled: true };
    const pc = {
      getSenders: () => [{ track }],
      getTransceivers: () => [],
      localDescription: {
        sdp: 'm=video 9 UDP/TLS/RTP/SAVPF 96\na=sendonly\na=rtpmap:96 VP8/90000\n',
      },
      signalingState: 'have-local-offer',
    } as unknown as RTCPeerConnection;
    expect(assertLiveVideoSender(pc).track).toBe(track);
    const diag = diagnoseLocalDescription(pc);
    expect(diag.hasVideoMLine).toBe(true);
    expect(diag.videoTrackLive).toBe(true);
    expect(diag.videoCodecNames).toContain('VP8');
  });
});

describe('native capability selection', () => {
  it('selects native only when capability flag is true', () => {
    const pick = (cap?: { nativeVideoCall?: boolean }) =>
      cap?.nativeVideoCall === true ? 'native-android' : 'browser';
    expect(pick(undefined)).toBe('browser');
    expect(pick({ nativeVideoCall: false })).toBe('browser');
    expect(pick({ nativeVideoCall: true })).toBe('native-android');
  });
});
