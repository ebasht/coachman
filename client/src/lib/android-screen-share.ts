import type { PluginListenerHandle } from '@capacitor/core';
import { CoachmanCalls } from './coachman-calls';
import { isNativeAndroid } from './native-calls';

/** True when browser getDisplayMedia exists (desktop / some mobile browsers). */
export function canUseDisplayMedia(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

/** Mode A on Capacitor Android — native MediaProjection + canvas.captureStream. */
export function canUseNativeAndroidScreenShare(): boolean {
  return isNativeAndroid();
}

export function canScreenShare(): boolean {
  return canUseDisplayMedia() || canUseNativeAndroidScreenShare();
}

/**
 * Capture screen on Android WebView via Capacitor → JPEG frames → canvas MediaStreamTrack.
 */
export async function acquireNativeAndroidScreenTrack(): Promise<{
  track: MediaStreamTrack;
  stream: MediaStream;
  stop: () => Promise<void>;
}> {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  const stream = canvas.captureStream(10);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('captureStream produced no track');

  let frameHandle: PluginListenerHandle | null = null;
  let endedHandle: PluginListenerHandle | null = null;
  let stopped = false;
  const pending: HTMLImageElement[] = [];

  const drawJpeg = (b64: string) => {
    if (stopped) return;
    const img = new Image();
    img.onload = () => {
      if (stopped) return;
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      } catch {
        /* ignore */
      }
    };
    img.src = `data:image/jpeg;base64,${b64}`;
    pending.push(img);
    if (pending.length > 4) pending.shift();
  };

  frameHandle = await CoachmanCalls.addListener('screenShareFrame', (ev) => {
    if (ev?.jpegBase64) drawJpeg(ev.jpegBase64);
  });
  endedHandle = await CoachmanCalls.addListener('screenShareEnded', () => {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  });

  try {
    await CoachmanCalls.startScreenShare();
  } catch (err) {
    await frameHandle.remove().catch(() => {});
    await endedHandle.remove().catch(() => {});
    track.stop();
    throw err;
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await CoachmanCalls.stopScreenShare();
    } catch {
      /* ignore */
    }
    try {
      await frameHandle?.remove();
    } catch {
      /* ignore */
    }
    try {
      await endedHandle?.remove();
    } catch {
      /* ignore */
    }
    frameHandle = null;
    endedHandle = null;
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  };

  track.addEventListener('ended', () => {
    void stop();
  });

  return { track, stream, stop };
}
