/**
 * Prefer sharper outbound video for Mode A / browser side of Mode B.
 * Capture ideals + RTP maxBitrate — browsers still adapt down on weak links.
 */

export const VIDEO_CAPTURE_IDEAL = {
  width: 1280,
  height: 720,
  frameRate: 30,
} as const;

/** Soft ceiling ~2.5 Mbps — enough for 720p30 without crushing mobile data. */
export const VIDEO_MAX_BITRATE_BPS = 2_500_000;

export function videoCaptureConstraints(
  facingMode: 'user' | 'environment',
): MediaTrackConstraints {
  return {
    facingMode: { ideal: facingMode },
    width: { ideal: VIDEO_CAPTURE_IDEAL.width },
    height: { ideal: VIDEO_CAPTURE_IDEAL.height },
    frameRate: { ideal: VIDEO_CAPTURE_IDEAL.frameRate, max: VIDEO_CAPTURE_IDEAL.frameRate },
  };
}

/** Mid tier if 720p is rejected by the device / WebView. */
export function videoCaptureConstraintsFallback(
  facingMode: 'user' | 'environment',
): MediaTrackConstraints {
  return {
    facingMode: { ideal: facingMode },
    width: { ideal: 960 },
    height: { ideal: 540 },
    frameRate: { ideal: 30, max: 30 },
  };
}

export async function preferHigherVideoQuality(
  pc: RTCPeerConnection,
  maxBitrateBps = VIDEO_MAX_BITRATE_BPS,
): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      for (const enc of params.encodings) {
        enc.maxBitrate = maxBitrateBps;
        enc.maxFramerate = VIDEO_CAPTURE_IDEAL.frameRate;
        if (enc.scaleResolutionDownBy == null || enc.scaleResolutionDownBy > 1) {
          enc.scaleResolutionDownBy = 1;
        }
      }
      await sender.setParameters(params);
    } catch {
      // Some browsers reject setParameters before negotiation completes.
    }
  }
}
