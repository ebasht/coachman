export type CallAction =
  | 'invite'
  | 'accept'
  | 'reject'
  | 'hangup'
  | 'offer'
  | 'answer'
  | 'ice';

export type CallSignal = {
  chatId: string;
  callId: string;
  action: CallAction;
  fromUserId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
};

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function getIceServers(): RTCIceServer[] {
  const runtime = (window as unknown as {
    __COACHMAN_RUNTIME__?: { iceServers?: RTCIceServer[]; vapidPublicKey?: string };
  }).__COACHMAN_RUNTIME__;
  const fromRuntime = runtime?.iceServers?.filter(Boolean) ?? [];
  if (fromRuntime.length > 0) {
    return fromRuntime;
  }
  return DEFAULT_ICE;
}

/** Ensure /runtime-config.js is loaded before creating a PeerConnection (TURN creds). */
export async function ensureIceConfig(): Promise<RTCIceServer[]> {
  if (!window.__COACHMAN_RUNTIME__) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-runtime-config]');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('runtime-config')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = '/runtime-config.js';
      script.dataset.runtimeConfig = '1';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('runtime-config'));
      document.head.appendChild(script);
    }).catch(() => {});
  }
  return getIceServers();
}
