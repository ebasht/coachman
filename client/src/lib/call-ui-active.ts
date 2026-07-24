/**
 * Process-wide flag: an in-app call UI is up.
 * Used to block PWA service-worker reloads mid-call (controllerchange → location.reload
 * was wiping React state and leaving the user on the chat list).
 */

let callUiActive = false;

export function setCallUiActive(active: boolean): void {
  callUiActive = active;
}

export function isCallUiActive(): boolean {
  return callUiActive;
}
