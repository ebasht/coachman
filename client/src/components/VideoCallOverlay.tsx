import { useEffect, useState, type ReactNode } from 'react';
import { startCallRingtone, stopCallRingtone } from '../lib/call-ringtone';
import { formatCallDuration } from '../lib/call-events';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import type { CallPhase } from '../lib/call-types';

interface Props {
  phase: Exclude<CallPhase, 'idle'>;
  peerName: string;
  peerUserId?: string | null;
  peerHasAvatar?: boolean;
  peerAvatarUpdatedAt?: number | null;
  peerAvatarUrl?: string | null;
  error?: string;
  connLabel?: string;
  muted: boolean;
  cameraOff: boolean;
  facingMode?: 'user' | 'environment';
  remotePreviewReady?: boolean;
  /** When true, IncomingCallRingService owns ringtone — do not play web ringtone. */
  nativeOwnsRingtone?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera?: () => void;
  localVideoRef: (el: HTMLVideoElement | null) => void;
  remoteVideoRef: (el: HTMLVideoElement | null) => void;
  onUiReady?: () => void;
}

function peerInitial(name: string) {
  const cleaned = name.replace(/^@/, '').trim();
  return (cleaned[0] || '?').toUpperCase();
}

function IconPhone({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden fill="currentColor">
      <path
        transform={flip ? 'rotate(135 12 12)' : undefined}
        d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.3 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z"
      />
    </svg>
  );
}

function IconMic({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden fill="currentColor">
      {off ? (
        <>
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" opacity="0.35" />
          <path d="M4.5 4.2 19.8 19.5l-1.4 1.4L14.8 17c-.9.5-1.8.8-2.8.9V21h-1v-3.1A7 7 0 0 1 5 11h1.5a5.5 5.5 0 0 0 6.7 5.3l-1.7-1.7A3 3 0 0 1 9 11V8.4L3.1 2.5 4.5 1.1z" />
        </>
      ) : (
        <>
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
          <path d="M19 11a7 7 0 0 1-6 6.9V21h-2v-3.1A7 7 0 0 1 5 11h1.5a5.5 5.5 0 0 0 11 0H19z" />
        </>
      )}
    </svg>
  );
}

function IconFlipCamera() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden fill="currentColor">
      <path d="M16 7h-1.2l-.9-1.2c-.4-.5-1-.8-1.6-.8H9.7c-.7 0-1.3.3-1.6.8L7.2 7H4c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-4zm-4 10.5A4.5 4.5 0 1 1 16.5 13 4.5 4.5 0 0 1 12 17.5z" />
      <path d="M12 10.2v1.5l2.2-2.1L12 7.5v1.4A3.5 3.5 0 0 0 8.7 14h1.6A2.2 2.2 0 0 1 12 10.2zm3.3 2.8h-1.6A2.2 2.2 0 0 1 12 15.8v-1.5l-2.2 2.1L12 18.5v-1.4a3.5 3.5 0 0 0 3.3-4.1z" />
    </svg>
  );
}

function IconVideo({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden fill="currentColor">
      {off ? (
        <>
          <path
            d="M17 10.5V7a2 2 0 0 0-2-2H5.8L17 16.2V13l4 2.5v-7l-4 2.5z"
            opacity="0.35"
          />
          <path d="M3.1 2.5 20.5 19.9l-1.4 1.4-2.4-2.4A2 2 0 0 1 15 19H5a2 2 0 0 1-2-2V7c0-.4.1-.7.3-1L1.7 3.9 3.1 2.5z" />
        </>
      ) : (
        <>
          <path d="M15 7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h10z" />
          <path d="M17 10.2 21 7.5v9l-4-2.7v-3.6z" />
        </>
      )}
    </svg>
  );
}

