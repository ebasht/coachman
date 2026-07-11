import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureIceConfig, getIceServers, type CallPhase, type CallSignal } from '../lib/call-types';

type SendSignal = (signal: Omit<CallSignal, 'fromUserId'>) => void;

type StartOpts = {
  chatId: string;
  peerName: string;
};

export function useVideoCall(userId: string | undefined, sendSignal: SendSignal) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [peerName, setPeerName] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState('');

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
  const sendRef = useRef(sendSignal);
  sendRef.current = sendSignal;
  phaseRef.current = phase;
  callIdRef.current = callId;
  chatIdRef.current = chatId;

  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el && localStreamRef.current) {
      el.srcObject = localStreamRef.current;
    }
  }, []);

  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el && remoteStreamRef.current) {
      el.srcObject = remoteStreamRef.current;
    }
  }, []);

  const cleanupMedia = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    pendingIceRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: 'user' },
    });
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }, []);

  const ensurePeerConnection = useCallback(async () => {
    if (pcRef.current) return pcRef.current;
    await ensureIceConfig();
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    pcRef.current = pc;

    const remote = new MediaStream();
    remoteStreamRef.current = remote;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remote;
    }

    pc.ontrack = (ev) => {
      for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
        remote.addTrack(track);
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remote;
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

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        if (phaseRef.current !== 'idle') {
          const id = callIdRef.current;
          const cId = chatIdRef.current;
          if (id && cId && state === 'failed') {
            sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
          }
          reset();
        }
      }
    };

    const local = await ensureLocalMedia();
    for (const track of local.getTracks()) {
      pc.addTrack(track, local);
    }
    return pc;
  }, [ensureLocalMedia, reset]);

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
      }
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
