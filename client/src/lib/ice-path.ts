import type { CallSignal } from './call-types';

type IcePath = {
  ok: boolean;
  via: 'turn' | 'stun' | 'host' | 'unknown';
  turn: boolean;
  localType: string;
  remoteType: string;
  iceState: string;
};

function classifyVia(localType: string, remoteType: string): IcePath['via'] {
  if (localType === 'relay' || remoteType === 'relay') return 'turn';
  if (localType === 'srflx' || remoteType === 'srflx' || localType === 'prflx' || remoteType === 'prflx') {
    return 'stun';
  }
  if (localType === 'host' || remoteType === 'host') return 'host';
  return 'unknown';
}

/** Inspect selected ICE candidate pair (TURN = relay). */
export async function inspectIcePath(pc: RTCPeerConnection): Promise<IcePath> {
  const iceState = pc.iceConnectionState;
  const ok = iceState === 'connected' || iceState === 'completed';
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, RTCStats>();
    stats.forEach((r) => byId.set(r.id, r));

    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((r) => {
      if (r.type === 'transport') {
        const t = r as RTCTransportStats & { selectedCandidatePairId?: string };
        if (t.selectedCandidatePairId) {
          pair = byId.get(t.selectedCandidatePairId) as RTCIceCandidatePairStats | undefined;
        }
      }
    });
    if (!pair) {
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair') return;
        const p = r as RTCIceCandidatePairStats & { selected?: boolean };
        if (p.selected || (p.nominated && p.state === 'succeeded')) {
          pair = p;
        }
      });
    }

    type Cand = RTCStats & { candidateType?: string };
    const local = pair?.localCandidateId
      ? (byId.get(pair.localCandidateId) as Cand | undefined)
      : undefined;
    const remote = pair?.remoteCandidateId
      ? (byId.get(pair.remoteCandidateId) as Cand | undefined)
      : undefined;

    const localType = local?.candidateType ?? 'unknown';
    const remoteType = remote?.candidateType ?? 'unknown';
    const via = classifyVia(localType, remoteType);
    return {
      ok,
      via,
      turn: via === 'turn',
      localType,
      remoteType,
      iceState,
    };
  } catch {
    return {
      ok,
      via: 'unknown',
      turn: false,
      localType: 'unknown',
      remoteType: 'unknown',
      iceState,
    };
  }
}

export function icePathToSignal(
  base: Pick<CallSignal, 'chatId' | 'callId'>,
  path: IcePath,
): Omit<CallSignal, 'fromUserId'> {
  return {
    ...base,
    action: 'ice-report',
    ok: path.ok,
    via: path.via,
    turn: path.turn,
    localType: path.localType,
    remoteType: path.remoteType,
    iceState: path.iceState,
  };
}
