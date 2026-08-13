import { describe, expect, it } from 'vitest';
import { parsePushEventData, parsePushJSON, pushNotificationFields } from './push-payload';

describe('parsePushJSON', () => {
  it('returns empty object for non-objects', () => {
    expect(parsePushJSON(null)).toEqual({});
    expect(parsePushJSON('x')).toEqual({});
    expect(parsePushJSON([])).toEqual({});
  });
});

describe('parsePushEventData', () => {
  it('prefers json()', () => {
    expect(parsePushEventData({ json: () => ({ body: 'Привет' }) })).toEqual({ body: 'Привет' });
  });

  it('falls back to text() when json() throws (iOS)', () => {
    expect(
      parsePushEventData({
        json: () => {
          throw new Error('not json');
        },
        text: () => '{"body":"из текста"}',
      }),
    ).toEqual({ body: 'из текста' });
  });
});

describe('pushNotificationFields', () => {
  it('reads nested declarative notification body', () => {
    const got = pushNotificationFields(
      {
        web_push: 8030,
        notification: { title: 'Аня', body: 'Уже выхожу' },
        title: 'ignored',
        body: 'Новое сообщение',
      },
      { title: 'Ямщик', body: 'Новое сообщение' },
    );
    expect(got).toEqual({ title: 'Аня', body: 'Уже выхожу' });
  });

  it('falls back to top-level body for older payloads', () => {
    const got = pushNotificationFields(
      { title: 'Аня', body: 'Уже выхожу' },
      { title: 'Ямщик', body: 'Новое сообщение' },
    );
    expect(got).toEqual({ title: 'Аня', body: 'Уже выхожу' });
  });

  it('uses fallback when body is missing', () => {
    const got = pushNotificationFields({}, { title: 'Ямщик', body: 'Новое сообщение' });
    expect(got).toEqual({ title: 'Ямщик', body: 'Новое сообщение' });
  });
});
