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

/** Remember which deviceId worked for each facing — next flip skips guessing. */
const androidFacingDeviceId: Partial<Record<VideoFacingMode, string>> = {};

export function rememberAndroidCamera(facing: VideoFacingMode, deviceId?: string) {
  if (deviceId) androidFacingDeviceId[facing] = deviceId;
}

async function openVideoTrack(constraints: MediaStreamConstraints): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  return track;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Stop track and wait briefly for Camera2 to free — keep this short for snappy flips. */
async function releaseVideoTrackFast(track: MediaStreamTrack | null | undefined): Promise<void> {
  if (!track) return;
  if (track.readyState === 'ended') {
    await sleep(120);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    track.addEventListener('ended', done, { once: true });
    try {
      track.stop();
    } catch {
      /* ignore */
    }
    window.setTimeout(done, 280);
  });
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
    return false;
  }
}

async function tryOpenWithAttempts(attempts: MediaStreamConstraints[]): Promise<MediaStreamTrack> {
  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await openVideoTrack(constraints);
    } catch (err) {
      lastErr = err;
      if (isPermissionDenied(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('switch camera failed');
}

/**
 * Fast Android camera flip for WebRTC:
 * detach → stop → short wait → 1–2 getUserMedia attempts (no long retry chains).
 */
export async function acquireAndroidSwitchTrack(
  facing: VideoFacingMode,
  opts: {
    oldTrack: MediaStreamTrack | null;
    deviceId?: string;
    excludeDeviceId?: string;
    beforeStop?: () => Promise<void>;
  },
): Promise<MediaStreamTrack> {
  const remembered = androidFacingDeviceId[facing];
  const targetId =
    (remembered && remembered !== opts.excludeDeviceId ? remembered : undefined) ||
    opts.deviceId ||
    (await pickCameraByFacing(facing, opts.excludeDeviceId))?.deviceId ||
    undefined;

  // Always release first on Android during a call — dual-open usually fails and only wastes time.
  if (opts.beforeStop) {
    try {
      await opts.beforeStop();
    } catch {
      /* still stop below */
    }
  }
  await releaseVideoTrackFast(opts.oldTrack);

  const attempts: MediaStreamConstraints[] = [];
  if (targetId) {
    attempts.push({ audio: false, video: { deviceId: { exact: targetId } } });
  }
  attempts.push({ audio: false, video: { facingMode: { ideal: facing } } });

  const track = await tryOpenWithAttempts(attempts);
  rememberAndroidCamera(facing, track.getSettings().deviceId);
  return track;
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
    deviceId?: string;
  },
): Promise<MediaStreamTrack> {
  const apple = isAppleMobile();
  const android = isAndroidMobile();

  if (android) {
    return acquireAndroidSwitchTrack(facing, {
      oldTrack: opts?.stopTrack ?? null,
      deviceId: opts?.deviceId,
      excludeDeviceId: opts?.excludeDeviceId,
    });
  }

  const stopFirst = Boolean(opts?.stopTrack) && !apple;
  if (stopFirst) {
    await releaseVideoTrackFast(opts?.stopTrack);
  }

  const device = apple
    ? null
    : opts?.deviceId
      ? ({ deviceId: opts.deviceId } as MediaDeviceInfo)
      : await pickCameraByFacing(facing, opts?.excludeDeviceId);

  const attempts: MediaStreamConstraints[] = [];

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
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  attempts.push({ audio: false, video: { facingMode: facing } });
  if (apple) {
    attempts.push({ audio: false, video: true });
  }

  return tryOpenWithAttempts(attempts);
}

/** Find an RTCRtpSender even after replaceTrack(null) cleared sender.track. */
export function findRtcSender(
  pc: RTCPeerConnection,
  kind: 'audio' | 'video',
): RTCRtpSender | undefined {
  const live = pc.getSenders().find((s) => s.track?.kind === kind);
  if (live) return live;

  for (const t of pc.getTransceivers()) {
    if (t.sender.track?.kind === kind) return t.sender;
    if (!t.sender.track && t.receiver.track?.kind === kind) return t.sender;
  }

  const nullSenders = pc.getSenders().filter((s) => !s.track);
  if (kind === 'audio') return nullSenders[0];
  if (nullSenders.length > 1) return nullSenders[1];
  return nullSenders[0];
}
