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
import {
  isPreviewReadyAction,
  shouldApplyPreviewSdp,
  shouldSendPreviewOffer,
  type NegotiationStage,
} from '../lib/call-preview';
import {
  assertLiveVideoSender,
  diagnoseLocalDescription,
  isNativeAndroidTransport,
  previewOfferHasNoSendingAudio,
  previewOfferHasSendonlyVideo,
} from '../lib/webrtc-offer-diagnostics';

/** Local media attached when creating / upgrading the Mode A PC. */
type PcMediaMode = 'none' | 'video-sendonly' | 'full';

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
  /** Callee sees caller video while still ringing (Mode A early media). */
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
  /** Mode B: replace outbound video on NativeAndroidCallPeer instead of browser PC. */
  const externalVideoReplaceRef = useRef<((track: MediaStreamTrack) => Promise<void>) | null>(
    null,
  );
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAtRef = useRef<number | null>(null);
  const eventSentRef = useRef(false);
  const iceReportedRef = useRef(false);
  const negotiationStageRef = useRef<NegotiationStage>('none');
  const readySentForCallIdRef = useRef<string | null>(null);
  const previewOfferSentForCallIdRef = useRef<string | null>(null);
  const sendRef = useRef(sendSignal);
  const onCallEventRef = useRef(onCallEvent);
  const onCallTerminalRef = useRef(onCallTerminal);
  const acceptedRef = useRef(false);
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
    negotiationStageRef.current = 'none';
    readySentForCallIdRef.current = null;
    previewOfferSentForCallIdRef.current = null;
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
  }, [cleanupMedia]);

  /** Mode B (native Android peer): drive overlay phase without browser PC. */
  const adoptNativePhase = useCallback(
    (next: 'preview' | 'active' | 'ended', opts?: { reason?: 'hangup' | 'reject' }) => {
      if (next === 'ended') {
        if (phaseRef.current === 'idle' || phaseRef.current === 'ended') return;
        clearRingTimer();
        const phaseNow = phaseRef.current;
        const id = callIdRef.current;
        const cId = chatIdRef.current;
        // Mode B hangup/reject bypasses hangup() — still write the chat marker.
        if (id && cId) {
          if (opts?.reason === 'reject') {
            emitCallEvent('rejected');
          } else {
            const kind = endKindForPhase(phaseNow);
            emitCallEvent(kind, kind === 'ended' ? durationForActive() : undefined);
          }
        }
        reset();
        return;
      }
      clearRingTimer();
      if (next === 'preview') {
        if (phaseRef.current === 'outgoing' || phaseRef.current === 'connecting') {
          phaseRef.current = 'connecting';
          setPhase('connecting');
        }
        return;
      }
      if (phaseRef.current === 'idle') return;
      phaseRef.current = 'active';
      setPhase('active');
      if (activeAtRef.current == null) activeAtRef.current = Date.now();
    },
    [clearRingTimer, durationForActive, emitCallEvent, endKindForPhase, reset],
  );

  const adoptNativeRemoteStream = useCallback((stream: MediaStream | null) => {
    remoteStreamRef.current = stream;
    if (remoteVideoRef.current) {
      if (stream) bindStream(remoteVideoRef.current, stream, true);
      else remoteVideoRef.current.srcObject = null;
    }
  }, []);

  const emitTerminal = useCallback((reason: CallTerminalInfo['reason'], needsUnlock: boolean) => {
    const id = callIdRef.current;
    const cId = chatIdRef.current;
    if (!id || !cId) return;
    onCallTerminalRef.current?.({ callId: id, chatId: cId, needsUnlock, reason });
  }, []);

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

    // Mode B peer owns the outbound sender; Mode A PC is idle for native-android calls.
    if (externalVideoReplaceRef.current) {
      await externalVideoReplaceRef.current(nextTrack);
    } else {
      const pc = pcRef.current;
      if (pc) {
        const videoSender = findRtcSender(pc, 'video');
        if (videoSender) {
          await videoSender.replaceTrack(nextTrack);
        } else {
          pc.addTrack(nextTrack, nextStream);
        }
      }
    }

    if (oldVideo && oldVideo !== nextTrack && oldVideo.readyState !== 'ended') {
      oldVideo.stop();
    }
  }, []);

  const setExternalVideoReplace = useCallback(
    (fn: ((track: MediaStreamTrack) => Promise<void>) | null) => {
      externalVideoReplaceRef.current = fn;
    },
    [],
  );

  const iceStage = useCallback((): CallSignal['stage'] | undefined => {
    const stage = negotiationStageRef.current;
    if (stage === 'preview' || stage === 'active') return stage;
    return undefined;
  }, []);

  const attachLocalMediaToPc = useCallback(
    async (pc: RTCPeerConnection, media: PcMediaMode) => {
      if (media === 'none') return;
      const local = await ensureLocalMedia();
      if (media === 'video-sendonly') {
        const video = local.getVideoTracks()[0];
        if (!video || video.readyState !== 'live') {
          throw new Error('preview video track not live');
        }
        let sender = findRtcSender(pc, 'video');
        if (sender) {
          if (sender.track !== video) await sender.replaceTrack(video);
        } else {
          sender = pc.addTrack(video, local);
        }
        const tr = pc.getTransceivers().find((t) => t.sender === sender);
        if (tr) {
          try {
            tr.direction = 'sendonly';
          } catch {
            /* ignore */
          }
        }
        return;
      }
      for (const track of local.getTracks()) {
        const kind = track.kind as 'audio' | 'video';
        const sender = findRtcSender(pc, kind);
        if (sender) {
          if (sender.track !== track) await sender.replaceTrack(track);
        } else {
          pc.addTrack(track, local);
        }
      }
      for (const tr of pc.getTransceivers()) {
        try {
          tr.direction = 'sendrecv';
        } catch {
          /* ignore */
        }
      }
    },
    [ensureLocalMedia],
  );

  const ensurePeerConnection = useCallback(async (media: PcMediaMode = 'full') => {
    if (pcRef.current) {
      await attachLocalMediaToPc(pcRef.current, media);
      return pcRef.current;
    }
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
        setRemotePreviewReady(true);
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
      // Always surface remote media in the overlay (Android WebView often skips onPlaying).
      setRemotePreviewReady(true);
      if (acceptedRef.current || negotiationStageRef.current === 'active') {
        markActive();
      }
    };

    pc.onicecandidate = (ev) => {
      const id = callIdRef.current;
      const cId = chatIdRef.current;
      if (!id || !cId) return;
      const stage = iceStage();
      sendRef.current({
        chatId: cId,
        callId: id,
        action: 'ice',
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
        ...(stage ? { stage } : {}),
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
        if (acceptedRef.current || negotiationStageRef.current === 'active') {
          markActive();
        } else {
          setRemotePreviewReady(true);
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
    };

    await attachLocalMediaToPc(pc, media);
    updateConnLabel();
    return pc;
  }, [
    attachLocalMediaToPc,
    clearDisconnectTimer,
    clearIceFailTimer,
    durationForActive,
    emitCallEvent,
    endKindForPhase,
    iceStage,
    markActive,
    reset,
  ]);

  const startIncomingPreview = useCallback(
    async (cId: string, id: string) => {
      if (readySentForCallIdRef.current === id) return;
      if (callIdRef.current !== id || phaseRef.current !== 'incoming') return;
      readySentForCallIdRef.current = id;
      negotiationStageRef.current = 'preview';
      try {
        await ensurePeerConnection('none');
        if (callIdRef.current !== id || phaseRef.current !== 'incoming') return;
        sendRef.current({ chatId: cId, callId: id, action: 'ready' });
        console.info('[call] BROWSER_READY_SENT callId=', id);
      } catch (err) {
        console.warn('[call] BROWSER_READY_FAILED', err);
        readySentForCallIdRef.current = null;
        if (negotiationStageRef.current === 'preview') {
          negotiationStageRef.current = 'none';
        }
      }
    },
    [ensurePeerConnection],
  );

  const sendCallerPreviewOffer = useCallback(
    async (signal: CallSignal) => {
      if (
        !shouldSendPreviewOffer({
          phase: phaseRef.current,
          callId: callIdRef.current ?? '',
          signalCallId: signal.callId,
          alreadySentForCallId: previewOfferSentForCallIdRef.current,
        })
      ) {
        return;
      }
      previewOfferSentForCallIdRef.current = signal.callId;
      negotiationStageRef.current = 'preview';
      try {
        const pc = await ensurePeerConnection('video-sendonly');
        makingOfferRef.current = true;
        assertLiveVideoSender(pc);
        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
        await pc.setLocalDescription(offer);
        const diag = diagnoseLocalDescription(pc);
        console.info('[call] BROWSER_PREVIEW_OFFER_SENT', { callId: signal.callId, ...diag });
        if (offer.sdp && !previewOfferHasSendonlyVideo(offer.sdp)) {
          console.warn('[call] preview offer video direction unexpected', diag.videoDirection);
        }
        if (offer.sdp && !previewOfferHasNoSendingAudio(offer.sdp)) {
          console.warn('[call] preview offer unexpectedly sends audio');
        }
        sendRef.current({
          chatId: signal.chatId,
          callId: signal.callId,
          action: 'offer',
          stage: 'preview',
          sdp: offer.sdp,
        });
      } catch (err) {
        console.warn('[call] BROWSER_PREVIEW_OFFER_FAILED', err);
        previewOfferSentForCallIdRef.current = null;
      } finally {
        makingOfferRef.current = false;
      }
    },
    [ensurePeerConnection],
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

  const answerActiveOffer = useCallback(
    async (signal: CallSignal) => {
      if (!signal.sdp) return;
      negotiationStageRef.current = 'active';
      const pc = await ensurePeerConnection('video-sendonly');
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await flushIce();
      const local = await ensureLocalMedia();
      const audio = local.getAudioTracks()[0];
      if (audio) {
        audio.enabled = true;
        const audioSender = findRtcSender(pc, 'audio');
        if (audioSender) await audioSender.replaceTrack(audio);
        else pc.addTrack(audio, local);
      }
      for (const tr of pc.getTransceivers()) {
        try {
          tr.direction = 'sendrecv';
        } catch {
          /* ignore */
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendRef.current({
        chatId: signal.chatId,
        callId: signal.callId,
        action: 'answer',
        stage: 'active',
        sdp: answer.sdp,
      });
      console.info('[call] BROWSER_ACTIVE_ANSWER_SENT callId=', signal.callId);
      setPhase((p) => (p === 'active' ? p : 'connecting'));
    },
    [ensureLocalMedia, ensurePeerConnection, flushIce],
  );

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
    if (id && cId) {
      emitTerminal('hangup', needsUnlock);
    }
    if (needsUnlock) {
      phaseRef.current = 'ended';
      setPhase('ended');
      cleanupMedia();
      return;
    }
    reset();
  }, [cleanupMedia, durationForActive, emitCallEvent, emitTerminal, endKindForPhase, reset]);

  const finishAfterUnlock = useCallback(() => {
    acceptedRef.current = false;
    reset();
  }, [reset]);

  const startCall = useCallback(
    async ({ chatId: cId, peerName: name, peerUserId: peerId }: StartOpts) => {
      if (phaseRef.current !== 'idle') return;
      setError('');
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
      // Show call UI immediately — do not wait for getUserMedia (Android permission lag).
      setPhase('outgoing');
      clearRingTimer();
      ringTimerRef.current = setTimeout(() => {
        if (phaseRef.current === 'outgoing' && callIdRef.current === id) {
          emitCallEvent('no_answer');
          sendRef.current({ chatId: cId, callId: id, action: 'hangup' });
          reset();
        }
      }, RING_TIMEOUT_MS);

      try {
        await ensureLocalMedia();
      } catch {
        setError('Нет доступа к камере или микрофону');
        return;
      }
      if (callIdRef.current !== id || phaseRef.current !== 'outgoing') return;
      sendRef.current({ chatId: cId, callId: id, action: 'invite' });
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
      acceptedRef.current = true;
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

      // If we announced ready, wait briefly for the preview offer before active renegotiation.
      if (readySentForCallIdRef.current === id) {
        for (let i = 0; i < 40; i++) {
          if (pcRef.current?.remoteDescription) break;
          await new Promise((r) => window.setTimeout(r, 100));
          if (callIdRef.current !== id || phaseRef.current !== 'connecting') return;
        }
      }

      negotiationStageRef.current = 'active';
      const pc = await ensurePeerConnection('full');
      // Preview already answered → callee creates active offer (Mode B parity).
      if (pc.remoteDescription) {
        try {
          makingOfferRef.current = true;
          assertLiveVideoSender(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const diag = diagnoseLocalDescription(pc);
          console.info('[call] BROWSER_ACTIVE_OFFER_SENT', { callId: id, ...diag });
          sendRef.current({
            chatId,
            callId: id,
            action: 'offer',
            stage: 'active',
            sdp: offer.sdp,
          });
        } catch {
          setError('Не удалось начать звонок');
          hangup();
        } finally {
          makingOfferRef.current = false;
        }
      }
    },
    [clearRingTimer, emitCallEvent, ensureLocalMedia, ensurePeerConnection, hangup, reset],
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
      // Let Camera2 fully drop before a fresh A/V session (Samsung).
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
    if (phaseRef.current === 'idle') return;
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
        // 1) Open opposite camera first (often works while old track is still live).
        // 2) Only then stop old — never replaceTrack(null) (locks Camera2 on Samsung).
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
      // Last resort on Android: tear down mic+cam and reopen with the target facing.
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
      // Mode B signals are owned by NativeAndroidCallPeer — never mix into browser PC.
      if (isNativeAndroidTransport(signal)) return;

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
        if (
          applyIncomingInvite({
            chatId: signal.chatId,
            callId: signal.callId,
            fromUserId: signal.fromUserId,
          })
        ) {
          void startIncomingPreview(signal.chatId, signal.callId);
        }
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

      // Mode A early media (parity with native Android preview).
      if (isPreviewReadyAction(action)) {
        await sendCallerPreviewOffer(signal);
        return;
      }

      if (action === 'offer' && signal.stage === 'preview' && signal.sdp) {
        if (
          !shouldApplyPreviewSdp({
            stage: 'preview',
            negotiationStage: negotiationStageRef.current,
          })
        ) {
          return;
        }
        try {
          negotiationStageRef.current = 'preview';
          const pc = await ensurePeerConnection('none');
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await flushIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendRef.current({
            chatId: signal.chatId,
            callId: signal.callId,
            action: 'answer',
            stage: 'preview',
            sdp: answer.sdp,
          });
          console.info('[call] BROWSER_PREVIEW_ANSWER_SENT callId=', signal.callId);
        } catch {
          setError('Ошибка превью');
        }
        return;
      }

      if (action === 'answer' && signal.stage === 'preview' && signal.sdp) {
        if (
          !shouldApplyPreviewSdp({
            stage: 'preview',
            negotiationStage: negotiationStageRef.current,
          })
        ) {
          return;
        }
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushIce();
          console.info('[call] BROWSER_PREVIEW_ANSWER_APPLIED callId=', signal.callId);
        } catch {
          setError('Ошибка превью');
        }
        return;
      }

      if (action === 'offer' && signal.stage === 'active' && signal.sdp) {
        try {
          await answerActiveOffer(signal);
        } catch {
          setError('Ошибка соединения');
          hangup();
        }
        return;
      }

      if (action === 'answer' && signal.stage === 'active' && signal.sdp) {
        const pc = pcRef.current;
        if (!pc) return;
        try {
          negotiationStageRef.current = 'active';
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushIce();
          setPhase((p) => (p === 'active' ? p : 'connecting'));
        } catch {
          setError('Ошибка соединения');
          hangup();
        }
        return;
      }

      if (action === 'accept') {
        if (phaseRef.current !== 'outgoing' && phaseRef.current !== 'connecting') return;
        clearRingTimer();
        phaseRef.current = 'connecting';
        setPhase('connecting');
        const waitForActive =
          negotiationStageRef.current === 'preview' ||
          previewOfferSentForCallIdRef.current === signal.callId;
        // Preview already up — wait for callee active offer (do not create a competing offer).
        if (waitForActive) {
          console.info('[call] BROWSER_ACCEPT_WAIT_ACTIVE callId=', signal.callId);
          const acceptCallId = signal.callId;
          window.setTimeout(() => {
            if (callIdRef.current !== acceptCallId) return;
            if (phaseRef.current !== 'connecting') return;
            if (negotiationStageRef.current === 'active') return;
            console.warn('[call] BROWSER_ACCEPT_ACTIVE_TIMEOUT — classic offer fallback');
            void (async () => {
              try {
                negotiationStageRef.current = 'active';
                const pc = await ensurePeerConnection('full');
                if (pc.signalingState !== 'stable') return;
                makingOfferRef.current = true;
                assertLiveVideoSender(pc);
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
            })();
          }, 4000);
          return;
        }
        try {
          const pc = await ensurePeerConnection('full');
          makingOfferRef.current = true;
          assertLiveVideoSender(pc);
          console.info('[call] BROWSER_MEDIA_READY callId=', signal.callId);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const diag = diagnoseLocalDescription(pc);
          console.info('[call] BROWSER_OFFER_DIAG', { callId: signal.callId, ...diag });
          if (!diag.hasVideoMLine || !diag.videoTrackLive) {
            throw new Error('browser offer missing live video');
          }
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
        const pc = await ensurePeerConnection('full');
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
        return;
      }

      // ice-report is server-log only; ignore on peer
    },
    [
      answerActiveOffer,
      applyIncomingInvite,
      clearRingTimer,
      emitCallEvent,
      ensurePeerConnection,
      flushIce,
      hangup,
      reset,
      sendCallerPreviewOffer,
      startIncomingPreview,
      userId,
    ],
  );

  // Restore ringing UI after remount / auth ready (SW invite may have arrived earlier).
  // Skip when already in a call or when a native accept is in flight (pending cleared).
  useEffect(() => {
    if (phaseRef.current !== 'idle') return;
    const pending = loadPendingCallInvite();
    if (!pending) return;
    if (applyIncomingInvite(pending)) {
      void startIncomingPreview(pending.chatId, pending.callId);
    }
  }, [applyIncomingInvite, startIncomingPreview, userId]);

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
    remotePreviewReady,
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
    adoptNativePhase,
    adoptNativeRemoteStream,
    setExternalVideoReplace,
    handleSignal,
    setPeerName,
    finishAfterUnlock,
    getLocalStream: () => localStreamRef.current,
  };
}
