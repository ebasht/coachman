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
  return devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
}

export async function pickCameraByFacing(
  facing: VideoFacingMode,
  excludeDeviceId?: string,
): Promise<MediaDeviceInfo | null> {
  const cameras = await listVideoCameras();
  const pool = excludeDeviceId
    ? cameras.filter((c) => c.deviceId !== excludeDeviceId)
    : cameras;
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

/** Next camera when switching: prefer facing match, else cycle device list. */
export async function pickSwitchCameraTarget(
  facing: VideoFacingMode,
  currentDeviceId?: string,
): Promise<MediaDeviceInfo | null> {
  const cameras = await listVideoCameras();
  if (cameras.length === 0) return null;

  const byFacing = await pickCameraByFacing(facing, currentDeviceId);
  if (byFacing && byFacing.deviceId !== currentDeviceId) return byFacing;

  if (!currentDeviceId) return cameras[0] ?? null;
  const idx = cameras.findIndex((c) => c.deviceId === currentDeviceId);
  if (idx < 0) return cameras.find((c) => c.deviceId !== currentDeviceId) ?? cameras[0];
  if (cameras.length < 2) return null;
  return cameras[(idx + 1) % cameras.length];
}

export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('environment');
}

const ANDROID_CAMERA_RELEASE_MS = 500;

async function openVideoTrack(constraints: MediaStreamConstraints): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  return track;
}

async function releaseVideoTrack(track: MediaStreamTrack | null | undefined): Promise<void> {
  if (!track) return;
  if (track.readyState === 'ended') {
    await new Promise((r) => setTimeout(r, ANDROID_CAMERA_RELEASE_MS));
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    track.addEventListener('ended', done, { once: true });
    try {
      track.stop();
    } catch {
      /* ignore */
    }
    window.setTimeout(done, ANDROID_CAMERA_RELEASE_MS);
  });
  // Extra beat — Android Camera2 often needs time after 'ended'.
  await new Promise((r) => setTimeout(r, 150));
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

/** Switch to another deviceId on the same track when the UA supports it. */
export async function tryApplyDeviceId(
  track: MediaStreamTrack,
  deviceId: string,
): Promise<boolean> {
  if (!deviceId) return false;
  try {
    await track.applyConstraints({ deviceId: { exact: deviceId } });
    return track.getSettings().deviceId === deviceId;
  } catch {
    try {
      await track.applyConstraints({ deviceId: { ideal: deviceId } });
      const got = track.getSettings().deviceId;
      return Boolean(got && got === deviceId);
    } catch {
      return false;
    }
  }
}

/**
 * Open a new video track for the given facing mode.
 * On Android we stop the previous track first (device lock).
 * On iOS we must NOT stop first — Safari often re-prompts camera permission.
 */
export async function acquireCameraVideoTrack(
  facing: VideoFacingMode,
  opts?: {
    stopTrack?: MediaStreamTrack | null;
    excludeDeviceId?: string;
    /** Prefer this device when known (Android switch). */
    deviceId?: string;
  },
): Promise<MediaStreamTrack> {
  const apple = isAppleMobile();
  const android = isAndroidMobile();
  const stopFirst = Boolean(opts?.stopTrack) && !apple;

  if (stopFirst) {
    await releaseVideoTrack(opts?.stopTrack);
  }

  const device = apple
    ? null
    : opts?.deviceId
      ? ({ deviceId: opts.deviceId } as MediaDeviceInfo)
      : await pickCameraByFacing(facing, opts?.excludeDeviceId);

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
    // Bare deviceId — some WebViews reject exact/ideal wrappers.
    attempts.push({
      audio: false,
      video: { deviceId: device.deviceId },
    });
  }

  if (!android) {
    attempts.push({
      audio: false,
      video: {
        facingMode: { exact: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
  }
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
  for (const constraints of attempts) {
    try {
      return await openVideoTrack(constraints);
    } catch (err) {
      lastErr = err;
      // Don't stack more getUserMedia calls after the user denied — that re-shows the dialog.
      if (isPermissionDenied(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('switch camera failed');
}
