import { useEffect } from 'react';
import { startCallRingtone, stopCallRingtone } from '../lib/call-ringtone';

interface Props {
  phase: 'outgoing' | 'incoming' | 'connecting' | 'active';
  peerName: string;
  error?: string;
  connLabel?: string;
  muted: boolean;
  cameraOff: boolean;
  onAccept: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  localVideoRef: (el: HTMLVideoElement | null) => void;
  remoteVideoRef: (el: HTMLVideoElement | null) => void;
}

function peerInitial(name: string) {
  const cleaned = name.replace(/^@/, '').trim();
  return (cleaned[0] || '?').toUpperCase();
}

export function VideoCallOverlay({
  phase,
  peerName,
  error,
  connLabel,
  muted,
  cameraOff,
  onAccept,
  onReject,
  onHangup,
  onToggleMute,
  onToggleCamera,
  localVideoRef,
  remoteVideoRef,
}: Props) {
  const ringing = phase === 'incoming' || phase === 'outgoing';

  useEffect(() => {
    if (ringing) {
      startCallRingtone();
      return () => stopCallRingtone();
    }
    stopCallRingtone();
    return undefined;
  }, [ringing]);

  const status =
    phase === 'outgoing'
      ? 'Вызов…'
      : phase === 'incoming'
        ? 'Входящий звонок'
        : phase === 'connecting'
          ? 'Соединение…'
          : peerName;

  if (ringing) {
    return (
      <div className="video-call-overlay video-call-ringing" role="dialog" aria-modal="true" aria-label="Звонок">
        <div className="video-call-ring-stage">
          <div className="video-call-pulse" aria-hidden />
          <div className="video-call-pulse video-call-pulse-delay" aria-hidden />
          <div className="video-call-avatar" aria-hidden>
            {peerInitial(peerName)}
          </div>
          <p className="video-call-peer-lg">{peerName}</p>
          <p className="video-call-status-lg">{status}</p>
          {error && <p className="video-call-error">{error}</p>}
        </div>

        <div className="video-call-actions video-call-actions-ring">
          {phase === 'incoming' ? (
            <>
              <button type="button" className="video-call-fab reject" onClick={onReject} aria-label="Отклонить">
                <span className="video-call-fab-icon" aria-hidden>
                  ✕
                </span>
                <span className="video-call-fab-label">Отклонить</span>
              </button>
              <button type="button" className="video-call-fab accept" onClick={onAccept} aria-label="Принять">
                <span className="video-call-fab-icon" aria-hidden>
                  ☎
                </span>
                <span className="video-call-fab-label">Принять</span>
              </button>
            </>
          ) : (
            <button type="button" className="video-call-fab reject" onClick={onHangup} aria-label="Сбросить">
              <span className="video-call-fab-icon" aria-hidden>
                ✕
              </span>
              <span className="video-call-fab-label">Сбросить</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="video-call-overlay" role="dialog" aria-modal="true" aria-label="Видеозвонок">
      <video className="video-call-remote" ref={remoteVideoRef} autoPlay playsInline muted={false} />
      <video
        className={`video-call-local ${cameraOff ? 'hidden' : ''}`}
        ref={localVideoRef}
        autoPlay
        playsInline
        muted
      />

      <div className="video-call-top">
        <p className="video-call-peer">{peerName}</p>
        <p className="video-call-status">{status}</p>
        {connLabel && <p className="video-call-conn">{connLabel}</p>}
        {error && <p className="video-call-error">{error}</p>}
      </div>

      <div className="video-call-actions">
        <button
          type="button"
          className={`video-call-btn secondary ${muted ? 'active' : ''}`}
          onClick={onToggleMute}
          aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {muted ? 'Микрофон выкл.' : 'Микрофон'}
        </button>
        <button
          type="button"
          className={`video-call-btn secondary ${cameraOff ? 'active' : ''}`}
          onClick={onToggleCamera}
          aria-label={cameraOff ? 'Включить камеру' : 'Выключить камеру'}
        >
          {cameraOff ? 'Камера выкл.' : 'Камера'}
        </button>
        <button type="button" className="video-call-btn reject" onClick={onHangup} aria-label="Завершить">
          Завершить
        </button>
      </div>
    </div>
  );
}
