import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type CoachmanCallEvent = {
  type?: string;
  callId?: string;
  chatId?: string;
  fromUserId?: string;
  title?: string;
  body?: string;
  autoAccept?: boolean;
  autoReject?: boolean;
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
  consumeLaunchCall(): Promise<CoachmanCallEvent>;
  openFullScreenIntentSettings(): Promise<void>;
  canUseFullScreenIntent(): Promise<{ allowed: boolean }>;
  /** Persist image bytes into the Android gallery (MediaStore). No-op on web. */
  saveImage(options: {
    base64: string;
    filename: string;
    mimeType: string;
  }): Promise<{ saved: boolean }>;
  addListener(
    eventName: 'callEvent',
    listenerFunc: (event: CoachmanCallEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const CoachmanCalls = registerPlugin<CoachmanCallsPlugin>('CoachmanCalls', {
  web: () => ({
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
    async openFullScreenIntentSettings() {},
    async canUseFullScreenIntent() {
      return { allowed: true };
    },
    async saveImage() {
      return { saved: false };
    },
    async addListener() {
      return { remove: async () => {} };
    },
  }),
});
