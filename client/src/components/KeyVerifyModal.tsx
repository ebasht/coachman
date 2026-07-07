import { useEffect, useState } from 'react';
import { publicKeyFingerprint } from '../lib/fingerprint';

interface Props {
  myPublicKey: string;
  theirPublicKey: string;
  theirUsername: string;
  onClose: () => void;
}

export function KeyVerifyModal({ myPublicKey, theirPublicKey, theirUsername, onClose }: Props) {
  const [mine, setMine] = useState('');
  const [theirs, setTheirs] = useState('');

  useEffect(() => {
    publicKeyFingerprint(myPublicKey).then(setMine);
    publicKeyFingerprint(theirPublicKey).then(setTheirs);
  }, [myPublicKey, theirPublicKey]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal key-verify-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Сверка ключей</h2>
        <p className="modal-subtitle">
          Сравните коды лично или по другому каналу с @{theirUsername}
        </p>

        <div className="fingerprint-block">
          <span className="fingerprint-label">Ваш ключ</span>
          <code className="fingerprint-code">{mine || '…'}</code>
        </div>
        <div className="fingerprint-block">
          <span className="fingerprint-label">Ключ @{theirUsername}</span>
          <code className="fingerprint-code">{theirs || '…'}</code>
        </div>

        <p className="hint">Если коды совпадают — канал защищён от подмены.</p>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
