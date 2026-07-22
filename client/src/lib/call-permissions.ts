import { CoachmanCalls } from './coachman-calls';
import { isNativeAndroid } from './native-calls';

export type CallPermissionState = {
  notificationsGranted: boolean;
  cameraGranted: boolean;
  microphoneGranted: boolean;
  bluetoothGranted: boolean;
  bluetoothRequired?: boolean;

  fullScreenSupported: boolean;
  fullScreenAllowed: boolean;

  appNotificationsEnabled: boolean;
  callChannelExists: boolean;
  callChannelHighImportance: boolean;
  callChannelImportance?: number;
  callChannelId?: string;

  batteryOptimized: boolean;

  requiredRuntimePermissionsGranted?: boolean;
  incomingCallsReady: boolean;
  activeVideoCallsReady: boolean;

  manufacturer?: string;
  model?: string;
  sdkInt?: number;
  applicationId?: string;
};

const READY_KEY = 'coachman_call_onboarding_done';
const SKIP_KEY = 'coachman_call_onboarding_skipped';

export function isCallOnboardingDone(): boolean {
  try {
    return localStorage.getItem(READY_KEY) === '1';
  } catch {
    return false;
  }
}

export function markCallOnboardingDone(complete: boolean): void {
  try {
    if (complete) localStorage.setItem(READY_KEY, '1');
    else localStorage.removeItem(READY_KEY);
  } catch {
    // ignore
  }
}

export function markCallOnboardingSkipped(): void {
  try {
    localStorage.setItem(SKIP_KEY, '1');
  } catch {
    // ignore
  }
}

export function wasCallOnboardingSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

const webReady: CallPermissionState = {
  notificationsGranted: true,
  cameraGranted: true,
  microphoneGranted: true,
  bluetoothGranted: true,
  bluetoothRequired: false,
  fullScreenSupported: true,
  fullScreenAllowed: true,
  appNotificationsEnabled: true,
  callChannelExists: true,
  callChannelHighImportance: true,
  batteryOptimized: false,
  incomingCallsReady: true,
  activeVideoCallsReady: true,
};

export async function getCallPermissionState(): Promise<CallPermissionState> {
  if (!isNativeAndroid()) return webReady;
  const state = await CoachmanCalls.getCallPermissionState();
  return state as CallPermissionState;
}

export async function requestNotificationPermission(): Promise<CallPermissionState> {
  if (!isNativeAndroid()) return webReady;
  return (await CoachmanCalls.requestNotificationPermission()) as CallPermissionState;
}

export async function requestMediaPermissionsState(): Promise<CallPermissionState> {
  if (!isNativeAndroid()) return webReady;
  return (await CoachmanCalls.requestMediaPermissions()) as CallPermissionState;
}

export async function requestBluetoothPermission(): Promise<CallPermissionState> {
  if (!isNativeAndroid()) return webReady;
  return (await CoachmanCalls.requestBluetoothPermission()) as CallPermissionState;
}

export async function openFullScreenCallSettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openFullScreenCallSettings();
}

export async function openNotificationSettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openNotificationSettings();
}

export async function openCallChannelSettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openCallChannelSettings();
}

export async function openAppSettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openAppSettings();
}

export async function openBatterySettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openBatterySettings();
}

export async function startTestIncomingCall(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.startTestIncomingCall({});
}

export function statusLabel(opts: {
  granted: boolean;
  needsSettings?: boolean;
  notRequired?: boolean;
}): string {
  if (opts.notRequired) return 'Не требуется на этой версии Android';
  if (opts.granted) return 'Разрешено';
  if (opts.needsSettings) return 'Нужно открыть настройки';
  return 'Не разрешено';
}
