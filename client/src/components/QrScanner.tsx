import { lazy, Suspense } from 'react';

const QrScannerModalLazy = lazy(() =>
  import('./QrScannerModal').then((m) => ({ default: m.QrScannerModal })),
);

interface Props {
  onScan: (inviteToken: string) => void;
  onClose: () => void;
}

export function QrScanner({ onScan, onClose }: Props) {
  return (
    <Suspense
      fallback={
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Сканировать приглашение</h2>
            <p className="modal-subtitle">Загрузка камеры...</p>
          </div>
        </div>
      }
    >
      <QrScannerModalLazy onScan={onScan} onClose={onClose} />
    </Suspense>
  );
}
