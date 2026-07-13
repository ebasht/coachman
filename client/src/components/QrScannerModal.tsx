import { useCallback, useEffect, useRef, useState } from 'react';
import { parseAuthLink } from '../lib/invite-link';
import {
  createQrBarcodeDetector,
  decodeQrFromCanvas,
  pickBackCamera,
} from '../lib/qr-decode';
import { isAppleMobile } from '../lib/camera-devices';
import { Notice } from './Notice';

interface Props {
  /** Raw QR payload (URL or token). Caller parses invite/bootstrap. */
  onScan: (raw: string) => void;
  onClose: () => void;
}

type Phase = 'idle' | 'starting' | 'scanning';

export function QrScannerModal({ onScan, onClose }: Props) {
  const onScanRef = useRef(onScan);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRafRef = useRef(0);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const decodingRef = useRef(false);
  const cameraActiveRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  onScanRef.current = onScan;

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(scanRafRef.current);
    scanRafRef.current = 0;
    decodingRef.current = false;
    cameraActiveRef.current = false;

    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }

    setPhase('idle');
  }, []);

  const handleDecoded = useCallback(
    (decoded: string) => {
      if (!parseAuthLink(decoded)) {
        setError('В QR-коде нет ссылки приглашения или bootstrap');
        decodingRef.current = false;
        return;
      }
      setError('');
      stopCamera();
      onScanRef.current(decoded);
    },
    [stopCamera],
  );

  const scanFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || decodingRef.current || video.readyState < video.HAVE_ENOUGH_DATA) {
      scanRafRef.current = requestAnimationFrame(() => {
        void scanFrame();
      });
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      scanRafRef.current = requestAnimationFrame(() => {
        void scanFrame();
      });
      return;
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, width, height);
    decodingRef.current = true;

    try {
      const decoded = await decodeQrFromCanvas(canvas, detectorRef.current);
      if (decoded) {
        handleDecoded(decoded);
        return;
      }
    } finally {
      decodingRef.current = false;
    }

    scanRafRef.current = requestAnimationFrame(() => {
      void scanFrame();
    });
  }, [handleDecoded]);

  const startCamera = useCallback(async () => {
    if (cameraActiveRef.current) return;

    setError('');
    setPhase('starting');
    cameraActiveRef.current = true;

    try {
      detectorRef.current = await createQrBarcodeDetector();

      // iOS: facingMode only — deviceId + exact often re-triggers the permission sheet.
      let stream: MediaStream;
      if (isAppleMobile()) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } else {
        const camera = await pickBackCamera();
        stream = await navigator.mediaDevices.getUserMedia({
          video: camera?.deviceId
            ? { deviceId: { exact: camera.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Видео не инициализировано');

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      setPhase('scanning');
      scanRafRef.current = requestAnimationFrame(() => {
        void scanFrame();
      });
    } catch (e) {
      stopCamera();
      const message = e instanceof Error ? e.message : 'Не удалось открыть камеру';
      setError(message);
    }
  }, [scanFrame, stopCamera]);

  useEffect(() => {
    void startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Сканировать приглашение</h2>
        <p className="modal-subtitle">
          {phase === 'starting'
            ? 'Запуск камеры...'
            : phase === 'scanning'
              ? 'Держите QR-код в рамке'
              : 'Разрешите доступ к камере в настройках'}
        </p>

        <div className={`qr-scanner-view${phase !== 'idle' ? ' qr-scanner-active' : ''}`}>
          <video ref={videoRef} className="qr-scanner-video" playsInline muted />
          {phase === 'scanning' && <div className="qr-scanner-frame" aria-hidden />}
        </div>
        <canvas ref={canvasRef} className="sr-only" aria-hidden />

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" onClick={handleClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
