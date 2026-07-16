import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureIceConfig,
  getIceServers,
  type CallPhase,
  type CallSignal,
} from '../lib/call-types';
import type { CallEventKind, CallEventReport } from '../lib/call-events';
import {
  acquireCameraVideoTrack,
  isAndroidMobile,
  tryApplyFacingMode,
  type VideoFacingMode,
} from '../lib/camera-devices';
import { requestNativeMediaPermissions } from '../lib/native-calls';
import {
  clearPendingCallInvite,
  isCallDismissed,
  loadPendingCallInvite,
  markCallDismissed,
  savePendingCallInvite,
} from '../lib/pending-call-invite';
import { icePathToSignal, inspectIcePath } from '../lib/ice-path';

type SendSignal = (signal: Omit<CallSignal, 'fromUserId'>) => void;

type StartOpts = {
  chatId: string;
  peerName: string;
  peerUserId?: string;
};

const RING_TIMEOUT_MS = 45_000;

async function playMedia(el: HTMLVideoElement | null, { allowUnmute = false } = {}) {
  if (!el) return;
  el.setAttribute('playsinline', 'true');
  el.setAttribute('webkit-playsinline', 'true');
  try {
    await el.play();
  } catch {
    const wasMuted = el.muted;
    el.muted = true;
    try {
      await el.play();
      if (allowUnmute && !wasMuted) el.muted = false;
    } catch {
      // ignore
    }
  }
}

function bindStream(el: HTMLVideoElement | null, stream: MediaStream | null, allowUnmute = false) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) {
    el.srcObject = stream;
  }
  const kick = () => void playMedia(el, { allowUnmute });
  el.onloadedmetadata = kick;
  el.oncanplay = kick;
  kick();
}

async function acquireLocalMedia(facingMode: VideoFacingMode = 'user'): Promise<MediaStream> {
  // Best-effort native permission prompt; WebView getUserMedia may still work if
  // Android already granted camera/mic (e.g. on IncomingCallActivity Accept).
  await requestNativeMediaPermissions().catch(() => false);
  const attempts: MediaStreamConstraints[] = [
    {
      audio: true,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    },
    { audio: true, video: { facingMode } },
    { audio: true, video: true },
  ];
  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      // Repeated getUserMedia after denial re-triggers the iOS permission sheet.
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      ) {
        break;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('getUserMedia failed');
}

function preferH264(pc: RTCPeerConnection) {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs?.length) return;
  const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
  if (!h264.length) return;
  const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
  const ordered = [...h264, ...rest];
  for (const t of pc.getTransceivers()) {
    const kind = t.sender.track?.kind ?? t.receiver.track?.kind;
    if (kind !== 'video') continue;
    try {
      t.setCodecPreferences?.(ordered);
    } catch {
      // unsupported
    }
  }
}

