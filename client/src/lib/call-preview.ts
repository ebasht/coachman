import type { CallAction, CallPhase, CallSignal } from './call-types';

export type NegotiationStage = 'none' | 'preview' | 'active';

export function isPreviewReadyAction(action: CallAction | string): boolean {
  return action === 'preview-ready';
}

/** Caller may emit at most one preview offer per callId while outgoing. */
export function shouldSendPreviewOffer(opts: {
  phase: CallPhase;
  callId: string;
  signalCallId: string;
  alreadySentForCallId: string | null;
}): boolean {
  if (opts.phase !== 'outgoing') return false;
  if (!opts.callId || opts.callId !== opts.signalCallId) return false;
  if (opts.alreadySentForCallId === opts.callId) return false;
  return true;
}

/** Ignore late preview SDP after active renegotiation started. */
export function shouldApplyPreviewSdp(opts: {
  stage: CallSignal['stage'];
  negotiationStage: NegotiationStage;
}): boolean {
  if (opts.stage === 'preview' && opts.negotiationStage === 'active') return false;
  return true;
}

export function remoteHangupNeedsUnlock(opts: {
  phase: CallPhase;
  accepted: boolean;
}): boolean {
  if (opts.accepted) return true;
  if (opts.phase === 'connecting' || opts.phase === 'active' || opts.phase === 'ended') {
    return true;
  }
  return false;
}

export function shouldHideGateForCallUiReady(opts: {
  readyCallId: string;
  activeCallId: string | null | undefined;
}): boolean {
  if (!opts.readyCallId || !opts.activeCallId) return false;
  return opts.readyCallId === opts.activeCallId;
}
