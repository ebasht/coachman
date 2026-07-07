import { useState } from 'react';
import { api } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

interface Props {
  onClose: () => void;
}

export function InviteModal({ onClose }: Props) {
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setLoading(true);
    setError('');
    try {
      const { token } = await api.createInvite();
      const url = `${window.location.origin}/?invite=${token}`;
      setLink(url);
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Пригласить друга</h2>
        <p className="modal-subtitle">
          Одноразовая ссылка. После регистрации новый участник попадёт в ваш круг.
        </p>

        {!link ? (
          <button type="button" className="invite-create-btn" onClick={create} disabled={loading}>
            {loading ? 'Создание...' : 'Создать ссылку'}
          </button>
        ) : (
          <div className="invite-link-box">
            <input type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button type="button" className="invite-copy-btn" onClick={copy}>
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        )}

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
