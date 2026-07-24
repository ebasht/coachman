/**
 * Browser/iPhone side of Mode B: native Android incoming video call.
 * Separate from useVideoCall browser flow — do not mix handlers.
 */
import {
  ensureIceConfig,
  getIceServers,
  type CallSignal,
} from './call-types';
import {
  assertLiveVideoSender,
  diagnoseLocalDescription,
  previewOfferHasNoSendingAudio,
  previewOfferHasSendonlyVideo,
} from './webrtc-offer-diagnostics';
import { preferHigherVideoQuality } from './webrtc-video-quality';

export type NativeAndroidSend = (signal: Omit<CallSignal, 'fromUserId'>) => void;

export type NativeAndroidCallPeerOpts = {
  chatId: string;
  callId: string;
  localStream: MediaStream;
  localVideoEl: HTMLVideoElement | null;
  send: NativeAndroidSend;
  onPhase?: (phase: 'outgoing' | 'preview' | 'active' | 'ended') => void;
  onError?: (message: string) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
};

const NATIVE = 'native-android' as const;

export class NativeAndroidCallPeer {
  private readonly opts: NativeAndroidCallPeerOpts;
  private pc: RTCPeerConnection | null = null;
  private videoSenderRef: RTCRtpSender | null = null;
  private audioSenderRef: RTCRtpSender | null = null;
  private videoTransceiverRef: RTCRtpTransceiver | null = null;
  private audioTransceiverRef: RTCRtpTransceiver | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private disposed = false;
  private readyHandled = false;
  private acceptHandled = false;
  private statsTimer: number | undefined;

  constructor(opts: NativeAndroidCallPeerOpts) {
    this.opts = opts;
  }

  /** Call after user-gesture getUserMedia + invite. */
  start(): void {
    const { localStream, localVideoEl } = this.opts;
    if (localVideoEl) {
      localVideoEl.srcObject = localStream;
      localVideoEl.muted = true;
      localVideoEl.setAttribute('playsinline', 'true');
      void localVideoEl.play().catch(() => {});
    }
    console.info('[native-call] BROWSER_MEDIA_READY callId=', this.opts.callId);
    this.opts.onPhase?.('outgoing');
  }

  async handleSignal(signal: CallSignal): Promise<void> {
    if (this.disposed) return;
    if (signal.callId !== this.opts.callId) return;
    if (signal.transport !== NATIVE) return;

    switch (signal.action) {
      case 'ready':
        await this.onNativeReady();
        return;
      case 'answer':
        if (signal.stage === 'preview') await this.onPreviewAnswer(signal);
        else if (signal.stage === 'active') await this.onActiveAnswer(signal);
        return;
      case 'offer':
        // Only Android creates active offer after accept — ignore unexpected.
        if (signal.stage === 'active') await this.onActiveOffer(signal);
        return;
      case 'ice':
        await this.onIce(signal);
        return;
      case 'accept':
        // Android notifies accept; do not create a competing offer.
        console.info('[native-call] NATIVE_ACCEPT_RECEIVED callId=', this.opts.callId);
        this.acceptHandled = true;
        return;
      case 'reject':
      case 'hangup':
        this.opts.onPhase?.('ended');
        this.dispose();
        return;
      default:
        return;
    }
  }

  hangup(): void {
    if (this.disposed) return;
    this.opts.send({
      chatId: this.opts.chatId,
      callId: this.opts.callId,
      action: 'hangup',
      transport: NATIVE,
    });
    this.opts.onPhase?.('ended');
    this.dispose();
  }

