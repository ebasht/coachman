interface Props {
  phase: 'outgoing' | 'incoming' | 'connecting' | 'active';
  peerName: string;
  error?: string;
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

export function VideoCallOverlay({
  phase,
  peerName,
  error,
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
  const status =
    phase === 'outgoing'
      ? 'Вызов…'
      : phase === 'incoming'
        ? 'Входящий видеозвонок'
        : phase === 'connecting'
          ? 'Соединение…'
          : peerName;

  return (
    <div className="video-call-overlay" role="dialog" aria-modal="true" aria-label="Видеозвонок">
      <video
        className="video-call-remote"
        ref={remoteVideoRef}
        autoPlay
        playsInline
        muted={false}
      />
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
        {error && <p className="video-call-error">{error}</p>}
      </div>

      <div className="video-call-actions">
        {phase === 'incoming' ? (
          <>
            <button type="button" className="video-call-btn accept" onClick={onAccept} aria-label="Принять">
              Принять
            </button>
            <button type="button" className="video-call-btn reject" onClick={onReject} aria-label="Отклонить">
              Отклонить
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
