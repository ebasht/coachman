import jsQR from 'jsqr';

export async function createQrBarcodeDetector(): Promise<BarcodeDetector | null> {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const BarcodeDetectorCtor = window.BarcodeDetector!;
    const supported = await BarcodeDetectorCtor.getSupportedFormats();
    if (!supported.includes('qr_code')) return null;
    return new BarcodeDetectorCtor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export function decodeQrFromImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data ?? null;
}

export async function decodeQrFromCanvas(
  canvas: HTMLCanvasElement,
  detector: BarcodeDetector | null,
): Promise<string | null> {
  if (detector) {
    try {
      const codes = await detector.detect(canvas);
      if (codes[0]?.rawValue) return codes[0].rawValue;
    } catch {
      // fall through to jsQR
    }
  }

  const maxDim = 960;
  const { width, height } = canvas;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const scanWidth = Math.max(1, Math.floor(width * scale));
  const scanHeight = Math.max(1, Math.floor(height * scale));

  const scanCanvas = scale < 1 ? document.createElement('canvas') : canvas;
  if (scale < 1) {
    scanCanvas.width = scanWidth;
    scanCanvas.height = scanHeight;
    const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    if (!scanCtx) return null;
    scanCtx.drawImage(canvas, 0, 0, scanWidth, scanHeight);
  }

  const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const imageData = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  return decodeQrFromImageData(imageData);
}

export async function decodeQrFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const detector = await createQrBarcodeDetector();
  return decodeQrFromCanvas(canvas, detector);
}

export async function pickBackCamera(): Promise<MediaDeviceInfo | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  if (cameras.length === 0) return null;
  const back = cameras.find((c) => /back|rear|environment|задн/i.test(c.label));
  return back ?? cameras[cameras.length - 1];
}
