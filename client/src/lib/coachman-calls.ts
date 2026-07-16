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
    async addListener() {
      return { remove: async () => {} };
    },
  }),
});
