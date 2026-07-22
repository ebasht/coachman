import { describe, expect, it } from 'vitest';
import {
  isNativeCallAction,
  parseCallPushData,
  shouldPresentNativeIncomingUi,
  truthyFlag,
} from './native-calls';

describe('truthyFlag', () => {
  it('accepts boolean / string / number forms used by Capacitor intents', () => {
    expect(truthyFlag(true)).toBe(true);
    expect(truthyFlag('true')).toBe(true);
    expect(truthyFlag('1')).toBe(true);
    expect(truthyFlag(1)).toBe(true);
    expect(truthyFlag(false)).toBe(false);
    expect(truthyFlag('false')).toBe(false);
    expect(truthyFlag(0)).toBe(false);
    expect(truthyFlag(undefined)).toBe(false);
  });
});

describe('parseCallPushData', () => {
  it('parses flat push payloads with eventId + action', () => {
    const e = parseCallPushData({
      eventId: 'evt-1',
      type: 'incoming-call',
      action: 'accept',
      callId: 'c1',
      chatId: 'h1',
      fromUserId: 'u1',
    });
    expect(e.eventId).toBe('evt-1');
    expect(e.action).toBe('accept');
    expect(e.autoAccept).toBe(true);
    expect(e.autoReject).toBe(false);
  });

  it('parses nested Capacitor .data and string autoReject', () => {
    const e = parseCallPushData({
      data: {
        type: 'incoming-call',
        callId: 'c2',
        chatId: 'h2',
        autoReject: '1',
      },
    });
    expect(e.callId).toBe('c2');
    expect(e.autoReject).toBe(true);
    expect(e.action).toBe('reject');
  });
});

describe('isNativeCallAction / shouldPresentNativeIncomingUi', () => {
  const base = {
    type: 'incoming-call' as const,
    callId: 'call-1',
    chatId: 'chat-1',
  };

  it('treats autoAccept as already acted — do not re-present native UI', () => {
    const event = { ...base, autoAccept: true, eventId: 'e1' };
    expect(isNativeCallAction(event)).toBe(true);
    expect(
      shouldPresentNativeIncomingUi(event, { presentNativeUi: true, documentHidden: true }),
    ).toBe(false);
  });

  it('treats action=reject as already acted', () => {
    expect(isNativeCallAction({ ...base, action: 'reject' })).toBe(true);
  });

  it('presents native UI for unanswered background invite', () => {
    expect(shouldPresentNativeIncomingUi(base, { documentHidden: true })).toBe(true);
    expect(shouldPresentNativeIncomingUi(base, { presentNativeUi: true })).toBe(true);
  });

  it('skips present when foreground and no explicit opt', () => {
    expect(shouldPresentNativeIncomingUi(base, { documentHidden: false })).toBe(false);
  });
});
