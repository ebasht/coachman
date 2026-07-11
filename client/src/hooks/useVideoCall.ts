import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureIceConfig, getIceServers, type CallPhase, type CallSignal } from '../lib/call-types';
import { icePathToSignal, inspectIcePath } from '../lib/ice-path';

type SendSignal = (signal: Omit<CallSignal, 'fromUserId'>) => void;

type StartOpts = {
  chatId: string;
  peerName: string;
};

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

async function acquireLocalMedia(): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { audio: true, video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } } },
    { audio: true, video: true },
    { audio: true, video: { facingMode: 'user' } },
  ];
  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
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

export function useVideoCall(userId: string | undefined, sendSignal: SendSignal) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [peerName, setPeerName] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
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
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceReportedRef = useRef(false);
  const sendRef = useRef(sendSignal);
  sendRef.current = sendSignal;
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
  }, [clearDisconnectTimer, clearIceFailTimer]);

  const reset = useCallback(() => {
    cleanupMedia();
    setPhase('idle');
    setPeerName('');
    setChatId(null);
    setCallId(null);
    setMuted(false);
    setCameraOff(false);
    setError('');
    politeRef.current = false;
  }, [cleanupMedia]);

  const ensureLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await acquireLocalMedia();
    localStreamRef.current = stream;
    bindStream(localVideoRef.current, stream);
    return stream;
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
      setPhase('active');
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
            if (id && cId && phaseRef.current !== 'idle') {
              sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
            }
            reset();
          }
        }, 8000);
        return;
      }
      if (state === 'failed' || state === 'closed') {
        clearDisconnectTimer();
        if (phaseRef.current !== 'idle') {
          const id = callIdRef.current;
          const cId = chatIdRef.current;
          if (id && cId && state === 'failed') {
            reportIcePath(false);
            sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
          }
          if (state === 'failed') {
            setError('Соединение не установилось (часто без TURN).');
          }
          // Delay reset slightly so user can read the error
          setTimeout(() => {
            if (phaseRef.current !== 'idle') reset();
          }, state === 'failed' ? 2500 : 0);
        }
      }
    };

    const local = await ensureLocalMedia();
    for (const track of local.getTracks()) {
      pc.addTrack(track, local);
    }
    preferH264(pc);
    updateConnLabel();
    return pc;
  }, [clearDisconnectTimer, clearIceFailTimer, ensureLocalMedia, reset]);

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
    if (id && cId && phaseRef.current !== 'idle') {
      sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
    }
    reset();
  }, [reset]);

  const startCall = useCallback(
    async ({ chatId: cId, peerName: name }: StartOpts) => {
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
      setChatId(cId);
      setCallId(id);
      setPeerName(name);
      setPhase('outgoing');
      sendRef.current({ chatId: cId, callId: id, action: 'invite' });
    },
    [ensureLocalMedia],
  );

  const acceptCall = useCallback(async () => {
    if (phaseRef.current !== 'incoming' || !callIdRef.current || !chatIdRef.current) return;
    setError('');
    try {
      await ensureLocalMedia();
    } catch {
      setError('Нет доступа к камере или микрофону');
      sendRef.current({
        chatId: chatIdRef.current,
        callId: callIdRef.current,
        action: 'reject',
      });
      reset();
      return;
    }
    politeRef.current = true;
    setPhase('connecting');
    sendRef.current({
      chatId: chatIdRef.current,
      callId: callIdRef.current,
      action: 'accept',
    });
    await ensurePeerConnection();
  }, [ensureLocalMedia, ensurePeerConnection, reset]);

  const rejectCall = useCallback(() => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (id && cId) {
      sendRef.current({ chatId: cId, callId: id, action: 'reject' });
    }
    reset();
  }, [reset]);

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

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      if (!userId) return;
      if (signal.fromUserId && signal.fromUserId === userId) return;

      const { action } = signal;

      if (action === 'invite') {
        if (phaseRef.current !== 'idle') {
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'reject',
          });
          return;
        }
        chatIdRef.current = signal.chatId;
        callIdRef.current = signal.callId;
        phaseRef.current = 'incoming';
        setChatId(signal.chatId);
        setCallId(signal.callId);
        setPhase('incoming');
        return;
      }

      if (callIdRef.current && signal.callId !== callIdRef.current) return;

      if (action === 'reject' || action === 'hangup') {
        reset();
        return;
      }

      if (action === 'accept') {
        if (phaseRef.current !== 'outgoing') return;
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
    [ensurePeerConnection, flushIce, hangup, reset, userId],
  );

  useEffect(() => {
    return () => {
      cleanupMedia();
    };
  }, [cleanupMedia]);

  return {
    phase,
    peerName,
    chatId,
    error,
    connLabel,
    muted,
    cameraOff,
    startCall,
    acceptCall,
    rejectCall,
    hangup,
    toggleMute,
    toggleCamera,
    attachLocalVideo,
    attachRemoteVideo,
    handleSignal,
    setPeerName,
  };
}
