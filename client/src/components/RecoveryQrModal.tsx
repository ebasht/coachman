import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type AdminUser } from '../lib/api';
import {
  decryptKeyBackupAsAdmin,
  type RecoveryKeyBundle,
} from '../lib/login-recovery';
import { createSerialQueue, issueRecoveryLink } from '../lib/issue-recovery-link';
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
  /** Bumps on each effect run so a stale create cannot win the race (Strict Mode). */
  const issueGenRef = useRef(0);
  const enqueueRef = useRef(createSerialQueue());

  useEffect(() => {
    const gen = ++issueGenRef.current;
    let cancelled = false;
    const isStale = () => cancelled || gen !== issueGenRef.current;

    (async () => {
      setLoading(true);
      setError('');
      setLink('');
      setExpiresAt(null);
      try {
        let bundle: RecoveryKeyBundle;
        if (selfBundle) {
          bundle = selfBundle;
        } else {
          const { ciphertext } = await api.getAdminUserKeyBackup(user.id);
          if (isStale()) return;
          bundle = await decryptKeyBackupAsAdmin(ciphertext, adminPrivateKey, adminPublicKey);
        }
        if (isStale()) return;

        // Serialize creates: a late createLoginRecovery deletes the newer token on the
        // server while the UI still shows that newer link → "Ссылка недействительна".
        const issued = await enqueueRef.current(() =>
          issueRecoveryLink({
            userId: user.id,
            bundle,
            createLoginRecovery: api.createLoginRecovery,
            isStale,
          }),
        );
        if (isStale() || !issued) return;

        setLink(issued.link);
        setExpiresAt(issued.expiresAt);
      } catch (e) {
        if (isStale()) return;
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
        if (!isStale()) setLoading(false);
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
