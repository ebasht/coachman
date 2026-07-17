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

/** Samsung / Xiaomi(POCO/Redmi) Camera2 is slow to release and lists many lenses. */
export function isFussyAndroidOem(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Samsung|SM-[A-Z0-9]+|Xiaomi|Redmi|POCO|Mi\s?\d|Black Shark|INFINIX/i.test(ua);
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

/** Parse Chromium/Android labels like "camera2 0, facing back". */
export function classifyCameraFacing(label: string): VideoFacingMode | 'unknown' {
  const l = label || '';
  if (/facing[- ]?front|(^|[^a-z])front([^a-z]|$)|selfie|user|фронт/i.test(l)) {
    return 'user';
  }
  if (
    /facing[- ]?back|facing[- ]?rear|(^|[^a-z])back([^a-z]|$)|rear|environment|задн/i.test(l)
  ) {
    return 'environment';
  }
  return 'unknown';
}

function isSecondaryLens(label: string): boolean {
  return /ultra|wide|tele|macro|depth|logical|infrared|ir\b/i.test(label || '');
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

  const matched = pool.filter((c) => classifyCameraFacing(c.label) === facing);
  if (matched.length) {
    // Prefer the main lens — Samsung/Poco expose ultra-wide/tele as separate devices.
    const main = matched.find((c) => !isSecondaryLens(c.label));
    return main ?? matched[0];
  }

  // Empty labels: do not guess by index on multi-cam phones — caller should use facingMode.
  const anyLabeled = pool.some((c) => (c.label || '').trim().length > 0);
  if (!anyLabeled) return null;

  if (excludeDeviceId && pool.length === 1) return pool[0];
  return null;
}

/**
 * Pick the other facing camera for a flip.
 * Never blind-cycle device list on Android — that flips between back lenses on Samsung/Poco.
 */
export async function pickSwitchCameraTarget(
  facing: VideoFacingMode,
  currentDeviceId?: string,
): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing(facing, currentDeviceId);
}

export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('environment');
}

/** Remember which deviceId worked for each facing — next flip skips guessing. */
const androidFacingDeviceId: Partial<Record<VideoFacingMode, string>> = {};

export function rememberAndroidCamera(facing: VideoFacingMode, deviceId?: string) {
  if (deviceId) androidFacingDeviceId[facing] = deviceId;
}

export function forgetAndroidCamera(facing?: VideoFacingMode) {
  if (facing) delete androidFacingDeviceId[facing];
  else {
    delete androidFacingDeviceId.user;
    delete androidFacingDeviceId.environment;
  }
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

/** Stop track and wait for Camera2 to free. Samsung/Xiaomi need a longer pause. */
async function releaseVideoTrackFast(
  track: MediaStreamTrack | null | undefined,
  waitMs: number,
): Promise<void> {
  if (!track) {
    await sleep(Math.min(80, waitMs));
    return;
  }
  if (track.readyState === 'ended') {
    await sleep(waitMs);
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
    window.setTimeout(done, waitMs);
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
  // Samsung/Poco: applyConstraints(deviceId) is flaky / may jump to another back lens.
  if (!deviceId || isAndroidMobile()) return false;
  try {
    await track.applyConstraints({ deviceId: { exact: deviceId } });
    return track.getSettings().deviceId === deviceId;
  } catch {
    return false;
  }
}

function trackLooksLikeFacing(track: MediaStreamTrack, facing: VideoFacingMode): boolean {
  const settings = track.getSettings();
  if (settings.facingMode) return settings.facingMode === facing;
  // No facingMode reported — accept if deviceId differs from what we excluded later.
  return true;
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
 * Android camera flip for WebRTC (tuned for Samsung / POCO / Xiaomi):
 * detach → stop → OEM wait → facingMode first, then known main-lens deviceId.
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
  const fussy = isFussyAndroidOem();
  const releaseMs = fussy ? 480 : 260;

  const remembered = androidFacingDeviceId[facing];
  const picked = await pickCameraByFacing(facing, opts.excludeDeviceId);
  const targetId =
    (remembered && remembered !== opts.excludeDeviceId ? remembered : undefined) ||
    opts.deviceId ||
    picked?.deviceId ||
    undefined;

  if (opts.beforeStop) {
    try {
      await opts.beforeStop();
    } catch {
      /* still stop below */
    }
  }
  await releaseVideoTrackFast(opts.oldTrack, releaseMs);

  // Samsung/Poco: facingMode is more reliable than exact deviceId of a secondary lens.
  const attempts: MediaStreamConstraints[] = [];
  if (fussy) {
    attempts.push({ audio: false, video: { facingMode: { ideal: facing } } });
    if (targetId) {
      attempts.push({ audio: false, video: { deviceId: { exact: targetId } } });
    }
  } else {
    if (targetId) {
      attempts.push({ audio: false, video: { deviceId: { exact: targetId } } });
    }
    attempts.push({ audio: false, video: { facingMode: { ideal: facing } } });
  }

  let track = await tryOpenWithAttempts(attempts);

  // Reject "success" that kept the same physical camera.
  if (opts.excludeDeviceId && track.getSettings().deviceId === opts.excludeDeviceId) {
    track.stop();
    await sleep(fussy ? 350 : 180);
    forgetAndroidCamera(facing);
    track = await openVideoTrack({ audio: false, video: { facingMode: { ideal: facing } } });
  }

  // If facingMode is reported and wrong, try the other labeled main camera once.
  if (!trackLooksLikeFacing(track, facing)) {
    const alt = await pickCameraByFacing(facing, track.getSettings().deviceId);
    track.stop();
    await sleep(fussy ? 350 : 180);
    if (alt?.deviceId) {
      try {
        track = await openVideoTrack({
          audio: false,
          video: { deviceId: { exact: alt.deviceId } },
        });
      } catch {
        track = await openVideoTrack({ audio: false, video: { facingMode: { ideal: facing } } });
      }
    } else {
      track = await openVideoTrack({ audio: false, video: { facingMode: { ideal: facing } } });
    }
  }

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
    await releaseVideoTrackFast(opts?.stopTrack, 260);
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