function CallRoundButton({
  variant,
  label,
  onClick,
  active,
  children,
}: {
  variant: 'accept' | 'decline' | 'glass' | 'glass-active';
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const cls = [
    'call-round',
    `call-round-${variant}`,
    active ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={cls} onClick={onClick} aria-label={label}>
      <span className="call-round-circle">{children}</span>
      <span className="call-round-label">{label}</span>
    </button>
  );
}

export function VideoCallOverlay({
  phase,
  peerName,
  peerUserId,
  peerHasAvatar,
  peerAvatarUpdatedAt,
  peerAvatarUrl,
  error,
  connLabel,
  muted,
  cameraOff,
  facingMode = 'user',
  remotePreviewReady = false,
  nativeOwnsRingtone = false,
  onAccept,
  onReject,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  localVideoRef,
  remoteVideoRef,
  onUiReady,
}: Props) {
  const outgoingRing = phase === 'outgoing';
  const incomingRing = phase === 'incoming';
  const inCall = phase === 'connecting' || phase === 'active';
  const ended = phase === 'ended';
  const avatarSrc = useAvatarUrl(
    peerUserId || '',
    !!peerHasAvatar,
    peerAvatarUpdatedAt ?? null,
    peerAvatarUrl,
  );
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [localReady, setLocalReady] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc]);

  useEffect(() => {
    if (phase === 'connecting' && !remotePreviewReady) {
      setRemoteReady(false);
      setLocalReady(false);
    }
  }, [phase, remotePreviewReady]);

  useEffect(() => {
    if (remotePreviewReady) setRemoteReady(true);
  }, [remotePreviewReady]);

  useEffect(() => {
    onUiReady?.();
  }, [onUiReady]);

  useEffect(() => {
    const shouldRing = (outgoingRing || incomingRing) && !nativeOwnsRingtone;
    if (shouldRing) {
      startCallRingtone();
      return () => stopCallRingtone();
    }
    stopCallRingtone();
    return undefined;
  }, [outgoingRing, incomingRing, nativeOwnsRingtone]);

  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (phase !== 'active') {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const status =
    phase === 'outgoing'
      ? 'вызов…'
      : phase === 'incoming'
        ? remotePreviewReady
          ? 'входящий видеозвонок'
          : 'Подключение видео…'
        : phase === 'connecting'
          ? 'соединение…'
          : phase === 'ended'
            ? 'Звонок завершён'
            : phase === 'active'
              ? formatCallDuration(elapsedSec)
              : 'видеозвонок';

  const displayName = peerName.replace(/^@/, '');
  const hasPhoto = Boolean(avatarSrc && !avatarFailed);
  const showIncomingPreview = incomingRing;
  const showOutgoingRing = outgoingRing;

  if (ended) {
    return (
      <div className="call-sheet call-sheet-ring" role="dialog" aria-modal="true" aria-label="Звонок завершён">
        <div className="call-ring-center">
          <h1 className="call-name">{displayName}</h1>
          <p className="call-status">Звонок завершён</p>
        </div>
      </div>
    );
  }

  if (showOutgoingRing) {
    return (
      <div className="call-sheet call-sheet-ring" role="dialog" aria-modal="true" aria-label="Звонок">
        <div className="call-sheet-glow" aria-hidden />
        {/* Keep local camera rendering on iOS so WebRTC gets live frames during preview. */}
        <video
          className="call-local-hidden-preview"
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
        />
        <div className="call-ring-center">
          <div className="call-avatar-wrap">
            <div className="call-ring-pulse" aria-hidden />
            <div className="call-ring-pulse call-ring-pulse-2" aria-hidden />
            {hasPhoto ? (
              <img
                className="call-avatar call-avatar-img"
                src={avatarSrc!}
                alt=""
                draggable={false}
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <div className="call-avatar">{peerInitial(peerName)}</div>
            )}
          </div>
          <h1 className="call-name">{displayName}</h1>
          <p className="call-status">{status}</p>
          {error && <p className="call-error">{error}</p>}
        </div>
        <div className="call-controls call-controls-ring">
          <CallRoundButton variant="decline" label="Сбросить" onClick={onHangup}>
            <IconPhone flip />
          </CallRoundButton>
        </div>
      </div>
    );
  }

  if (showIncomingPreview) {
    return (
      <div className="call-sheet call-sheet-live call-sheet-incoming-preview" role="dialog" aria-modal="true" aria-label="Входящий звонок">
        <div className={`call-waiting-stage${remoteReady ? ' is-hidden' : ''}`} aria-hidden={remoteReady}>
          <div className="call-waiting-glow" />
          <div className="call-waiting-glow call-waiting-glow-2" />
          <div className="call-waiting-center">
            <div className="call-avatar-wrap call-waiting-avatar-wrap">
              {!remoteReady && (
                <>
                  <div className="call-ring-pulse" />
                  <div className="call-ring-pulse call-ring-pulse-2" />
                </>
              )}
              {hasPhoto ? (
                <img
                  className="call-avatar call-avatar-img"
                  src={avatarSrc!}
                  alt=""
                  draggable={false}
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                <div className="call-avatar">{peerInitial(peerName)}</div>
              )}
            </div>
            {!remoteReady && <p className="call-waiting-hint">Подключение видео…</p>}
          </div>
        </div>

        <video
          className={`call-remote${remoteReady ? ' is-ready' : ''}`}
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
          onPlaying={() => setRemoteReady(true)}
          onLoadedData={(e) => {
            if (e.currentTarget.videoWidth > 0) setRemoteReady(true);
          }}
        />

        <div className="call-live-top">
          <p className="call-name-sm">{displayName}</p>
          <p className="call-status-sm">{status}</p>
          {error && <p className="call-error">{error}</p>}
        </div>

        <div className="call-controls call-controls-live call-controls-ring-overlay">
          <CallRoundButton variant="decline" label="Отклонить" onClick={onReject}>
            <IconPhone flip />
          </CallRoundButton>
          <CallRoundButton variant="accept" label="Ответить" onClick={onAccept}>
            <IconPhone />
          </CallRoundButton>
        </div>
      </div>
    );
  }

  return (
    <div className="call-sheet call-sheet-live" role="dialog" aria-modal="true" aria-label="Видеозвонок">
      <div className={`call-waiting-stage${remoteReady ? ' is-hidden' : ''}`} aria-hidden={remoteReady}>
        <div className="call-waiting-glow" />
        <div className="call-waiting-glow call-waiting-glow-2" />
        <div className="call-waiting-center">
          <div className="call-avatar-wrap call-waiting-avatar-wrap">
            {!remoteReady && (
              <>
                <div className="call-ring-pulse" />
                <div className="call-ring-pulse call-ring-pulse-2" />
              </>
            )}
            {hasPhoto ? (
              <img
                className="call-avatar call-avatar-img"
                src={avatarSrc!}
                alt=""
                draggable={false}
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <div className="call-avatar">{peerInitial(peerName)}</div>
            )}
          </div>
          {!remoteReady && (
            <p className="call-waiting-hint">
              {phase === 'connecting' ? 'Соединение…' : 'Ожидание видео…'}
            </p>
          )}
        </div>
      </div>

      <video
        className={`call-remote${remoteReady ? ' is-ready' : ''}`}
        ref={remoteVideoRef}
        autoPlay
        playsInline
        muted={false}
        controls={false}
        disablePictureInPicture
        onPlaying={() => setRemoteReady(true)}
        onLoadedData={(e) => {
          if (e.currentTarget.videoWidth > 0) setRemoteReady(true);
        }}
      />

      <div className={`call-local-slot${cameraOff ? ' is-hidden' : ''}`}>
        {!localReady && !cameraOff && (
          <div className="call-local-placeholder" aria-hidden>
            <IconVideo />
          </div>
        )}
        <video
          className={`call-local${localReady ? ' is-ready' : ''}${facingMode === 'user' ? ' is-mirrored' : ''}`}
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
          onPlaying={() => setLocalReady(true)}
          onLoadedData={(e) => {
            if (e.currentTarget.videoWidth > 0) setLocalReady(true);
          }}
        />
      </div>

      <div className="call-live-top">
        <p className="call-name-sm">{displayName}</p>
        <p className="call-status-sm">{status}</p>
        {connLabel && inCall && <p className="call-conn">{connLabel}</p>}
        {error && <p className="call-error">{error}</p>}
      </div>

      <div className="call-controls call-controls-live">
        <CallRoundButton
          variant={muted ? 'glass-active' : 'glass'}
          label={muted ? 'Микр. выкл.' : 'Микрофон'}
          active={muted}
          onClick={onToggleMute}
        >
          <IconMic off={muted} />
        </CallRoundButton>
        <CallRoundButton
          variant={cameraOff ? 'glass-active' : 'glass'}
          label={cameraOff ? 'Камера выкл.' : 'Камера'}
          active={cameraOff}
          onClick={onToggleCamera}
        >
          <IconVideo off={cameraOff} />
        </CallRoundButton>
        {onSwitchCamera && (
          <CallRoundButton
            variant="glass"
            label={facingMode === 'user' ? 'Основная' : 'Фронт.'}
            onClick={onSwitchCamera}
          >
            <IconFlipCamera />
          </CallRoundButton>
        )}
        <CallRoundButton variant="decline" label="Завершить" onClick={onHangup}>
          <IconPhone flip />
        </CallRoundButton>
      </div>
    </div>
  );
}