  /**
   * Camera switch on the iPhone/browser caller: swap the outbound video track
   * on the Mode B PC (useVideoCall's Mode A PC is unused here).
   */
  async replaceVideoTrack(nextTrack: MediaStreamTrack): Promise<void> {
    if (this.disposed || !nextTrack) return;
    const pc = this.pc;
    let sender = this.videoSenderRef;
    if (!sender && pc) {
      sender =
        pc.getSenders().find((s) => s.track?.kind === 'video') ??
        pc.getSenders().find((s) => {
          const tr = pc.getTransceivers().find((t) => t.sender === s);
          return tr?.receiver.track?.kind === 'video' || s.track == null;
        }) ??
        null;
      this.videoSenderRef = sender;
    }
    if (!sender) {
      console.warn('[native-call] NATIVE_VIDEO_REPLACE_NO_SENDER callId=', this.opts.callId);
      return;
    }
    await sender.replaceTrack(nextTrack);
    this.videoSenderRef = sender;
    this.videoTransceiverRef =
      pc?.getTransceivers().find((t) => t.sender === sender) ?? this.videoTransceiverRef;
    console.info('[native-call] NATIVE_VIDEO_TRACK_REPLACED callId=', this.opts.callId, {
      trackId: nextTrack.id,
      readyState: nextTrack.readyState,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.statsTimer !== undefined) window.clearInterval(this.statsTimer);
    this.pc?.close();
    this.pc = null;
    // Do not stop local tracks here — UI owns the stream lifecycle.
  }

  private async ensurePc(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;
    await ensureIceConfig();
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 8,
    });
    this.pc = pc;
    console.info('[native-call] NATIVE_PREVIEW_PC_CREATED callId=', this.opts.callId);

    const remote = new MediaStream();
    pc.ontrack = (ev) => {
      if (ev.track) remote.addTrack(ev.track);
      this.opts.onRemoteStream?.(remote);
    };
    pc.onicecandidate = (ev) => {
      this.opts.send({
        chatId: this.opts.chatId,
        callId: this.opts.callId,
        action: 'ice',
        transport: NATIVE,
        stage: this.acceptHandled ? 'active' : 'preview',
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.info('[native-call] NATIVE_PREVIEW_ICE_CONNECTED callId=', this.opts.callId);
      }
    };
    return pc;
  }

  private async onNativeReady(): Promise<void> {
    if (this.readyHandled) {
      console.info('[native-call] NATIVE_READY_RECEIVED (ignored duplicate) callId=', this.opts.callId);
      return;
    }
    this.readyHandled = true;
    console.info('[native-call] NATIVE_READY_RECEIVED callId=', this.opts.callId);
    console.info('[native-call] NATIVE_TARGET_SELECTED callId=', this.opts.callId);

    const pc = await this.ensurePc();
    const video = this.opts.localStream.getVideoTracks()[0];
    if (!video || video.readyState !== 'live') {
      this.opts.onError?.('Камера не готова');
      throw new Error('Native preview video track not live');
    }

    // Video only for preview — no mic until Android accept + active renegotiation.
    this.videoSenderRef = pc.addTrack(video, this.opts.localStream);
    this.videoTransceiverRef =
      pc.getTransceivers().find((t) => t.sender === this.videoSenderRef) ?? null;
    if (this.videoTransceiverRef) {
      try {
        this.videoTransceiverRef.direction = 'sendonly';
      } catch {
        // ignore
      }
    }

    assertLiveVideoSender(pc);
    await preferHigherVideoQuality(pc);
    console.info('[native-call] NATIVE_VIDEO_SENDER_LIVE callId=', this.opts.callId);

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    const diag = diagnoseLocalDescription(pc);
    console.info('[native-call] NATIVE_PREVIEW_OFFER_SENT', {
      callId: this.opts.callId,
      ...diag,
    });
    if (!diag.hasVideoMLine || !diag.videoSenderHasTrack || !diag.videoTrackLive) {
      throw new Error('Native preview offer missing live video');
    }
    if (offer.sdp && !previewOfferHasSendonlyVideo(offer.sdp)) {
      console.warn('[native-call] preview offer video direction unexpected', diag.videoDirection);
    }
    if (offer.sdp && !previewOfferHasNoSendingAudio(offer.sdp)) {
      console.warn('[native-call] preview offer unexpectedly sends audio');
    }

    this.opts.send({
      chatId: this.opts.chatId,
      callId: this.opts.callId,
      action: 'offer',
      transport: NATIVE,
      stage: 'preview',
      sdp: offer.sdp,
    });
    this.opts.onPhase?.('preview');
    this.startOutboundStats();
  }

