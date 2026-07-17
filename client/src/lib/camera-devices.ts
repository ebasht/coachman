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

/** Parse Chromium/Android labels like "camera2 0, facing back". */
export function classifyCameraFacing(label: string): VideoFacingMode | 'unknown' {
  const l = label || '';
  if (/facing[- ]?front|selfie|фронт/i.test(l)) return 'user';
  if (/facing[- ]?back|facing[- ]?rear|rear|environment|задн/i.test(l)) return 'environment';
  return 'unknown';
}

function isSecondaryLens(label: string): boolean {
  return /ultra|wide|tele|macro|depth|logical|infrared|\bir\b/i.test(label || '');
}

/**
 * Same picker the QR scanner uses for the main back camera.
 * Prefer labeled main lens; fall back to last/first device (legacy QR behaviour).
 */
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
    const main = matched.find((c) => !isSecondaryLens(c.label));
    return main ?? matched[0];
  }

  // Original QR-era fallback when labels are missing/opaque.
  if (facing === 'environment') {
    return pool.length > 1 ? pool[pool.length - 1] : pool[0];
  }
  return pool[0];
}

export async function pickSwitchCameraTarget(
  facing: VideoFacingMode,
  currentDeviceId?: string,
): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing(facing, currentDeviceId);
}

/** Main rear camera — identical entry point to QrScannerModal. */
export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('environment');
}

export async function pickFrontCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('user');
}

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

async function releaseVideoTrack(
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
 * Open a camera the same way QrScannerModal does on Android:
 * pickBackCamera / pickFrontCamera → deviceId exact (+ size) → facingMode fallback.
 */
export async function openCameraTrackLikeQr(
  facing: VideoFacingMode,
): Promise<MediaStreamTrack> {
  if (isAppleMobile()) {
    return openVideoTrack({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
  }

  const camera =
    facing === 'environment' ? await pickBackCamera() : await pickFrontCamera();

  // Remembered id from a previous successful flip (same facing).
  const remembered = androidFacingDeviceId[facing];
  const deviceId = remembered || camera?.deviceId;

  if (deviceId) {
    try {
      const track = await openVideoTrack({
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      rememberAndroidCamera(facing, track.getSettings().deviceId);
      return track;
    } catch {
      if (remembered) forgetAndroidCamera(facing);
      // Fall through — try picker id if remembered failed, else facingMode.
      if (remembered && camera?.deviceId && camera.deviceId !== remembered) {
        try {
          const track = await openVideoTrack({
            audio: false,
            video: {
              deviceId: { exact: camera.deviceId },
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
          });
          rememberAndroidCamera(facing, track.getSettings().deviceId);
          return track;
        } catch {
          /* facingMode below */
        }
      }
    }
  }

  const track = await openVideoTrack({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  rememberAndroidCamera(facing, track.getSettings().deviceId);
  return track;
}

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
    return track.getSettings().facingMode === facing;
  } catch {
    return false;
  }
}

export async function tryApplyDeviceId(
  track: MediaStreamTrack,
  deviceId: string,
): Promise<boolean> {
  if (!deviceId || isAndroidMobile()) return false;
  try {
    await track.applyConstraints({ deviceId: { exact: deviceId } });
    return track.getSettings().deviceId === deviceId;
  } catch {
    return false;
  }
}

/**
 * Android WebRTC flip: release current video, then open exactly like the QR scanner.
 */
export async function acquireAndroidSwitchTrack(
  facing: VideoFacingMode,
  opts: {
    oldTrack: MediaStreamTrack | null;
    beforeStop?: () => Promise<void>;
  },
): Promise<MediaStreamTrack> {
  if (opts.beforeStop) {
    try {
      await opts.beforeStop();
    } catch {
      /* still stop */
    }
  }
  // Samsung/Poco need a beat after stop; QR never fights WebRTC so it looks "instant".
  await releaseVideoTrack(opts.oldTrack, 400);
  return openCameraTrackLikeQr(facing);
}

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
    });
  }

  if (opts?.stopTrack && !apple) {
    await releaseVideoTrack(opts.stopTrack, 260);
  }

  if (apple) {
    return openVideoTrack({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
  }

  // Non-Android desktop / other: keep previous multi-attempt path.
  const device = opts?.deviceId
    ? ({ deviceId: opts.deviceId } as MediaDeviceInfo)
    : await pickCameraByFacing(facing, opts?.excludeDeviceId);

  const attempts: MediaStreamConstraints[] = [];
  if (device?.deviceId) {
    attempts.push({
      audio: false,
      video: {
        deviceId: { exact: device.deviceId },
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
