import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, type AdminUser } from '../lib/api';
import {
  buildRecoveryLink,
  decryptKeyBackupAsAdmin,
  wrapRecoveryBundle,
  type RecoveryKeyBundle,
} from '../lib/login-recovery';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

interface Props {
  user: AdminUser;
  /** Current admin ECDH private key — decrypts escrow for other users. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** When recovering self, use local keys instead of escrow. */
  selfBundle?: RecoveryKeyBundle | null;
  onClose: () => void;
}

export function RecoveryQrModal({
  user,
  adminPrivateKey,
  adminPublicKey,
  selfBundle,
  onClose,
}: Props) {
  const [link, setLink] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        let bundle: RecoveryKeyBundle;
        if (selfBundle) {
          bundle = selfBundle;
        } else {
          const { ciphertext } = await api.getAdminUserKeyBackup(user.id);
          bundle = await decryptKeyBackupAsAdmin(ciphertext, adminPrivateKey, adminPublicKey);
        }
        const wrapped = await wrapRecoveryBundle(bundle);
        const session = await api.createLoginRecovery(user.id, wrapped.ciphertext);
        if (cancelled) return;
        setLink(buildRecoveryLink(session.token, wrapped.keyB64Url));
        setExpiresAt(session.expiresAt);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '';
        let message = 'Не удалось создать QR восстановления';
        if (/backup not found/i.test(msg)) {
          message =
            'Нет резервной копии ключей. Попросите пользователя открыть приложение хотя бы раз.';
        } else if (/forbidden/i.test(msg)) {
          message = 'Нет доступа';
        } else if (msg) {
          message = msg;
        }
        setError(message);
        notify.error(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id, adminPrivateKey, adminPublicKey, selfBundle]);

  useEffect(() => {
    if (!link) {
      setQrDataUrl('');
      return;
    }
    void QRCode.toDataURL(link, {
      width: 280,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).then(setQrDataUrl);
  }, [link]);

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    notify.success('Ссылка скопирована');
    setTimeout(() => setCopied(false), 2000);
  };

  const expiresLabel =
    expiresAt != null
      ? new Date(expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Вход на новом устройстве</h2>
        <p className="modal-subtitle">
          QR для {user.username}. Можно войти на нескольких устройствах — история
          расшифруется на каждом.
        </p>

        {loading && <p className="hint">Создание ссылки…</p>}
        {error && <Notice variant="error">{error}</Notice>}

        {!loading && !error && link && (
          <>
            {qrDataUrl && (
              <div className="invite-qr-wrap">
                <img src={qrDataUrl} alt="QR-код восстановления входа" className="invite-qr" />
                <p className="invite-qr-hint">
                  Действует до {expiresLabel ?? 'истечения'}
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
