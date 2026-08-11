import { describe, expect, it } from 'vitest';
import { reconcileMessage, reconcileMessages } from './message-reconcile';
import type { StoredMessage } from './storage';

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id'>): StoredMessage {
  return {
    chatId: 'c1',
    senderId: 'u1',
    senderName: 'A',
    text: 'hi',
    type: 'text',
    createdAt: 1,
    ...partial,
  };
}

describe('reconcileMessage', () => {
  describe('insert', () => {
    it('inserts a new message into an empty list', () => {
      const incoming = msg({ id: 'srv-1', sequence: 1, createdAt: 10 });
      const result = reconcileMessage([], incoming);

      expect(result.inserted).toBe(true);
      expect(result.updated).toBe(false);
      expect(result.messages).toHaveLength(1);
      expect(result.message.id).toBe('srv-1');
    });

    it('inserts a new message with a different id into an existing list', () => {
      const existing = [msg({ id: 'srv-1', sequence: 1, createdAt: 10 })];
      const incoming = msg({ id: 'srv-2', sequence: 2, createdAt: 20 });
      const result = reconcileMessage(existing, incoming);

      expect(result.inserted).toBe(true);
      expect(result.updated).toBe(false);
      expect(result.messages).toHaveLength(2);
    });
  });

  describe('update by server id', () => {
    it('updates when incoming has the same server id', () => {
      const existing = [msg({ id: 'srv-1', text: 'old', sequence: 1, createdAt: 10 })];
      const incoming = msg({ id: 'srv-1', text: 'new', sequence: 1, createdAt: 11 });
      const result = reconcileMessage(existing, incoming);

      expect(result.inserted).toBe(false);
      expect(result.updated).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.message.text).toBe('new');
    });
  });

  describe('update by clientId', () => {
    it('matches by clientId when server ids differ', () => {
      const existing = [
        msg({ id: 'pending-cid', clientId: 'cid', pending: true, createdAt: 10, text: 'hello' }),
      ];
      const incoming = msg({
        id: 'srv-1',
        clientId: 'cid',
        pending: false,
        sequence: 3,
        createdAt: 11,
        text: 'hello',
      });
      const result = reconcileMessage(existing, incoming);

      expect(result.inserted).toBe(false);
      expect(result.updated).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.message.id).toBe('srv-1');
      expect(result.message.pending).toBe(false);
    });
  });

  describe('pending → server', () => {
    it('replaces pending bubble with server-confirmed message', () => {
      const pending = msg({
        id: 'pending-cid',
        clientId: 'cid',
        pending: true,
        text: 'hello',
        createdAt: 10,
      });
      const server = msg({
        id: 'srv-1',
        clientId: 'cid',
        pending: false,
        text: 'hello',
        createdAt: 11,
        sequence: 4,
      });
      const result = reconcileMessage([pending], server);

      expect(result.inserted).toBe(false);
      expect(result.updated).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.message.id).toBe('srv-1');
      expect(result.message.clientId).toBe('cid');
      expect(result.message.pending).toBe(false);
    });

    it('pending → HTTP ACK → WS echo yields one message, never inserted twice', () => {
      const clientId = 'cid-flow';
      const pending = msg({
        id: `pending-${clientId}`,
        clientId,
        pending: true,
        text: 'ping',
        createdAt: 10,
      });
      const httpAck = msg({
        id: 'srv-42',
        clientId,
        pending: false,
        text: 'ping',
        createdAt: 11,
        sequence: 7,
      });
      const wsEcho = msg({
        id: 'srv-42',
        clientId,
        pending: false,
        text: 'ping',
        createdAt: 11,
        sequence: 7,
      });

      const r1 = reconcileMessage([pending], httpAck);
      expect(r1.inserted).toBe(false);
      expect(r1.updated).toBe(true);
      expect(r1.messages).toHaveLength(1);

      const r2 = reconcileMessage(r1.messages, wsEcho);
      expect(r2.inserted).toBe(false);
      expect(r2.updated).toBe(false);
      expect(r2.messages).toHaveLength(1);
      expect(r2.message.id).toBe('srv-42');
    });
  });

  describe('duplicate event', () => {
    it('duplicate WS event is a no-op (not inserted, not updated)', () => {
      const existing = [
        msg({ id: 'srv-1', clientId: 'cid', sequence: 3, createdAt: 10, text: 'hello' }),
      ];
      const duplicate = msg({
        id: 'srv-1',
        clientId: 'cid',
        sequence: 3,
        createdAt: 10,
        text: 'hello',
      });
      const result = reconcileMessage(existing, duplicate);

      expect(result.inserted).toBe(false);
      expect(result.updated).toBe(false);
      expect(result.messages).toBe(existing); // referential equality — no change
    });

    it('HTTP ACK after WS echo with same data is a no-op', () => {
      const confirmed = msg({
        id: 'srv-1',
        clientId: 'cid',
        sequence: 5,
        createdAt: 11,
        text: 'test',
      });
      const ack = msg({
        id: 'srv-1',
        clientId: 'cid',
        sequence: 5,
        createdAt: 11,
        text: 'test',
      });
      const result = reconcileMessage([confirmed], ack);

      expect(result.inserted).toBe(false);
      expect(result.updated).toBe(false);
    });
  });

  describe('same text / different ids', () => {
    it('two messages with same text but different ids remain separate', () => {
      const first = msg({
        id: 'srv-1',
        clientId: 'cid-1',
        text: 'Да',
        createdAt: 1000,
        sequence: 1,
      });
      const second = msg({
        id: 'srv-2',
        clientId: 'cid-2',
        text: 'Да',
        createdAt: 1100,
        sequence: 2,
      });
      const result = reconcileMessage([first], second);

      expect(result.inserted).toBe(true);
      expect(result.messages).toHaveLength(2);
    });

    it('three identical texts from the same sender stay separate', () => {
      const rows = [
        msg({ id: 'srv-1', clientId: 'a', text: 'ок', createdAt: 10, sequence: 1 }),
        msg({ id: 'srv-2', clientId: 'b', text: 'ок', createdAt: 20, sequence: 2 }),
      ];
      const third = msg({ id: 'srv-3', clientId: 'c', text: 'ок', createdAt: 30, sequence: 3 });
      const result = reconcileMessage(rows, third);

      expect(result.inserted).toBe(true);
      expect(result.messages).toHaveLength(3);
    });

    it('different clientIds with same text never merge', () => {
      const pendingA = msg({
        id: 'pending-a',
        clientId: 'a',
        pending: true,
        text: 'Да',
        createdAt: 10,
      });
      const pendingB = msg({
        id: 'pending-b',
        clientId: 'b',
        pending: true,
        text: 'Да',
        createdAt: 11,
      });
      const result = reconcileMessage([pendingA], pendingB);

      expect(result.inserted).toBe(true);
      expect(result.messages).toHaveLength(2);
    });
  });

  describe('reconnect / history sync', () => {
    it('history batch of known ids does not create duplicates', () => {
      const existing = [
        msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
        msg({ id: 'srv-2', clientId: 'b', text: 'two', sequence: 2, createdAt: 2 }),
      ];
      const batch = [
        msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
        msg({ id: 'srv-2', clientId: 'b', text: 'two', sequence: 2, createdAt: 2 }),
        msg({ id: 'srv-3', clientId: 'c', text: 'three', sequence: 3, createdAt: 3 }),
      ];
      const { messages, results } = reconcileMessages(existing, batch);

      expect(messages).toHaveLength(3);
      expect(results[0]!.inserted).toBe(false);
      expect(results[1]!.inserted).toBe(false);
      expect(results[2]!.inserted).toBe(true);
    });

    it('WS echo before HTTP ACK yields one message', () => {
      const clientId = 'cid-ws-ack';
      const pending = msg({
        id: `pending-${clientId}`,
        clientId,
        pending: true,
        text: 'ping',
        createdAt: 10,
      });
      const wsEcho = msg({
        id: 'srv-99',
        clientId,
        pending: false,
        text: 'ping',
        createdAt: 11,
        sequence: 8,
      });
      const httpAck = msg({
        id: 'srv-99',
        clientId,
        pending: false,
        text: 'ping',
        createdAt: 11,
        sequence: 8,
      });

      const { messages, results } = reconcileMessages([pending], [wsEcho, httpAck]);

      expect(messages).toHaveLength(1);
      expect(messages[0]!.id).toBe('srv-99');
      expect(results[0]!.inserted).toBe(false);
      expect(results[0]!.updated).toBe(true);
      expect(results[1]!.inserted).toBe(false);
    });
  });
});
