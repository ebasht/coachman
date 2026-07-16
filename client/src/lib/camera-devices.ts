export type VideoFacingMode = 'user' | 'environment';

export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isAndroidMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

function isPermissionDenied(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'SecurityError')
  );
}

export async function listVideoCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export async function pickCameraByFacing(
  facing: VideoFacingMode,
  excludeDeviceId?: string,
): Promise<MediaDeviceInfo | null> {
  const cameras = await listVideoCameras();
  const pool = excludeDeviceId
    ? cameras.filter((c) => c.deviceId && c.deviceId !== excludeDeviceId)
    : cameras.filter((c) => c.deviceId);
  if (pool.length === 0) return null;

  // Switching: any other camera is better than sticking to the current one.
  if (excludeDeviceId && pool.length === 1) return pool[0];

  if (facing === 'environment') {
    const back = pool.find((c) =>
      /back|rear|environment|задн|facing[- ]?back/i.test(c.label),
    );
    if (back) return back;
    return pool.length > 1 ? pool[pool.length - 1] : pool[0];
  }

  const front = pool.find((c) =>
    /front|user|selfie|фронт|facing[- ]?front/i.test(c.label),
  );
  if (front) return front;
  return pool[0];
}

export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('environment');
}

const ANDROID_CAMERA_RELEASE_MS = 350;

async function openVideoTrack(constraints: MediaStreamConstraints): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  return track;
}

/**
 * Flip camera in-place — avoids a new getUserMedia (and iOS re-prompt).
 * Android WebView often reports success without changing camera — require verified facingMode.
 */
export async function tryApplyFacingMode(
  track: MediaStreamTrack,
  facing: VideoFacingMode,
): Promise<boolean> {
  if (isAndroidMobile()) return false;
  try {
    const caps = track.getCapabilities?.() as MediaTrackCapabilities & {
      facingMode?: string[];
    };
    if (caps?.facingMode?.length === 1 && !caps.facingMode.includes(facing)) {
      return false;
    }
    await track.applyConstraints({ facingMode: { ideal: facing } });
    const settings = track.getSettings();
    return settings.facingMode === facing;
  } catch {
    return false;
  }
}

/**
 * Open a new video track for the given facing mode.
 * On Android we stop the previous track first (device lock).
 * On iOS we must NOT stop first — Safari often re-prompts camera permission.
 */
export async function acquireCameraVideoTrack(
  facing: VideoFacingMode,
  opts?: { stopTrack?: MediaStreamTrack | null; excludeDeviceId?: string },
): Promise<MediaStreamTrack> {
  const apple = isAppleMobile();
  const android = isAndroidMobile();
  const stopFirst = Boolean(opts?.stopTrack) && !apple;

  if (stopFirst && opts?.stopTrack) {
    opts.stopTrack.stop();
    await new Promise((resolve) =>
      setTimeout(resolve, android ? ANDROID_CAMERA_RELEASE_MS : 80),
    );
  }

  const device = apple ? null : await pickCameraByFacing(facing, opts?.excludeDeviceId);
  const attempts: MediaStreamConstraints[] = [];

  // iOS: facingMode only. deviceId + exact often forces a fresh capture session → re-prompt.
  if (!apple && device?.deviceId) {
    attempts.push({
      audio: false,
      video: {
        deviceId: { exact: device.deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    attempts.push({
      audio: false,
      video: {
        deviceId: { ideal: device.deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
  }

  attempts.push({
    audio: false,
    video: {
      facingMode: { exact: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  attempts.push({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  attempts.push({ audio: false, video: { facingMode: facing } });
  if (apple) {
    attempts.push({ audio: false, video: true });
  }

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const constraints = attempts[i];
    try {
      const track = await openVideoTrack(constraints);
      // Prefer a track that actually matches the requested facing when reported.
      const got = track.getSettings().facingMode;
      if (got && got !== facing && i < attempts.length - 1) {
        track.stop();
        continue;
      }
      return track;
    } catch (err) {
      lastErr = err;
      // Don't stack more getUserMedia calls after the user denied — that re-shows the dialog.
      if (isPermissionDenied(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('switch camera failed');
}
