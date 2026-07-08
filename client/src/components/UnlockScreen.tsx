import { useState } from 'react';
import { Notice } from './Notice';

import { onEnablePushClick } from '../lib/push-subscribe';

interface Props {
  username: string;
  onUnlock: (passphrase: string) => void;
  error: string;
}

export function UnlockScreen({ username, onUnlock, error }: Props) {
  const [passphrase, setPassphrase] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    onEnablePushClick();
    onUnlock(passphrase);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Ямщик</h1>
        <p className="subtitle">Разблокировка @{username}</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Парольная фраза"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
          {error && <Notice variant="error">{error}</Notice>}
          <button type="submit">Разблокировать</button>
        </form>
        <p className="hint">Ключи зашифрованы на устройстве. Без фразы войти нельзя.</p>
      </div>
    </div>
  );
}
