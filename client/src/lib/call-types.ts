export type CallAction =
  | 'invite'
  | 'accept'
  | 'reject'
  | 'hangup'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'ice-report';

export type CallSignal = {
  chatId: string;
  callId: string;
  action: CallAction;
  fromUserId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  /** ice-report payload */
  ok?: boolean;
  via?: 'turn' | 'stun' | 'host' | 'unknown';
  turn?: boolean;
  localType?: string;
  remoteType?: string;
  iceState?: string;
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

/** Always refresh /runtime-config.js so ephemeral TURN creds stay fresh. */
export async function ensureIceConfig(): Promise<RTCIceServer[]> {
  await new Promise<void>((resolve) => {
    const script = document.createElement('script');
    script.src = `/runtime-config.js?t=${Date.now()}`;
    script.dataset.runtimeConfig = '1';
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return getIceServers();
}
