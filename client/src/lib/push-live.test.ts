import { describe, expect, it } from 'vitest';
import {
  buildProvisionalMessage,
  isGenericPushBody,
  parseLivePushFields,
  provisionalMessageId,
  pushEnvelopeToRawMessage,
  shouldRefreshGroupKeyOnLoad,
} from './push-live';

describe('parseLivePushFields', () => {
  it('reads preview and ciphertext envelope', () => {
    const got = parseLivePushFields({
      chatId: 'c1',
      body: 'Привет',
      title: 'Аня',
      messageId: 'm1',
      senderId: 'u2',
      ciphertext: 'abc',
      iv: 'iv1',
      sequence: '9',
      createdAt: '100',
    });
    expect(got).toMatchObject({
      chatId: 'c1',
      body: 'Привет',
      title: 'Аня',
      messageId: 'm1',
      senderId: 'u2',
      ciphertext: 'abc',
      iv: 'iv1',
      sequence: 9,
      createdAt: 100,
    });
  });

  it('prefers declarative notification body', () => {
    const got = parseLivePushFields({
      chatId: 'c1',
      body: 'Новое сообщение',
      notification: { title: 'Аня', body: 'Уже выхожу' },
    });
    expect(got?.body).toBe('Уже выхожу');
    expect(got?.title).toBe('Аня');
  });

  it('returns null without chatId', () => {
    expect(parseLivePushFields({ body: 'x' })).toBeNull();
  });
});

describe('buildProvisionalMessage', () => {
  it('uses server message id when present so reconcile can merge', () => {
    const msg = buildProvisionalMessage({
      chatId: 'c1',
      body: 'Привет',
      title: 'Аня',
      messageId: 'srv-1',
      senderId: 'u2',
      createdAt: 50,
    });
    expect(msg).toMatchObject({
      id: 'srv-1',
      text: 'Привет',
      senderName: 'Аня',
      provisional: true,
      createdAt: 50,
    });
  });

  it('falls back to a per-chat provisional id', () => {
    const msg = buildProvisionalMessage({ chatId: 'c1', body: 'Привет' });
    expect(msg?.id).toBe(provisionalMessageId('c1'));
    expect(msg?.provisional).toBe(true);
  });

  it('skips empty body', () => {
    expect(buildProvisionalMessage({ chatId: 'c1', body: '  ' })).toBeNull();
  });
});

describe('pushEnvelopeToRawMessage', () => {
  it('requires ciphertext', () => {
    expect(pushEnvelopeToRawMessage({ chatId: 'c1', body: 'hi' })).toBeNull();
    expect(
      pushEnvelopeToRawMessage({
        chatId: 'c1',
        ciphertext: 'enc',
        iv: 'iv',
        messageId: 'm1',
        senderId: 'u2',
      }),
    ).toMatchObject({ id: 'm1', ciphertext: 'enc', iv: 'iv', senderId: 'u2' });
  });
});

describe('shouldRefreshGroupKeyOnLoad', () => {
  it('skips refresh when wrap exists and epoch matches', () => {
    expect(
      shouldRefreshGroupKeyOnLoad({
        isGroup: true,
        wrapMissing: false,
        localEpoch: 3,
        serverEpoch: 3,
      }),
    ).toBe(false);
  });

  it('refreshes on wrap miss or epoch change', () => {
    expect(
      shouldRefreshGroupKeyOnLoad({
        isGroup: true,
        wrapMissing: true,
        localEpoch: 3,
        serverEpoch: 3,
      }),
    ).toBe(true);
    expect(
      shouldRefreshGroupKeyOnLoad({
        isGroup: true,
        wrapMissing: false,
        localEpoch: 2,
        serverEpoch: 3,
      }),
    ).toBe(true);
  });

  it('does not refresh DMs', () => {
    expect(
      shouldRefreshGroupKeyOnLoad({ isGroup: false, wrapMissing: true, serverEpoch: 2 }),
    ).toBe(false);
  });
});

describe('isGenericPushBody', () => {
  it('detects fallback copy', () => {
    expect(isGenericPushBody('Новое сообщение')).toBe(true);
    expect(isGenericPushBody('Привет')).toBe(false);
  });
});
