import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { AdminUser } from '../lib/api';
import { Notice } from './Notice';
import { notify } from '../lib/notify';

export type IssuedRecovery = {
  link: string;
  expiresAt: number;
};

interface Props {
  user: AdminUser;
  /** Pre-issued recovery session — created once on button click, not in an effect. */
  issued: IssuedRecovery;
  onClose: () => void;
}

export function RecoveryQrModal({ user, issued, onClose }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const link = issued.link;

  useEffect(() => {
    if (!link) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(link, {
      width: 280,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    notify.success('Ссылка скопирована');
    setTimeout(() => setCopied(false), 2000);
  };

  const expiresLabel = new Date(issued.expiresAt).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Вход на новом устройстве</h2>
        <p className="modal-subtitle">
          QR для {user.username}. Можно войти на нескольких устройствах — история
          расшифруется на каждом.
        </p>

        {!link && <Notice variant="error">Ссылка восстановления не создана</Notice>}

        {link && (
          <>
            {qrDataUrl && (
              <div className="invite-qr-wrap">
                <img src={qrDataUrl} alt="QR-код восстановления входа" className="invite-qr" />
                <p className="invite-qr-hint">
                  Действует до {expiresLabel}
                  {' · '}несколько устройств
                </p>
              </div>
            )}
            <div className="invite-link-box">
              <input type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="invite-copy-btn" onClick={() => void copy()}>
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
