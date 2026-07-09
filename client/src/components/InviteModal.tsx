import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { buildInviteLink } from '../lib/invite-link';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

interface Props {
  onClose: () => void;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function InviteModal({ onClose }: Props) {
  const [username, setUsername] = useState('');
  const [link, setLink] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

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

  const create = async () => {
    const normalized = normalizeUsername(username);
    if (!normalized) {
      setError('Введите имя для нового участника');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { token } = await api.createInvite(normalized);
      setLink(buildInviteLink(token));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось создать ссылку';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    notify.success('Ссылка скопирована');
    setTimeout(() => setCopied(false), 2000);
  };

  const reservedUsername = normalizeUsername(username);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Пригласить друга</h2>
        <p className="modal-subtitle">
          Задайте имя участника — оно будет закреплено за одноразовой ссылкой.
        </p>

        {!link ? (
          <>
            <input
              type="text"
              placeholder="Имя нового участника"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              enterKeyHint="done"
            />
            <button type="button" className="invite-create-btn" onClick={create} disabled={loading}>
              {loading ? 'Создание...' : 'Создать ссылку'}
            </button>
          </>
        ) : (
          <>
            <p className="invite-reserved-name">Аккаунт: @{reservedUsername}</p>
            {qrDataUrl && (
              <div className="invite-qr-wrap">
                <img src={qrDataUrl} alt="QR-код приглашения" className="invite-qr" />
                <p className="invite-qr-hint">Отсканируйте в приложении «Ямщик»</p>
              </div>
            )}
            <div className="invite-link-box">
              <input type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="invite-copy-btn" onClick={copy}>
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
          </>
        )}

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