export function useVideoCall(
  userId: string | undefined,
  sendSignal: SendSignal,
  onCallEvent?: (event: CallEventReport) => void,
) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [peerName, setPeerName] = useState('');
  const [peerUserId, setPeerUserId] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [facingMode, setFacingMode] = useState<VideoFacingMode>('user');
  const [error, setError] = useState('');
  const [connLabel, setConnLabel] = useState('');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const makingOfferRef = useRef(false);
  const politeRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const phaseRef = useRef<CallPhase>('idle');
  const callIdRef = useRef<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  const facingModeRef = useRef<VideoFacingMode>('user');
  const switchingCameraRef = useRef(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAtRef = useRef<number | null>(null);
  const eventSentRef = useRef(false);
  const iceReportedRef = useRef(false);
  const sendRef = useRef(sendSignal);
  const onCallEventRef = useRef(onCallEvent);
  sendRef.current = sendSignal;
  onCallEventRef.current = onCallEvent;
  phaseRef.current = phase;
  callIdRef.current = callId;
  chatIdRef.current = chatId;

  const clearDisconnectTimer = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  }, []);

  const clearIceFailTimer = useCallback(() => {
    if (iceFailTimerRef.current) {
      clearTimeout(iceFailTimerRef.current);
      iceFailTimerRef.current = null;
    }
  }, []);

  const clearRingTimer = useCallback(() => {
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }, []);

  const emitCallEvent = useCallback((kind: CallEventKind, durationSec?: number) => {
    if (eventSentRef.current) return;
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (!id || !cId) return;
    eventSentRef.current = true;
    onCallEventRef.current?.({
      chatId: cId,
      callId: id,
      kind,
      durationSec,
    });
  }, []);

  const endKindForPhase = useCallback((phaseNow: CallPhase): CallEventKind => {
    if (phaseNow === 'active') {
      const started = activeAtRef.current;
      return started != null ? 'ended' : 'failed';
    }
    if (phaseNow === 'connecting') return 'failed';
    if (phaseNow === 'outgoing') return 'no_answer';
    if (phaseNow === 'incoming') return 'no_answer';
    return 'failed';
  }, []);

  const durationForActive = useCallback(() => {
    const started = activeAtRef.current;
    if (started == null) return 0;
    return Math.max(0, Math.round((Date.now() - started) / 1000));
  }, []);

  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el && localStreamRef.current) {
      bindStream(el, localStreamRef.current);
    }
  }, []);

  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el && remoteStreamRef.current) {
      bindStream(el, remoteStreamRef.current, true);
    }
  }, []);

  const cleanupMedia = useCallback(() => {
    clearDisconnectTimer();
    clearIceFailTimer();
    clearRingTimer();
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    pendingIceRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    iceReportedRef.current = false;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnLabel('');
  }, [clearDisconnectTimer, clearIceFailTimer, clearRingTimer]);

  const reset = useCallback(() => {
    clearPendingCallInvite(callIdRef.current ?? undefined);
    cleanupMedia();
    phaseRef.current = 'idle';
    callIdRef.current = null;
    chatIdRef.current = null;
    setPhase('idle');
    setPeerName('');
    setPeerUserId(null);
    setChatId(null);
    setCallId(null);
    setMuted(false);
    setCameraOff(false);
    setFacingMode('user');
    facingModeRef.current = 'user';
    setError('');
    politeRef.current = false;
    activeAtRef.current = null;
    eventSentRef.current = false;
  }, [cleanupMedia]);

  const applyIncomingInvite = useCallback(
    (invite: { chatId: string; callId: string; fromUserId?: string }) => {
      if (isCallDismissed(invite.callId)) {
        return false;
      }
      if (callIdRef.current === invite.callId && phaseRef.current !== 'idle') {
        return false;
      }
      if (phaseRef.current !== 'idle') {
        return false;
      }
      chatIdRef.current = invite.chatId;
      callIdRef.current = invite.callId;
      phaseRef.current = 'incoming';
      eventSentRef.current = false;
      activeAtRef.current = null;
      if (invite.fromUserId) {
        setPeerUserId(invite.fromUserId);
      }
      setChatId(invite.chatId);
      setCallId(invite.callId);
      setPhase('incoming');
      savePendingCallInvite({
        chatId: invite.chatId,
        callId: invite.callId,
        fromUserId: invite.fromUserId,
      });
      return true;
    },
    [],
  );

  const markActive = useCallback(() => {
    if (activeAtRef.current == null) {
      activeAtRef.current = Date.now();
    }
    clearRingTimer();
    setPhase('active');
  }, [clearRingTimer]);

  const ensureLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await acquireLocalMedia(facingModeRef.current);
    localStreamRef.current = stream;
    bindStream(localVideoRef.current, stream);
    return stream;
  }, []);

  const replaceLocalVideoTrack = useCallback(async (nextTrack: MediaStreamTrack) => {
    const prev = localStreamRef.current;
    const audioTracks = prev?.getAudioTracks() ?? [];
    const oldVideo = prev?.getVideoTracks()[0] ?? null;
    nextTrack.enabled = oldVideo ? oldVideo.enabled : true;

    const nextStream = new MediaStream([...audioTracks, nextTrack]);
    localStreamRef.current = nextStream;
    bindStream(localVideoRef.current, nextStream);

    const pc = pcRef.current;
    if (pc) {
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(nextTrack);
      } else {
        pc.addTrack(nextTrack, nextStream);
      }
    }

    if (oldVideo && oldVideo !== nextTrack) {
      oldVideo.stop();
    }
  }, []);

  const ensurePeerConnection = useCallback(async () => {
    if (pcRef.current) return pcRef.current;
    await ensureIceConfig();
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 8,
    });
    pcRef.current = pc;

    const remote = new MediaStream();
    remoteStreamRef.current = remote;
    bindStream(remoteVideoRef.current, remote, true);

    pc.ontrack = (ev) => {
      ev.track.onunmute = () => {
        bindStream(remoteVideoRef.current, remoteStreamRef.current, true);
      };
      const inbound = ev.streams[0];
      if (inbound) {
        remoteStreamRef.current = inbound;
        bindStream(remoteVideoRef.current, inbound, true);
      } else {
        remote.addTrack(ev.track);
        remoteStreamRef.current = remote;
        bindStream(remoteVideoRef.current, remote, true);
      }
      markActive();
    };

    pc.onicecandidate = (ev) => {
      const id = callIdRef.current;
      const cId = chatIdRef.current;
      if (!id || !cId) return;
      sendRef.current({
        chatId: cId,
        callId: id,
        action: 'ice',
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      });
    };

    const reportIcePath = (okHint?: boolean) => {
      if (iceReportedRef.current) return;
      const id = callIdRef.current;
      const cId = chatIdRef.current;
      if (!id || !cId) return;
      void inspectIcePath(pc).then((path) => {
        if (iceReportedRef.current) return;
        if (okHint === false) {
          path = { ...path, ok: false };
        }
        if (path.ok || okHint === false) {
          iceReportedRef.current = true;
        }
        sendRef.current(icePathToSignal({ chatId: cId, callId: id }, path));
        const label = path.ok
          ? path.turn
            ? `ok via TURN (${path.localType}/${path.remoteType})`
            : `ok via ${path.via} (${path.localType}/${path.remoteType})`
          : `fail ice=${path.iceState}`;
        setConnLabel(label);
      });
    };

    const updateConnLabel = () => {
      setConnLabel(`${pc.iceConnectionState}/${pc.connectionState}`);
    };
    pc.oniceconnectionstatechange = () => {
      updateConnLabel();
      const ice = pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') {
        clearIceFailTimer();
        setError('');
        // Stats settle shortly after connected.
        window.setTimeout(() => reportIcePath(true), 500);
        return;
      }
      if (ice === 'checking' || ice === 'new') {
        clearIceFailTimer();
        iceFailTimerRef.current = setTimeout(() => {
          if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') {
            setError('Нет P2P-маршрута. Без TURN через разные сети видео часто не проходит.');
          }
        }, 8000);
        return;
      }
      if (ice === 'failed') {
        setError('ICE failed — нужен TURN для этой сети.');
        reportIcePath(false);
      }
    };
    pc.onconnectionstatechange = () => {
      updateConnLabel();
      const state = pc.connectionState;
      if (state === 'connected') {
        clearDisconnectTimer();
        markActive();
        window.setTimeout(() => reportIcePath(true), 500);
        return;
      }
      if (state === 'connecting') {
        clearDisconnectTimer();
        return;
      }
      if (state === 'disconnected') {
        clearDisconnectTimer();
        disconnectTimerRef.current = setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            const id = callIdRef.current;
            const cId = chatIdRef.current;
            const phaseNow = phaseRef.current;
            if (id && cId && phaseNow !== 'idle') {
              const kind = endKindForPhase(phaseNow);
              emitCallEvent(kind, kind === 'ended' ? durationForActive() : undefined);
              sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
            }
            reset();
          }
        }, 8000);
        return;
      }
      if (state === 'failed') {
        clearDisconnectTimer();
        if (phaseRef.current !== 'idle') {
          const id = callIdRef.current;
          const cId = chatIdRef.current;
          if (id && cId) {
            reportIcePath(false);
            emitCallEvent('failed');
            sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
          }
          setError('Соединение не установилось (часто без TURN).');
          setTimeout(() => {
            if (phaseRef.current !== 'idle') reset();
          }, 2500);
        }
        return;
      }
      // Ignore "closed" — it also fires when we tear down locally; must not hang up the peer.
    };

    const local = await ensureLocalMedia();
    for (const track of local.getTracks()) {
      pc.addTrack(track, local);
    }
    preferH264(pc);
    updateConnLabel();
    return pc;
  }, [
    clearDisconnectTimer,
    clearIceFailTimer,
    durationForActive,
    emitCallEvent,
    endKindForPhase,
    ensureLocalMedia,
    markActive,
    reset,
  ]);

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingIceRef.current.splice(0);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore stale candidates
      }
    }
  }, []);

  const hangup = useCallback(() => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    const phaseNow = phaseRef.current;
    if (id) markCallDismissed(id);
    if (id && cId && phaseNow !== 'idle') {
      const kind = endKindForPhase(phaseNow);
      emitCallEvent(kind, kind === 'ended' ? durationForActive() : undefined);
      sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
    }
    reset();
  }, [durationForActive, emitCallEvent, endKindForPhase, reset]);

  const startCall = useCallback(
    async ({ chatId: cId, peerName: name, peerUserId: peerId }: StartOpts) => {
      if (phaseRef.current !== 'idle') return;
      setError('');
      try {
        await ensureLocalMedia();
      } catch {
        setError('Нет доступа к камере или микрофону');
        return;
      }
      const id = crypto.randomUUID();
      politeRef.current = false;
      eventSentRef.current = false;
      activeAtRef.current = null;
      chatIdRef.current = cId;
      callIdRef.current = id;
      phaseRef.current = 'outgoing';
      setChatId(cId);
      setCallId(id);
      setPeerName(name);
      setPeerUserId(peerId ?? null);
      setPhase('outgoing');
      sendRef.current({ chatId: cId, callId: id, action: 'invite' });
      clearRingTimer();
      ringTimerRef.current = setTimeout(() => {
        if (phaseRef.current === 'outgoing' && callIdRef.current === id) {
          emitCallEvent('no_answer');
          sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
          reset();
        }
      }, RING_TIMEOUT_MS);
    },
    [clearRingTimer, emitCallEvent, ensureLocalMedia, reset],
  );

  /**
   * Native Accept: jump straight to connecting (never flash web incoming UI),
   * retry camera/mic, and never auto-send reject on media failure.
   */
  const acceptFromNative = useCallback(
    async (invite: { chatId: string; callId: string; fromUserId?: string }) => {
      if (!invite.chatId || !invite.callId) return;
      if (isCallDismissed(invite.callId)) return;

      // Already accepting / in this call.
      if (
        callIdRef.current === invite.callId &&
        (phaseRef.current === 'connecting' || phaseRef.current === 'active')
      ) {
        return;
      }

      clearPendingCallInvite(invite.callId);
      chatIdRef.current = invite.chatId;
      callIdRef.current = invite.callId;
      phaseRef.current = 'connecting';
      eventSentRef.current = false;
      activeAtRef.current = null;
      politeRef.current = true;
      clearRingTimer();
      if (invite.fromUserId) {
        setPeerUserId(invite.fromUserId);
      }
      setChatId(invite.chatId);
      setCallId(invite.callId);
      setPhase('connecting');
      setError('');

      const chatId = invite.chatId;
      const id = invite.callId;

      // Tell the caller immediately — do not wait for getUserMedia (slow on cold start).
      sendRef.current({
        chatId,
        callId: id,
        action: 'accept',
      });

      let mediaOk = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await ensureLocalMedia();
          mediaOk = true;
          break;
        } catch {
          await new Promise((r) => window.setTimeout(r, 350 + attempt * 200));
        }
      }

      if (!mediaOk) {
        setError('Нет доступа к камере или микрофону');
        emitCallEvent('failed');
        sendRef.current({ chatId, callId: id, action: 'hangup' });
        reset();
        return;
      }

      if (callIdRef.current !== id || phaseRef.current !== 'connecting') return;

      await ensurePeerConnection();
    },
    [clearRingTimer, emitCallEvent, ensureLocalMedia, ensurePeerConnection, reset],
  );

  const acceptCall = useCallback(async () => {
    if (phaseRef.current !== 'incoming' || !callIdRef.current || !chatIdRef.current) return;
    await acceptFromNative({
      chatId: chatIdRef.current,
      callId: callIdRef.current,
    });
  }, [acceptFromNative]);

  const rejectCall = useCallback(() => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (id) markCallDismissed(id);
    if (id && cId) {
      emitCallEvent('rejected');
      sendRef.current({ chatId: cId, callId: id, action: 'reject' });
    }
    clearPendingCallInvite(id ?? undefined);
    reset();
  }, [emitCallEvent, reset]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    setCameraOff(next);
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
  }, [cameraOff]);

  const switchCamera = useCallback(async () => {
    if (switchingCameraRef.current) return;
    if (phaseRef.current === 'idle') return;
    switchingCameraRef.current = true;
    const nextFacing: VideoFacingMode = facingModeRef.current === 'user' ? 'environment' : 'user';
    const oldVideo = localStreamRef.current?.getVideoTracks()[0] ?? null;
    const activeDeviceId = oldVideo?.getSettings().deviceId;
    try {
      // Prefer in-place flip — no new getUserMedia (iOS otherwise re-asks camera).
      // Android WebView lies about applyConstraints success; always reopen there.
      if (
        !isAndroidMobile() &&
        oldVideo &&
        (await tryApplyFacingMode(oldVideo, nextFacing))
      ) {
        facingModeRef.current = nextFacing;
        setFacingMode(nextFacing);
        return;
      }

      // Android: release the camera from WebRTC before stop, or the next
      // getUserMedia often fails / returns the same locked device.
      if (isAndroidMobile() && oldVideo) {
        const pc = pcRef.current;
        const videoSender = pc?.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          try {
            await videoSender.replaceTrack(null);
          } catch {
            /* ignore — still stop below */
          }
        }
        if (localVideoRef.current?.srcObject) {
          localVideoRef.current.srcObject = null;
        }
      }

      const track = await acquireCameraVideoTrack(nextFacing, {
        // Android needs stop-first; iOS must keep the old track until replace.
        stopTrack: oldVideo,
        excludeDeviceId: activeDeviceId,
      });
      facingModeRef.current = nextFacing;
      setFacingMode(nextFacing);
      await replaceLocalVideoTrack(track);
    } catch {
      setError('Не удалось переключить камеру');
      window.setTimeout(() => {
        if (phaseRef.current !== 'idle') setError('');
      }, 2500);
    } finally {
      switchingCameraRef.current = false;
    }
  }, [replaceLocalVideoTrack]);

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      // Invite / end can arrive via SW before auth finishes — do not drop them.
      if (signal.fromUserId && userId && signal.fromUserId === userId) return;

      const { action } = signal;

      if (action === 'invite') {
        // Same invite can arrive via WS + push SW — ignore duplicates.
        if (isCallDismissed(signal.callId)) {
          // Server may re-flush a pending invite after we already declined — stop the caller.
          if (userId) {
            sendRef.current({
              chatId: signal.chatId,
              callId: signal.callId,
              action: 'reject',
            });
          }
          clearPendingCallInvite(signal.callId);
          return;
        }
        if (callIdRef.current === signal.callId && phaseRef.current !== 'idle') {
          return;
        }
        if (phaseRef.current !== 'idle') {
          if (!userId) return;
          onCallEventRef.current?.({
            chatId: signal.chatId,
            callId: signal.callId,
            kind: 'rejected',
          });
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'reject',
          });
          return;
        }
        applyIncomingInvite({
          chatId: signal.chatId,
          callId: signal.callId,
          fromUserId: signal.fromUserId,
        });
        return;
      }

      if (action === 'reject' || action === 'hangup') {
        // Always wipe local pending invite for this callId — hangup may arrive while idle
        // after a push restored UI, or for a prior call while another is active.
        clearPendingCallInvite(signal.callId);
        if (callIdRef.current && signal.callId !== callIdRef.current) return;
        if (action === 'reject' && phaseRef.current === 'outgoing') {
          emitCallEvent('rejected');
        }
        // Hangup/reject from peer: they (or we above) record the chat event.
        reset();
        return;
      }

      if (callIdRef.current && signal.callId !== callIdRef.current) return;

      if (!userId) return;

      if (action === 'accept') {
        if (phaseRef.current !== 'outgoing') return;
        clearRingTimer();
        setPhase('connecting');
        try {
          const pc = await ensurePeerConnection();
          makingOfferRef.current = true;
          preferH264(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'offer',
            sdp: offer.sdp,
          });
        } catch {
          setError('Не удалось начать звонок');
          hangup();
        } finally {
          makingOfferRef.current = false;
        }
        return;
      }

      if (action === 'offer' && signal.sdp) {
        const pc = await ensurePeerConnection();
        const offerCollision =
          makingOfferRef.current || pc.signalingState !== 'stable';
        ignoreOfferRef.current = !politeRef.current && offerCollision;
        if (ignoreOfferRef.current) return;
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await flushIce();
          preferH264(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'answer',
            sdp: answer.sdp,
          });
          setPhase((p) => (p === 'active' ? p : 'connecting'));
        } catch {
          setError('Ошибка соединения');
          hangup();
        }
        return;
      }

      if (action === 'answer' && signal.sdp) {
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushIce();
          setPhase((p) => (p === 'active' ? p : 'connecting'));
        } catch {
          setError('Ошибка соединения');
          hangup();
        }
        return;
      }

      if (action === 'ice') {
        if (!signal.candidate) return;
        const pc = pcRef.current;
        if (!pc || !pc.remoteDescription) {
          pendingIceRef.current.push(signal.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch {
          // ignore
        }
        return;
      }

      // ice-report is server-log only; ignore on peer
    },
    [applyIncomingInvite, clearRingTimer, emitCallEvent, ensurePeerConnection, flushIce, hangup, reset, userId],
  );

  // Restore ringing UI after remount / auth ready (SW invite may have arrived earlier).
  // Skip when already in a call or when a native accept is in flight (pending cleared).
  useEffect(() => {
    if (phaseRef.current !== 'idle') return;
    const pending = loadPendingCallInvite();
    if (!pending) return;
    applyIncomingInvite(pending);
  }, [applyIncomingInvite, userId]);

  useEffect(() => {
    return () => {
      // Only stop media on real unmount of the hook (logout / leave app),
      // not on dependency identity churn mid-call.
      pcRef.current?.close();
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    };
  }, []);

  return {
    phase,
    peerName,
    peerUserId,
    chatId,
    callId,
    error,
    connLabel,
    muted,
    cameraOff,
    facingMode,
    startCall,
    acceptCall,
    acceptFromNative,
    rejectCall,
    hangup,
    toggleMute,
    toggleCamera,
    switchCamera,
    attachLocalVideo,
    attachRemoteVideo,
    handleSignal,
    setPeerName,
  };
}
