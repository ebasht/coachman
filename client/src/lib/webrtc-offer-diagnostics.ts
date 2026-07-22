/** Safe offer diagnostics — never log full SDP. */

export type OfferDiagnostics = {
  hasVideoMLine: boolean;
  videoDirection: string | null;
  videoCodecNames: string[];
  videoTransceiverCount: number;
  videoSenderHasTrack: boolean;
  videoTrackLive: boolean;
  videoTrackEnabled: boolean;
  signalingState: string;
};

export function assertLiveVideoSender(pc: RTCPeerConnection): RTCRtpSender {
  const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video');
  if (!videoSender?.track) {
    throw new Error('BROWSER_MEDIA_READY failed: no video sender track');
  }
  if (videoSender.track.readyState !== 'live') {
    throw new Error(`BROWSER_MEDIA_READY failed: video readyState=${videoSender.track.readyState}`);
  }
  if (!videoSender.track.enabled) {
    throw new Error('BROWSER_MEDIA_READY failed: video track disabled');
  }
  return videoSender;
}

export function diagnoseLocalDescription(pc: RTCPeerConnection): OfferDiagnostics {
  const sdp = pc.localDescription?.sdp ?? '';
  const videoBlock = extractMediaBlock(sdp, 'video');
  const codecs = videoBlock
    ? [...videoBlock.matchAll(/a=rtpmap:(\d+) ([^\s/]+)/g)].map((m) => m[2])
    : [];
  const directionMatch = videoBlock?.match(/\ba=(sendrecv|sendonly|recvonly|inactive)\b/);
  const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
  const track = videoSender?.track ?? null;
  return {
    hasVideoMLine: /m=video\s+\d+/.test(sdp),
    videoDirection: directionMatch?.[1] ?? null,
    videoCodecNames: codecs,
    videoTransceiverCount: pc.getTransceivers().filter((t) => {
      const kind = t.receiver.track?.kind ?? t.sender.track?.kind;
      return kind === 'video' || t.mid != null;
    }).length,
    videoSenderHasTrack: Boolean(track),
    videoTrackLive: track?.readyState === 'live',
    videoTrackEnabled: Boolean(track?.enabled),
    signalingState: pc.signalingState,
  };
}

function extractMediaBlock(sdp: string, kind: 'audio' | 'video'): string | null {
  const re = new RegExp(`m=${kind}[\\s\\S]*?(?=\\nm=|$)`);
  const m = sdp.match(re);
  return m?.[0] ?? null;
}

export function previewOfferHasSendonlyVideo(sdp: string): boolean {
  const block = extractMediaBlock(sdp, 'video');
  if (!block) return false;
  if (!/a=sendonly/.test(block) && !/a=sendrecv/.test(block)) return false;
  return /m=video\s+[1-9]/.test(block) || /m=video\s+\d+/.test(block);
}

export function previewOfferHasNoSendingAudio(sdp: string): boolean {
  const block = extractMediaBlock(sdp, 'audio');
  if (!block) return true;
  return /a=inactive/.test(block) || /a=recvonly/.test(block) || /m=audio\s+0\s/.test(block);
}

export function isNativeAndroidTransport(signal: { transport?: string } | null | undefined): boolean {
  return signal?.transport === 'native-android';
}
