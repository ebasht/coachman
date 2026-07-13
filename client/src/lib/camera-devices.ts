export type VideoFacingMode = 'user' | 'environment';

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

  if (facing === 'environment') {
    const back = pool.find((c) => /back|rear|environment|задн|facing back/i.test(c.label));
    if (back) return back;
    return pool.length > 1 ? pool[pool.length - 1] : pool[0];
  }

  const front = pool.find((c) => /front|user|selfie|фронт|facing front/i.test(c.label));
  if (front) return front;
  return pool[0];
}

export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  return pickCameraByFacing('environment');
}

const ANDROID_CAMERA_RELEASE_MS = 150;

async function openVideoTrack(constraints: MediaStreamConstraints): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  return track;
}

export async function acquireCameraVideoTrack(
  facing: VideoFacingMode,
  opts?: { stopTrack?: MediaStreamTrack | null; excludeDeviceId?: string },
): Promise<MediaStreamTrack> {
  if (opts?.stopTrack) {
    opts.stopTrack.stop();
    // Samsung / Xiaomi WebView often keeps the previous camera locked until released.
    await new Promise((resolve) => setTimeout(resolve, ANDROID_CAMERA_RELEASE_MS));
  }

  const device = await pickCameraByFacing(facing, opts?.excludeDeviceId);
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

  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await openVideoTrack(constraints);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('switch camera failed');
}
