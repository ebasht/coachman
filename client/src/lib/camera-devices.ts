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

/** Samsung (incl. S24) — multi-camera / slow Camera2 release. */
export function isSamsungDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Samsung|SM-[A-Z0-9]+/i.test(navigator.userAgent);
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
 * Resolve facing from track settings / label.
 * Android WebView often omits settings.facingMode — label is the reliable signal.
 */
export function resolveTrackFacing(track: MediaStreamTrack): VideoFacingMode | 'unknown' {
  const settings = track.getSettings() as MediaTrackSettings & { facingMode?: string };
  if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
    return settings.facingMode;
  }
  return classifyCameraFacing(track.label || '');
}

/**
 * Picker used by the QR scanner for a cold-start main rear camera.
 * Prefer labeled main lens; fall back to last/first device.
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

async function openVideoTrack(constraints: MediaStreamConstraints): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  // Drop sibling tracks from the temporary stream handle; we own `track`.
  for (const t of stream.getTracks()) {
    if (t !== track) t.stop();
  }
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
 * Cold-start open like QrScannerModal (deviceId when known).
 * Good when no other camera session is held (QR, first call media).
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

  if (camera?.deviceId) {
    try {
      return await openVideoTrack({
        audio: false,
        video: {
          deviceId: { exact: camera.deviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
    } catch {
      /* facingMode below */
    }
  }

  return openVideoTrack({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
}

export async function tryApplyFacingMode(
  track: MediaStreamTrack,
  facing: VideoFacingMode,
): Promise<boolean> {
  // Android WebView: applyConstraints(facingMode) almost never flips the lens.
  if (isAndroidMobile()) return false;
  try {
    const caps = track.getCapabilities?.() as MediaTrackCapabilities & {
      facingMode?: string[];
    };
    if (caps?.facingMode?.length === 1 && !caps.facingMode.includes(facing)) {
      return false;
    }
    await track.applyConstraints({ facingMode: { ideal: facing } });
    return resolveTrackFacing(track) === facing;
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
 * Ordered camera candidates for a mid-call flip.
 * Prefer main lens for target facing; then other matching; then any other device.
 * Enumerate AFTER the previous session is released — deviceIds can change while held.
 */
async function listAndroidSwitchCandidates(
  facing: VideoFacingMode,
  excludeDeviceId?: string,
): Promise<MediaDeviceInfo[]> {
  const cameras = await listVideoCameras();
  const others = excludeDeviceId
    ? cameras.filter((c) => c.deviceId !== excludeDeviceId)
    : cameras.slice();

  const matched = others.filter((c) => classifyCameraFacing(c.label) === facing);
  const main = matched.filter((c) => !isSecondaryLens(c.label));
  const secondary = matched.filter((c) => isSecondaryLens(c.label));
  const unknown = others.filter((c) => classifyCameraFacing(c.label) === 'unknown');
  const rest = others.filter(
    (c) =>
      classifyCameraFacing(c.label) !== facing &&
      classifyCameraFacing(c.label) !== 'unknown',
  );

  const ordered: MediaDeviceInfo[] = [];
  const pushUnique = (list: MediaDeviceInfo[]) => {
    for (const c of list) {
      if (!ordered.some((x) => x.deviceId === c.deviceId)) ordered.push(c);
    }
  };

  if (facing === 'environment') {
    // QR-style: main back first, then other backs, then unknowns (often rear on Samsung).
    pushUnique(main);
    pushUnique(secondary);
    pushUnique(unknown.length ? [unknown[unknown.length - 1], ...unknown.slice(0, -1)] : []);
    pushUnique(rest);
  } else {
    pushUnique(main);
    pushUnique(secondary);
    pushUnique(unknown.length ? [unknown[0], ...unknown.slice(1)] : []);
    pushUnique(rest);
  }

  return ordered;
}

async function openAndroidCandidate(camera: MediaDeviceInfo): Promise<MediaStreamTrack> {
  // Same constraint shape as QrScannerModal — proven on S24+.
  return openVideoTrack({
    audio: false,
    video: {
      deviceId: { exact: camera.deviceId },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
}

/**
 * Mid-call flip on Android ≈ stop previous capture → wait → open like QR (deviceId).
 * facingMode-only is unreliable on Samsung multi-camera (S24+); deviceId of the main
 * lens is what already works for the QR scanner cold-start.
 */
export async function acquireAndroidSwitchTrack(
  facing: VideoFacingMode,
  opts: {
    oldTrack: MediaStreamTrack | null;
    excludeDeviceId?: string;
    beforeStop?: () => Promise<void>;
  },
): Promise<MediaStreamTrack> {
  const samsung = isSamsungDevice();
  // CAMERA_IN_USE on S24+ if Chromium has not finished tearing down Camera2.
  const stopWaitMs = samsung ? 900 : 500;
  const gapMs = samsung ? 450 : 200;
  const exclude = opts.excludeDeviceId || opts.oldTrack?.getSettings().deviceId;

  if (opts.beforeStop) {
    try {
      await opts.beforeStop();
    } catch {
      /* still stop */
    }
  }
  await releaseVideoTrack(opts.oldTrack, stopWaitMs);
  await sleep(gapMs);

  let lastErr: unknown;

  const tryOpen = async (): Promise<MediaStreamTrack | null> => {
    // Re-enumerate after release — labels/ids are trustworthy only then.
    const candidates = await listAndroidSwitchCandidates(facing, exclude);

    for (const camera of candidates) {
      try {
        const track = await openAndroidCandidate(camera);
        const got = resolveTrackFacing(track);
        // Accept if facing matches, or label unknown but deviceId differs (heuristic pick).
        if (got === facing || (got === 'unknown' && camera.deviceId !== exclude)) {
          return track;
        }
        // Wrong lens (e.g. ultra-wide black / still front) — release and continue.
        track.stop();
        await sleep(samsung ? 350 : 150);
      } catch (err) {
        lastErr = err;
        if (isPermissionDenied(err)) throw err;
        await sleep(samsung ? 250 : 100);
      }
    }

    // Last resort: facingMode ideal (never exact — exact throws NotReadableError on S24+).
    try {
      const track = await openVideoTrack({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      if (resolveTrackFacing(track) === facing || track.getSettings().deviceId !== exclude) {
        return track;
      }
      track.stop();
    } catch (err) {
      lastErr = err;
      if (isPermissionDenied(err)) throw err;
    }
    return null;
  };

  let track = await tryOpen();
  if (!track) {
    // Second pass after a longer Camera2 cool-down (Samsung IN_USE).
    await sleep(samsung ? 700 : 350);
    track = await tryOpen();
  }

  if (!track) {
    throw lastErr instanceof Error ? lastErr : new Error('switch camera failed');
  }
  return track;
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
    if (opts?.stopTrack) {
      return acquireAndroidSwitchTrack(facing, {
        oldTrack: opts.stopTrack,
        excludeDeviceId: opts.excludeDeviceId,
      });
    }
    return openCameraTrackLikeQr(facing);
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
