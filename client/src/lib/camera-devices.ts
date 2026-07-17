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

function isNotReadable(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotReadableError';
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

function acceptSwitchTrack(
  track: MediaStreamTrack,
  facing: VideoFacingMode,
  excludeDeviceId?: string,
): boolean {
  const got = resolveTrackFacing(track);
  if (got === facing) return true;
  const id = track.getSettings().deviceId;
  if (got === 'unknown' && id && id !== excludeDeviceId) return true;
  return false;
}

async function stopIfRejected(track: MediaStreamTrack): Promise<void> {
  try {
    track.stop();
  } catch {
    /* ignore */
  }
}

/** Minimal constraints — fewer NotReadableError on Samsung than width/height + exact. */
async function openByFacingMode(facing: VideoFacingMode): Promise<MediaStreamTrack> {
  try {
    return await openVideoTrack({ audio: false, video: { facingMode: facing } });
  } catch (err) {
    if (isPermissionDenied(err)) throw err;
    return openVideoTrack({
      audio: false,
      video: { facingMode: { ideal: facing } },
    });
  }
}

async function openByDeviceId(deviceId: string): Promise<MediaStreamTrack> {
  return openVideoTrack({
    audio: false,
    video: { deviceId: { exact: deviceId } },
  });
}

async function listFacingCandidates(
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

  const ordered: MediaDeviceInfo[] = [];
  const push = (list: MediaDeviceInfo[]) => {
    for (const c of list) {
      if (!ordered.some((x) => x.deviceId === c.deviceId)) ordered.push(c);
    }
  };
  push(main);
  push(secondary);
  if (facing === 'environment' && unknown.length) {
    push([unknown[unknown.length - 1]]);
  } else if (unknown.length) {
    push([unknown[0]]);
  }
  return ordered;
}

/**
 * Cold-start open like QrScannerModal (deviceId when known).
 */
export async function openCameraTrackLikeQr(
  facing: VideoFacingMode,
): Promise<MediaStreamTrack> {
  if (isAppleMobile()) {
    return openByFacingMode(facing);
  }

  const camera =
    facing === 'environment' ? await pickBackCamera() : await pickFrontCamera();

  if (camera?.deviceId) {
    try {
      const track = await openByDeviceId(camera.deviceId);
      if (acceptSwitchTrack(track, facing)) return track;
      await stopIfRejected(track);
    } catch {
      /* facingMode below */
    }
  }

  return openByFacingMode(facing);
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
    return resolveTrackFacing(track) === facing;
  } catch {
    return false;
  }
}

/**
 * Open the opposite camera. Prefer concurrent open (old track still live) —
 * S24+ can run front+back together; stop→reopen is what triggers NotReadableError
 * when Chromium/WebRTC has not released Camera2 (and replaceTrack(null) makes it worse).
 */
async function tryOpenOppositeCamera(
  facing: VideoFacingMode,
  excludeDeviceId?: string,
): Promise<MediaStreamTrack> {
  let lastErr: unknown;

  // 1) facingMode while old may still be live
  try {
    const track = await openByFacingMode(facing);
    if (acceptSwitchTrack(track, facing, excludeDeviceId)) return track;
    await stopIfRejected(track);
  } catch (err) {
    lastErr = err;
    if (isPermissionDenied(err)) throw err;
  }

  // 2) main lens deviceId (same path as QR scanner)
  const candidates = await listFacingCandidates(facing, excludeDeviceId);
  for (const camera of candidates) {
    try {
      const track = await openByDeviceId(camera.deviceId);
      if (acceptSwitchTrack(track, facing, excludeDeviceId)) return track;
      await stopIfRejected(track);
    } catch (err) {
      lastErr = err;
      if (isPermissionDenied(err)) throw err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new DOMException('Could not start video source', 'NotReadableError');
}

/**
 * Mid-call Android flip:
 *  A) open new camera while old still runs (no replaceTrack(null))
 *  B) if A fails: stop old video only, wait, reopen with facingMode
 */
export async function acquireAndroidSwitchTrack(
  facing: VideoFacingMode,
  opts: {
    oldTrack: MediaStreamTrack | null;
    excludeDeviceId?: string;
    /** Detach preview only — must NOT call replaceTrack(null). */
    beforeStop?: () => Promise<void>;
  },
): Promise<MediaStreamTrack> {
  const samsung = isSamsungDevice();
  const exclude = opts.excludeDeviceId || opts.oldTrack?.getSettings().deviceId;

  // A) Concurrent open — avoids Camera2 IN_USE after a broken teardown.
  try {
    return await tryOpenOppositeCamera(facing, exclude);
  } catch (err) {
    if (isPermissionDenied(err)) throw err;
    if (!isNotReadable(err) && !(err instanceof Error)) throw err;
  }

  // B) Soft release: stop video track, keep PeerConnection sender pointing at ended track.
  //    Never replaceTrack(null) — that leaves Chromium holding the camera on Samsung.
  if (opts.beforeStop) {
    try {
      await opts.beforeStop();
    } catch {
      /* still stop */
    }
  }
  await releaseVideoTrack(opts.oldTrack, samsung ? 1000 : 600);
  await sleep(samsung ? 600 : 300);

  try {
    return await tryOpenOppositeCamera(facing, exclude);
  } catch (err) {
    if (isPermissionDenied(err)) throw err;
  }

  await sleep(samsung ? 900 : 400);
  return tryOpenOppositeCamera(facing, exclude);
}

/** Full A/V restart after total media teardown (last resort). */
export async function acquireAndroidCallMedia(
  facing: VideoFacingMode,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: facing },
    });
  } catch (err) {
    if (isPermissionDenied(err)) throw err;
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: { ideal: facing } },
    });
  }
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
    return openByFacingMode(facing);
  }

  const device = opts?.deviceId
    ? ({ deviceId: opts.deviceId } as MediaDeviceInfo)
    : await pickCameraByFacing(facing, opts?.excludeDeviceId);

  if (device?.deviceId) {
    try {
      return await openByDeviceId(device.deviceId);
    } catch (err) {
      if (isPermissionDenied(err)) throw err;
    }
  }
  return openByFacingMode(facing);
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
