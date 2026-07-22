import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureIceConfig,
  getIceServers,
  type CallPhase,
  type CallSignal,
  type CallStage,
} from '../lib/call-types';
import type { CallEventKind, CallEventReport } from '../lib/call-events';
import {
  shouldApplyPreviewSdp,
  shouldSendPreviewOffer,
  type NegotiationStage,
} from '../lib/call-preview';
import {
  acquireCameraVideoTrack,
  acquireAndroidSwitchTrack,
  acquireAndroidCallMedia,
  findRtcSender,
  isAndroidMobile,
  pickSwitchCameraTarget,
  resolveTrackFacing,
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

export type CallTerminalInfo = {
  callId: string;
  chatId: string;
  needsUnlock: boolean;
  reason: 'hangup' | 'reject' | 'remote' | 'failed';
};

type StartOpts = {
  chatId: string;
  peerName: string;
  peerUserId?: string;
};

type PcMode = 'preview-recv' | 'preview-send' | 'active';

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

function setTransceiverDirection(pc: RTCPeerConnection, kind: 'audio' | 'video', direction: RTCRtpTransceiverDirection) {
  for (const t of pc.getTransceivers()) {
    const k = t.receiver.track?.kind ?? t.sender.track?.kind;
    if (k === kind) {
      try {
        t.direction = direction;
      } catch {
        // ignore
      }
    }
  }
}

/** Prefer stable video-then-audio order (matches preview transceivers; avoids Safari m-line mismatch). */
async function attachLocalTracks(
  pc: RTCPeerConnection,
  local: MediaStream,
  dirs: { video: RTCRtpTransceiverDirection; audio: RTCRtpTransceiverDirection },
) {
  const video = local.getVideoTracks()[0] ?? null;
  const audio = local.getAudioTracks()[0] ?? null;

  let videoSender = findRtcSender(pc, 'video');
  let audioSender = findRtcSender(pc, 'audio');

  if (!videoSender && video) {
    videoSender = pc.addTrack(video, local);
  } else if (videoSender) {
    await videoSender.replaceTrack(video);
  } else if (!videoSender) {
    pc.addTransceiver('video', { direction: dirs.video });
  }

  if (!audioSender && audio && dirs.audio !== 'inactive' && dirs.audio !== 'recvonly') {
    audioSender = pc.addTrack(audio, local);
  } else if (audioSender) {
    await audioSender.replaceTrack(dirs.audio === 'inactive' ? null : audio);
  } else if (!audioSender) {
    pc.addTransceiver('audio', { direction: dirs.audio });
  }

  setTransceiverDirection(pc, 'video', dirs.video);
  setTransceiverDirection(pc, 'audio', dirs.audio);
}

async function ensureLocalPreviewPlaying(stream: MediaStream, el: HTMLVideoElement | null) {
  // iOS Safari often won't produce frames for WebRTC until the track is rendered.
  if (el) {
    bindStream(el, stream, false);
    try {
      await el.play();
    } catch {
      // ignore autoplay rejection for muted local preview
    }
  }
}

export function useVideoCall(
  userId: string | undefined,
  sendSignal: SendSignal,
  onCallEvent?: (event: CallEventReport) => void,
  onCallTerminal?: (info: CallTerminalInfo) => void,
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
  const [remotePreviewReady, setRemotePreviewReady] = useState(false);

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
  const negotiationStageRef = useRef<NegotiationStage>('none');
  const previewReadySentCallIdRef = useRef<string | null>(null);
  const previewOfferSentCallIdRef = useRef<string | null>(null);
  const acceptedRef = useRef(false);
  const acceptingRef = useRef(false);
  const remoteAudioAllowedRef = useRef(false);
  const sendRef = useRef(sendSignal);
  const onCallEventRef = useRef(onCallEvent);
  const onCallTerminalRef = useRef(onCallTerminal);
  sendRef.current = sendSignal;
  onCallEventRef.current = onCallEvent;
  onCallTerminalRef.current = onCallTerminal;
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

  const emitTerminal = useCallback((reason: CallTerminalInfo['reason'], needsUnlock: boolean) => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (!id || !cId) return;
    onCallTerminalRef.current?.({ callId: id, chatId: cId, needsUnlock, reason });
  }, []);

  const endKindForPhase = useCallback((phaseNow: CallPhase): CallEventKind => {
    if (phaseNow === 'active' || phaseNow === 'ended') {
      const started = activeAtRef.current;
      return started != null ? 'ended' : 'failed';
    }
    if (phaseNow === 'connecting') return acceptedRef.current ? 'failed' : 'no_answer';
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
    if (el) {
      el.muted = !remoteAudioAllowedRef.current;
      if (remoteStreamRef.current) {
        bindStream(el, remoteStreamRef.current, remoteAudioAllowedRef.current);
      }
    }
  }, []);

  const unmuteRemoteAudio = useCallback(() => {
    remoteAudioAllowedRef.current = true;
    const el = remoteVideoRef.current;
    if (el) {
      el.muted = false;
      void playMedia(el, { allowUnmute: true });
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
    negotiationStageRef.current = 'none';
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnLabel('');
    setRemotePreviewReady(false);
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
    acceptedRef.current = false;
    acceptingRef.current = false;
    remoteAudioAllowedRef.current = false;
    previewReadySentCallIdRef.current = null;
    previewOfferSentCallIdRef.current = null;
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
      acceptedRef.current = false;
      acceptingRef.current = false;
      negotiationStageRef.current = 'none';
      setRemotePreviewReady(false);
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
    negotiationStageRef.current = 'active';
    setPhase('active');
    console.info('[call] ACTIVE_CONNECTED callId=', callIdRef.current);
  }, [clearRingTimer]);

  const ensureLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    console.info('[call] LOCAL_MEDIA_REQUESTED callId=', callIdRef.current);
    const stream = await acquireLocalMedia(facingModeRef.current);
    localStreamRef.current = stream;
    bindStream(localVideoRef.current, stream);
    console.info('[call] LOCAL_MEDIA_READY callId=', callIdRef.current);
    return stream;
  }, []);

  const replaceLocalVideoTrack = useCallback(async (nextTrack: MediaStreamTrack) => {
    const prev = localStreamRef.current;
    const audioTracks = prev?.getAudioTracks() ?? [];
    const oldVideo = prev?.getVideoTracks()[0] ?? null;
    nextTrack.enabled = oldVideo ? oldVideo.enabled : true;

    if (prev && oldVideo && oldVideo !== nextTrack) {
      try {
        prev.removeTrack(oldVideo);
      } catch {
        /* ignore */
      }
    }

    const nextStream = new MediaStream([...audioTracks, nextTrack]);
    localStreamRef.current = nextStream;
    bindStream(localVideoRef.current, nextStream);

    const pc = pcRef.current;
    if (pc) {
      const videoSender = findRtcSender(pc, 'video');
      if (videoSender) {
        await videoSender.replaceTrack(nextTrack);
      } else {
        pc.addTrack(nextTrack, nextStream);
      }
    }

    if (oldVideo && oldVideo !== nextTrack && oldVideo.readyState !== 'ended') {
      oldVideo.stop();
    }
  }, []);

  const wirePeerConnection = useCallback(
    (pc: RTCPeerConnection) => {
      const remote = remoteStreamRef.current ?? new MediaStream();
      remoteStreamRef.current = remote;
      bindStream(remoteVideoRef.current, remote, remoteAudioAllowedRef.current);

      pc.ontrack = (ev) => {
        ev.track.onunmute = () => {
          bindStream(remoteVideoRef.current, remoteStreamRef.current, remoteAudioAllowedRef.current);
        };
        const inbound = ev.streams[0];
        if (inbound) {
          remoteStreamRef.current = inbound;
          bindStream(remoteVideoRef.current, inbound, remoteAudioAllowedRef.current);
        } else {
          remote.addTrack(ev.track);
          remoteStreamRef.current = remote;
          bindStream(remoteVideoRef.current, remote, remoteAudioAllowedRef.current);
        }
        const stage = negotiationStageRef.current;
        const phaseNow = phaseRef.current;
        if (stage === 'preview' || phaseNow === 'incoming') {
          setRemotePreviewReady(true);
          console.info('[call] PREVIEW_CONNECTED callId=', callIdRef.current);
          return;
        }
        if (stage === 'active' || phaseNow === 'connecting' || phaseNow === 'active') {
          markActive();
        }
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
          if (
            negotiationStageRef.current === 'active' ||
            phaseRef.current === 'connecting' ||
            phaseRef.current === 'active'
          ) {
            markActive();
          } else if (negotiationStageRef.current === 'preview' || phaseRef.current === 'incoming') {
            setRemotePreviewReady(true);
            console.info('[call] PREVIEW_CONNECTED callId=', callIdRef.current);
          }
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
                emitTerminal('failed', acceptedRef.current);
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
              emitTerminal('failed', acceptedRef.current);
            }
            setError('Соединение не установилось (часто без TURN).');
            setTimeout(() => {
              if (phaseRef.current !== 'idle') reset();
            }, 2500);
          }
        }
      };
      updateConnLabel();
    },
    [
      clearDisconnectTimer,
      clearIceFailTimer,
      durationForActive,
      emitCallEvent,
      emitTerminal,
      endKindForPhase,
      markActive,
      reset,
    ],
  );

  const ensurePeerConnection = useCallback(
    async (mode: PcMode) => {
      if (pcRef.current) {
        if (mode === 'active') {
          const pc = pcRef.current;
          const local = await ensureLocalMedia();
          await ensureLocalPreviewPlaying(local, localVideoRef.current);
          await attachLocalTracks(pc, local, { video: 'sendrecv', audio: 'sendrecv' });
          preferH264(pc);
          negotiationStageRef.current = 'active';
        } else if (mode === 'preview-send') {
          const pc = pcRef.current;
          const local = await ensureLocalMedia();
          await ensureLocalPreviewPlaying(local, localVideoRef.current);
          await attachLocalTracks(pc, local, { video: 'sendonly', audio: 'inactive' });
          preferH264(pc);
          negotiationStageRef.current = 'preview';
        }
        return pcRef.current;
      }

      await ensureIceConfig();
      const pc = new RTCPeerConnection({
        iceServers: getIceServers(),
        iceCandidatePoolSize: 8,
      });
      pcRef.current = pc;
      wirePeerConnection(pc);

      if (mode === 'preview-recv') {
        // Fixed order: video, then audio — must match caller preview-send.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'inactive' });
        negotiationStageRef.current = 'preview';
        preferH264(pc);
        return pc;
      }

      if (mode === 'preview-send') {
        const local = await ensureLocalMedia();
        await ensureLocalPreviewPlaying(local, localVideoRef.current);
        const video = local.getVideoTracks()[0];
        if (video) {
          // Prefer addTrack (Safari-friendly) over addTransceiver(track, { streams }).
          pc.addTrack(video, local);
          setTransceiverDirection(pc, 'video', 'sendonly');
        } else {
          pc.addTransceiver('video', { direction: 'sendonly' });
        }
        pc.addTransceiver('audio', { direction: 'inactive' });
        negotiationStageRef.current = 'preview';
        preferH264(pc);
        return pc;
      }

      // active from scratch — still video-then-audio for SDP stability
      const local = await ensureLocalMedia();
      await ensureLocalPreviewPlaying(local, localVideoRef.current);
      const video = local.getVideoTracks()[0];
      const audio = local.getAudioTracks()[0];
      if (video) pc.addTrack(video, local);
      else pc.addTransceiver('video', { direction: 'sendrecv' });
      if (audio) pc.addTrack(audio, local);
      else pc.addTransceiver('audio', { direction: 'sendrecv' });
      negotiationStageRef.current = 'active';
      preferH264(pc);
      return pc;
    },
    [ensureLocalMedia, wirePeerConnection],
  );

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
    const needsUnlock = acceptedRef.current;
    if (id) markCallDismissed(id);
    if (id && cId && phaseNow !== 'idle' && phaseNow !== 'ended') {
      const kind = endKindForPhase(phaseNow);
      emitCallEvent(kind, kind === 'ended' ? durationForActive() : undefined);
      sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
    }
    console.info('[call] LOCAL_HANGUP callId=', id, 'needsUnlock=', needsUnlock);
    if (id && cId) emitTerminal('hangup', needsUnlock);
    if (needsUnlock) {
      phaseRef.current = 'ended';
      setPhase('ended');
      cleanupMedia();
      return;
    }
    reset();
  }, [cleanupMedia, durationForActive, emitCallEvent, emitTerminal, endKindForPhase, reset]);

  const finishAfterUnlock = useCallback(() => {
    reset();
  }, [reset]);

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
      acceptedRef.current = false;
      negotiationStageRef.current = 'none';
      previewOfferSentCallIdRef.current = null;
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
          emitTerminal('hangup', false);
          reset();
        }
      }, RING_TIMEOUT_MS);
    },
    [clearRingTimer, emitCallEvent, emitTerminal, ensureLocalMedia, reset],
  );

  const bootstrapCalleePreview = useCallback(async () => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (!id || !cId || phaseRef.current !== 'incoming') return;
    if (previewReadySentCallIdRef.current !== id) {
      previewReadySentCallIdRef.current = id;
      sendRef.current({ chatId: cId, callId: id, action: 'preview-ready' });
      console.info('[call] PREVIEW_READY_SENT callId=', id);
    }
    politeRef.current = true;
    try {
      await ensurePeerConnection('preview-recv');
    } catch (e) {
      console.warn('[call] preview-recv pc failed', e);
    }
  }, [ensurePeerConnection]);

  const acceptFromNative = useCallback(
    async (invite: { chatId: string; callId: string; fromUserId?: string }) => {
      if (!invite.chatId || !invite.callId) return;
      if (isCallDismissed(invite.callId)) return;

      if (
        callIdRef.current === invite.callId &&
        (phaseRef.current === 'connecting' ||
          phaseRef.current === 'active' ||
          phaseRef.current === 'ended')
      ) {
        return;
      }
      if (acceptingRef.current && callIdRef.current === invite.callId) return;
      acceptingRef.current = true;
      acceptedRef.current = true;
      console.info('[call] ANSWER_CLICKED callId=', invite.callId);

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
        emitTerminal('failed', true);
        acceptingRef.current = false;
        reset();
        return;
      }

      if (callIdRef.current !== id) {
        acceptingRef.current = false;
        return;
      }

      try {
        const pc = await ensurePeerConnection('active');
        // Wait until preview renegotiation finished (Safari can stay non-stable briefly).
        for (let i = 0; i < 20 && pc.signalingState !== 'stable'; i++) {
          await new Promise((r) => window.setTimeout(r, 50));
        }
        unmuteRemoteAudio();
        makingOfferRef.current = true;
        preferH264(pc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendRef.current({
          chatId,
          callId: id,
          action: 'offer',
          sdp: offer.sdp,
          stage: 'active',
        });
        console.info('[call] ACTIVE_OFFER_SENT callId=', id);
      } catch (e) {
        console.warn('[call] active offer failed', e);
        setError('Не удалось начать звонок');
        emitCallEvent('failed');
        sendRef.current({ chatId, callId: id, action: 'hangup' });
        emitTerminal('failed', true);
        reset();
      } finally {
        makingOfferRef.current = false;
        acceptingRef.current = false;
      }
    },
    [
      clearRingTimer,
      emitCallEvent,
      emitTerminal,
      ensureLocalMedia,
      ensurePeerConnection,
      reset,
      unmuteRemoteAudio,
    ],
  );

  const acceptCall = useCallback(async () => {
    if (
      (phaseRef.current !== 'incoming' && phaseRef.current !== 'connecting') ||
      !callIdRef.current ||
      !chatIdRef.current
    ) {
      return;
    }
    if (phaseRef.current === 'connecting' && acceptedRef.current) return;
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
    if (id && cId) emitTerminal('reject', false);
    reset();
  }, [emitCallEvent, emitTerminal, reset]);

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

  const restartAndroidLocalMedia = useCallback(
    async (facing: VideoFacingMode) => {
      const pc = pcRef.current;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      const prev = localStreamRef.current;
      localStreamRef.current = null;
      prev?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      await new Promise((r) => setTimeout(r, 900));

      const stream = await acquireAndroidCallMedia(facing);
      localStreamRef.current = stream;
      bindStream(localVideoRef.current, stream);

      if (pc) {
        const audio = stream.getAudioTracks()[0] ?? null;
        const video = stream.getVideoTracks()[0] ?? null;
        const audioSender = findRtcSender(pc, 'audio');
        const videoSender = findRtcSender(pc, 'video');
        if (audioSender) await audioSender.replaceTrack(audio);
        else if (audio) pc.addTrack(audio, stream);
        if (videoSender) await videoSender.replaceTrack(video);
        else if (video) pc.addTrack(video, stream);
      }

      const video = stream.getVideoTracks()[0];
      if (video) {
        video.enabled = !cameraOff;
        const got = resolveTrackFacing(video);
        facingModeRef.current = got === 'unknown' ? facing : got;
        setFacingMode(facingModeRef.current);
      }
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !muted;
      });
    },
    [cameraOff, muted],
  );

  const switchCamera = useCallback(async () => {
    if (switchingCameraRef.current) return;
    if (phaseRef.current === 'idle' || phaseRef.current === 'incoming') return;
    switchingCameraRef.current = true;
    const prevFacing = facingModeRef.current;
    const nextFacing: VideoFacingMode = prevFacing === 'user' ? 'environment' : 'user';
    const localStream = localStreamRef.current;
    const oldVideo = localStream?.getVideoTracks()[0] ?? null;
    const activeDeviceId = oldVideo?.getSettings().deviceId;
    const markFacing = (facing: VideoFacingMode) => {
      facingModeRef.current = facing;
      setFacingMode(facing);
    };
    try {
      if (oldVideo && (await tryApplyFacingMode(oldVideo, nextFacing))) {
        markFacing(nextFacing);
        return;
      }

      if (isAndroidMobile()) {
        const track = await acquireAndroidSwitchTrack(nextFacing, {
          oldTrack: oldVideo,
          excludeDeviceId: activeDeviceId,
          beforeStop: async () => {
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = null;
            }
          },
        });
        const gotFacing = resolveTrackFacing(track);
        markFacing(gotFacing === 'unknown' ? nextFacing : gotFacing);
        await replaceLocalVideoTrack(track);
        return;
      }

      const track = await acquireCameraVideoTrack(nextFacing, {
        stopTrack: oldVideo,
        excludeDeviceId: activeDeviceId,
        deviceId: (await pickSwitchCameraTarget(nextFacing, activeDeviceId))?.deviceId,
      });
      const gotFacing = resolveTrackFacing(track);
      markFacing(gotFacing === 'unknown' ? nextFacing : gotFacing);
      await replaceLocalVideoTrack(track);
    } catch (err) {
      if (isAndroidMobile()) {
        try {
          await restartAndroidLocalMedia(nextFacing);
          return;
        } catch {
          try {
            await restartAndroidLocalMedia(prevFacing);
          } catch {
            /* keep error */
          }
        }
      }
      const detail =
        err instanceof DOMException
          ? err.name
          : err instanceof Error
            ? err.message
            : '';
      setError(detail ? `Не удалось переключить камеру (${detail})` : 'Не удалось переключить камеру');
      window.setTimeout(() => {
        if (phaseRef.current !== 'idle') setError('');
      }, 3500);
    } finally {
      switchingCameraRef.current = false;
    }
  }, [replaceLocalVideoTrack, restartAndroidLocalMedia]);

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      if (signal.fromUserId && userId && signal.fromUserId === userId) return;

      const { action } = signal;

      if (action === 'invite') {
        if (isCallDismissed(signal.callId)) {
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

      if (action === 'preview-ready') {
        if (!userId) return;
        if (
          !shouldSendPreviewOffer({
            phase: phaseRef.current,
            callId: callIdRef.current ?? '',
            signalCallId: signal.callId,
            alreadySentForCallId: previewOfferSentCallIdRef.current,
          })
        ) {
          return;
        }
        previewOfferSentCallIdRef.current = signal.callId;
        try {
          const pc = await ensurePeerConnection('preview-send');
          makingOfferRef.current = true;
          preferH264(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'offer',
            sdp: offer.sdp,
            stage: 'preview',
          });
          console.info('[call] PREVIEW_OFFER_SENT callId=', signal.callId);
        } catch {
          previewOfferSentCallIdRef.current = null;
          console.warn('[call] preview offer failed callId=', signal.callId);
        } finally {
          makingOfferRef.current = false;
        }
        return;
      }

      if (action === 'reject' || action === 'hangup') {
        clearPendingCallInvite(signal.callId);
        if (callIdRef.current && signal.callId !== callIdRef.current) return;
        const needsUnlock = acceptedRef.current;
        if (action === 'reject' && phaseRef.current === 'outgoing') {
          emitCallEvent('rejected');
        }
        console.info(
          '[call] REMOTE_HANGUP callId=',
          signal.callId,
          'needsUnlock=',
          needsUnlock,
        );
        if (callIdRef.current && chatIdRef.current) {
          emitTerminal('remote', needsUnlock);
        }
        if (needsUnlock) {
          phaseRef.current = 'ended';
          setPhase('ended');
          cleanupMedia();
          return;
        }
        reset();
        return;
      }

      if (callIdRef.current && signal.callId !== callIdRef.current) return;

      if (!userId) return;

      if (action === 'accept') {
        // Caller: wait for active offer from callee (no auto-offer).
        if (phaseRef.current !== 'outgoing') return;
        clearRingTimer();
        setPhase('connecting');
        phaseRef.current = 'connecting';
        console.info('[call] accept received — awaiting active offer callId=', signal.callId);
        return;
      }

      if (action === 'offer' && signal.sdp) {
        const stage = (signal.stage ?? 'active') as CallStage;
        if (
          !shouldApplyPreviewSdp({
            stage,
            negotiationStage: negotiationStageRef.current,
          })
        ) {
          console.info('[call] ignore late preview offer callId=', signal.callId);
          return;
        }
        if (stage === 'preview') {
          console.info('[call] PREVIEW_OFFER_RECEIVED callId=', signal.callId);
        }

        // Receiving an offer: create PC without forcing local m-line order first when empty,
        // so remote offer defines transceiver layout; then attach local tracks.
        let pc = pcRef.current;
        if (!pc) {
          await ensureIceConfig();
          pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            iceCandidatePoolSize: 8,
          });
          pcRef.current = pc;
          wirePeerConnection(pc);
          if (stage === 'preview') {
            // Callee preview-recv path usually already created PC; keep recvonly if needed.
            pc.addTransceiver('video', { direction: 'recvonly' });
            pc.addTransceiver('audio', { direction: 'inactive' });
          }
        } else if (stage === 'active') {
          await ensurePeerConnection('active');
          pc = pcRef.current!;
        } else if (stage === 'preview' && phaseRef.current === 'incoming') {
          await ensurePeerConnection('preview-recv');
          pc = pcRef.current!;
        }

        if (stage === 'preview') negotiationStageRef.current = 'preview';
        else negotiationStageRef.current = 'active';

        const offerCollision =
          makingOfferRef.current || pc.signalingState !== 'stable';
        ignoreOfferRef.current = !politeRef.current && offerCollision;
        if (ignoreOfferRef.current) {
          console.info('[call] ignore offer collision callId=', signal.callId, 'stage=', stage);
          return;
        }
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await flushIce();

          if (stage === 'active') {
            // Caller (or late PC): attach/send local A/V onto offer-created senders.
            const local = await ensureLocalMedia();
            await ensureLocalPreviewPlaying(local, localVideoRef.current);
            await attachLocalTracks(pc, local, { video: 'sendrecv', audio: 'sendrecv' });
          }

          preferH264(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'answer',
            sdp: answer.sdp,
            stage,
          });
          if (stage === 'preview') {
            console.info('[call] PREVIEW_ANSWER_SENT callId=', signal.callId);
          } else {
            setPhase((p) => (p === 'active' ? p : 'connecting'));
            phaseRef.current =
              phaseRef.current === 'active' ? 'active' : 'connecting';
          }
        } catch (e) {
          console.warn('[call] offer/answer failed', e);
          setError('Ошибка соединения');
          hangup();
        }
        return;
      }

      if (action === 'answer' && signal.sdp) {
        const stage = (signal.stage ?? 'active') as CallStage;
        if (
          !shouldApplyPreviewSdp({
            stage,
            negotiationStage: negotiationStageRef.current,
          })
        ) {
          console.info('[call] ignore late preview answer callId=', signal.callId);
          return;
        }
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushIce();
          if (stage === 'preview') {
            negotiationStageRef.current = 'preview';
          } else {
            negotiationStageRef.current = 'active';
            // Enable local audio after active answer on caller side.
            const local = localStreamRef.current;
            if (local) {
              for (const track of local.getTracks()) {
                const sender = findRtcSender(pc, track.kind as 'audio' | 'video');
                if (sender) await sender.replaceTrack(track);
              }
              setTransceiverDirection(pc, 'video', 'sendrecv');
              setTransceiverDirection(pc, 'audio', 'sendrecv');
            }
            setPhase((p) => (p === 'active' ? p : 'connecting'));
          }
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
    [
      applyIncomingInvite,
      cleanupMedia,
      clearRingTimer,
      emitCallEvent,
      emitTerminal,
      ensureLocalMedia,
      ensurePeerConnection,
      flushIce,
      hangup,
      reset,
      userId,
      wirePeerConnection,
    ],
  );

  // Callee: after auth/WS ready, request preview offer.
  useEffect(() => {
    if (!userId) return;
    if (phase !== 'incoming' || !callId) return;
    void bootstrapCalleePreview();
  }, [bootstrapCalleePreview, callId, phase, userId]);

  useEffect(() => {
    if (phaseRef.current !== 'idle') return;
    const pending = loadPendingCallInvite();
    if (!pending) return;
    applyIncomingInvite(pending);
  }, [applyIncomingInvite, userId]);

  useEffect(() => {
    return () => {
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
    remotePreviewReady,
    startCall,
    acceptCall,
    acceptFromNative,
    rejectCall,
    hangup,
    finishAfterUnlock,
    toggleMute,
    toggleCamera,
    switchCamera,
    attachLocalVideo,
    attachRemoteVideo,
    handleSignal,
    setPeerName,
  };
}