  private async onPreviewAnswer(signal: CallSignal): Promise<void> {
    const pc = this.pc;
    if (!pc || !signal.sdp) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    await this.flushIce();
    console.info('[native-call] NATIVE_PREVIEW_ANSWER_APPLIED callId=', this.opts.callId);
  }

  private async onActiveOffer(signal: CallSignal): Promise<void> {
    const pc = await this.ensurePc();
    if (!signal.sdp) return;
    console.info('[native-call] NATIVE_ACTIVE_OFFER_RECEIVED callId=', this.opts.callId);
    this.acceptHandled = true;

    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    await this.flushIce();

    const audio = this.opts.localStream.getAudioTracks()[0];
    if (audio) {
      audio.enabled = true;
      if (this.audioSenderRef) {
        await this.audioSenderRef.replaceTrack(audio);
      } else {
        const existing = pc.getSenders().find((s) => s.track?.kind === 'audio' || s.track == null);
        const audioSender = pc.getReceivers().length
          ? pc.getSenders().find((s) => {
              const t = pc.getTransceivers().find((tr) => tr.sender === s);
              return t?.receiver.track?.kind === 'audio' || s.track?.kind === 'audio';
            })
          : undefined;
        if (audioSender && !audioSender.track) {
          await audioSender.replaceTrack(audio);
          this.audioSenderRef = audioSender;
        } else if (!pc.getSenders().some((s) => s.track?.kind === 'audio')) {
          this.audioSenderRef = pc.addTrack(audio, this.opts.localStream);
        } else {
          this.audioSenderRef = pc.getSenders().find((s) => s.track?.kind === 'audio') ?? null;
          if (this.audioSenderRef) await this.audioSenderRef.replaceTrack(audio);
        }
        void existing;
      }
      this.audioTransceiverRef =
        pc.getTransceivers().find((t) => t.sender === this.audioSenderRef) ??
        this.audioTransceiverRef;
      if (this.audioTransceiverRef) {
        try {
          this.audioTransceiverRef.direction = 'sendrecv';
        } catch {
          // ignore
        }
      }
    }
    if (this.videoTransceiverRef) {
      try {
        this.videoTransceiverRef.direction = 'sendrecv';
      } catch {
        // ignore
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.opts.send({
      chatId: this.opts.chatId,
      callId: this.opts.callId,
      action: 'answer',
      transport: NATIVE,
      stage: 'active',
      sdp: answer.sdp,
    });
    console.info('[native-call] NATIVE_ACTIVE_ANSWER_SENT callId=', this.opts.callId);
    this.opts.onPhase?.('active');
  }

  private async onActiveAnswer(signal: CallSignal): Promise<void> {
    const pc = this.pc;
    if (!pc || !signal.sdp) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    await this.flushIce();
  }

  private async onIce(signal: CallSignal): Promise<void> {
    if (!signal.candidate) return;
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) {
      this.pendingIce.push(signal.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(signal.candidate);
    } catch {
      // ignore
    }
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) return;
    const queued = this.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        // ignore
      }
    }
  }

  private startOutboundStats(): void {
    if (this.statsTimer !== undefined) return;
    this.statsTimer = window.setInterval(() => {
      const pc = this.pc;
      if (!pc) return;
      void pc.getStats().then((report) => {
        report.forEach((stat) => {
          if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
            console.info('[native-call] NATIVE_REMOTE_VIDEO_STATS', {
              callId: this.opts.callId,
              framesEncoded: stat.framesEncoded,
              framesSent: stat.framesSent,
              bytesSent: stat.bytesSent,
              packetsSent: stat.packetsSent,
              frameWidth: stat.frameWidth,
              frameHeight: stat.frameHeight,
            });
          }
        });
      });
    }, 4000);
  }
}

export function createNativeInviteSignal(opts: {
  chatId: string;
  callId: string;
}): Omit<CallSignal, 'fromUserId'> {
  return {
    chatId: opts.chatId,
    callId: opts.callId,
    action: 'invite',
    transport: NATIVE,
  };
}
