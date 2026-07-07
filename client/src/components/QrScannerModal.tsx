import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { parseInviteToken } from '../lib/invite-link';
import { Notice } from './Notice';

interface Props {
  onScan: (inviteToken: string) => void;
  onClose: () => void;
}

export function QrScannerModal({ onScan, onClose }: Props) {
  const [error, setError] = useState('');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const elementId = 'qr-scanner-view';
    const scanner = new Html5Qrcode(elementId);
    scannerRef.current = scanner;

    const onDecoded = (decoded: string) => {
      const token = parseInviteToken(decoded);
      if (!token) {
        setError('В QR-коде нет ссылки приглашения');
        return;
      }
      void scanner.stop().finally(() => {
        startedRef.current = false;
        onScan(token);
      });
    };

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onDecoded,
        () => {},
      )
      .then(() => {
        startedRef.current = true;
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : 'Не удалось открыть камеру';
        setError(message);
      });

    return () => {
      const active = scannerRef.current;
      scannerRef.current = null;
      if (!active || !startedRef.current) return;
      void active.stop().catch(() => {});
    };
  }, [onScan]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Сканировать приглашение</h2>
        <p className="modal-subtitle">Наведите камеру на QR-код со ссылкой приглашения</p>
        <div id="qr-scanner-view" className="qr-scanner-view" />
        {error && <Notice variant="error">{error}</Notice>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
