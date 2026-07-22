import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type CoachmanCallEvent = {
  eventId?: string;
  type?: string;
  action?: 'accept' | 'reject' | string;
  callId?: string;
  chatId?: string;
  fromUserId?: string;
  title?: string;
  body?: string;
  autoAccept?: boolean;
  autoReject?: boolean;
  createdAt?: number;
};

export interface CoachmanCallsPlugin {
  ensureChannels(): Promise<void>;
  requestMediaPermissions(): Promise<{ camera: boolean; microphone: boolean }>;
  startInCall(options: { title?: string; body?: string }): Promise<void>;
  stopInCall(): Promise<void>;
  showIncomingCall(options: {
    callId: string;
    chatId: string;
    fromUserId?: string;
    title?: string;
    body?: string;
  }): Promise<void>;
  dismissIncomingCall(options: { callId: string }): Promise<void>;
  /** @deprecated Prefer peekPendingCallAction + ackPendingCallAction */
  consumeLaunchCall(): Promise<CoachmanCallEvent>;
  peekPendingCallAction(): Promise<CoachmanCallEvent>;
  ackPendingCallAction(options: { eventId: string }): Promise<{ acked: boolean }>;
  setCallWindowMode(options: { active: boolean }): Promise<void>;
  openFullScreenIntentSettings(): Promise<void>;
  canUseFullScreenIntent(): Promise<{ allowed: boolean }>;
  openOemCallPermissions(): Promise<{ opened: boolean; xiaomi: boolean }>;
  saveImage(options: {
    base64: string;
    filename: string;
    mimeType: string;
  }): Promise<{ saved: boolean }>;
  setBadgeCount(options: { count: number }): Promise<void>;
  addListener(
    eventName: 'callEvent',
    listenerFunc: (event: CoachmanCallEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const webStub: CoachmanCallsPlugin = {
  async ensureChannels() {},
  async requestMediaPermissions() {
    return { camera: true, microphone: true };
  },
  async startInCall() {},
  async stopInCall() {},
  async showIncomingCall() {},
  async dismissIncomingCall() {},
  async consumeLaunchCall() {
    return {};
  },
  async peekPendingCallAction() {
    return {};
  },
  async ackPendingCallAction() {
    return { acked: false };
  },
  async setCallWindowMode() {},
  async openFullScreenIntentSettings() {},
  async canUseFullScreenIntent() {
    return { allowed: true };
  },
  async openOemCallPermissions() {
    return { opened: false, xiaomi: false };
  },
  async saveImage() {
    return { saved: false };
  },
  async setBadgeCount() {},
  async addListener() {
    return { remove: async () => {} };
  },
};

export const CoachmanCalls = registerPlugin<CoachmanCallsPlugin>('CoachmanCalls', {
  web: () => webStub,
});
