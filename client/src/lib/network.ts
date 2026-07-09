export function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}
