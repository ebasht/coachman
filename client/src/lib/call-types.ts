import { api } from './api';

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

let cachedIce: RTCIceServer[] = DEFAULT_ICE;
let cachedAt = 0;
const ICE_CACHE_MS = 60_000;

export function getIceServers(): RTCIceServer[] {
  return cachedIce.length ? cachedIce : DEFAULT_ICE;
}

/** Refresh ICE/TURN from authenticated API (ephemeral TURN credentials). */
export async function ensureIceConfig(): Promise<RTCIceServer[]> {
  if (cachedIce !== DEFAULT_ICE && Date.now() - cachedAt < ICE_CACHE_MS) {
    return cachedIce;
  }
  try {
    const { iceServers } = await api.getIceServers();
    const next = (iceServers ?? []).filter(Boolean);
    if (next.length > 0) {
      cachedIce = next;
      cachedAt = Date.now();
      return cachedIce;
    }
  } catch {
    // fall through to STUN defaults
  }
  cachedIce = DEFAULT_ICE;
  cachedAt = Date.now();
  return cachedIce;
}
