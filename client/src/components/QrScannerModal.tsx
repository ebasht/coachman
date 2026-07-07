import { useCallback, useEffect, useRef, useState } from 'react';
import { parseInviteToken } from '../lib/invite-link';
import {
  createQrBarcodeDetector,
  decodeQrFromCanvas,
  decodeQrFromFile,
  pickBackCamera,
} from '../lib/qr-decode';
import { Notice } from './Notice';

interface Props {
  onScan: (inviteToken: string) => void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  onScanRef.current = onScan;

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(scanRafRef.current);
    scanRafRef.current = 0;
    decodingRef.current = false;

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
      const token = parseInviteToken(decoded);
      if (!token) {
        setError('В QR-коде нет ссылки приглашения');
        decodingRef.current = false;
        return;
      }
      setError('');
      stopCamera();
      onScanRef.current(token);
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
    if (phase === 'starting' || phase === 'scanning') return;

    setError('');
    setPhase('starting');

    try {
      detectorRef.current = await createQrBarcodeDetector();

      const camera = await pickBackCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camera?.deviceId
          ? { deviceId: { exact: camera.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });

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
  }, [phase, scanFrame, stopCamera]);

  const pickFromGallery = useCallback(
    async (file: File) => {
      setError('');
      setPhase('starting');
      stopCamera();

      try {
        const decoded = await decodeQrFromFile(file);
        if (!decoded) {
          setError('QR-код не найден на изображении');
          setPhase('idle');
          return;
        }
        handleDecoded(decoded);
      } catch (e) {
        setPhase('idle');
        const message = e instanceof Error ? e.message : 'Не удалось прочитать QR-код';
        setError(message);
      }
    },
    [handleDecoded, stopCamera],
  );

  useEffect(() => () => stopCamera(), [stopCamera]);

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Сканировать приглашение</h2>
        <p className="modal-subtitle">
          {phase === 'scanning'
            ? 'Держите QR-код в рамке — распознавание автоматическое'
            : 'Разрешите доступ к камере или выберите фото с QR-кодом'}
        </p>

        <div className={`qr-scanner-view${phase === 'scanning' ? ' qr-scanner-active' : ''}`}>
          <video ref={videoRef} className="qr-scanner-video" playsInline muted />
          {phase === 'scanning' && <div className="qr-scanner-frame" aria-hidden />}
        </div>
        <canvas ref={canvasRef} className="sr-only" aria-hidden />

        {phase !== 'scanning' && (
          <div className="qr-scanner-actions">
            <button type="button" className="qr-scan-btn" onClick={startCamera} disabled={phase === 'starting'}>
              {phase === 'starting' ? 'Запуск камеры...' : 'Включить камеру'}
            </button>
            <button
              type="button"
              className="invite-apply-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={phase === 'starting'}
            >
              Выбрать из галереи
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void pickFromGallery(file);
              }}
            />
          </div>
        )}

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
