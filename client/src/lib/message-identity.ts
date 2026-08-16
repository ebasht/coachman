import type { StoredMessage } from './storage';

/** Fields used to decide whether two rows are the same logical message. */
export type MessageIdentityRef = Pick<StoredMessage, 'id' | 'clientId' | 'pending'>;

/**
 * Server-assigned message id when the row is confirmed.
 * Pending / `pending-*` temp ids are not server identity.
 */
export function messageServerId(
  m: Pick<StoredMessage, 'id' | 'pending' | 'provisional'>,
): string | undefined {
  if (m.pending || m.provisional) return undefined;
  if (!m.id || m.id.startsWith('pending-')) return undefined;
  return m.id;
}

/**
 * Normalize client identity across bare uuid / pending-${uuid} / server rows.
 * Content and timestamps are never identity.
 */
export function messageClientKey(
  m: Pick<StoredMessage, 'id' | 'clientId'>,
): string | undefined {
  if (m.clientId) return m.clientId;
  if (m.id.startsWith('pending-')) return m.id.slice('pending-'.length);
  return undefined;
}

/**
 * True when two representations refer to the same logical message.
 * Match by server id or shared client key only — never by text/time.
 */
export function sameMessageIdentity(
  a: Pick<StoredMessage, 'id' | 'clientId'>,
  b: Pick<StoredMessage, 'id' | 'clientId'>,
): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const aClient = messageClientKey(a);
  const bClient = messageClientKey(b);
  if (aClient && bClient && aClient === bClient) return true;
  return false;
}

function isConfirmed(m: Pick<StoredMessage, 'id' | 'pending'>): boolean {
  return messageServerId(m) != null;
}

/**
 * Merge existing + incoming representations of one logical message.
 *
 * Confirmed (server) data supplies id, timestamps, sequence, and status;
 * client-only hydrated fields (media URLs, clientId, local text) are kept
 * when the server has not returned them yet.
 */
export function mergeMessageEntity(
  existing: StoredMessage,
  incoming: StoredMessage,
): StoredMessage {
  const existingConfirmed = isConfirmed(existing);
  const incomingConfirmed = isConfirmed(incoming);

  let primary: StoredMessage;
  let secondary: StoredMessage;

  if (incomingConfirmed && !existingConfirmed) {
    primary = incoming;
    secondary = existing;
  } else if (existingConfirmed && !incomingConfirmed) {
    primary = existing;
    secondary = incoming;
  } else if ((incoming.sequence ?? 0) !== (existing.sequence ?? 0)) {
    if ((incoming.sequence ?? 0) > (existing.sequence ?? 0)) {
      primary = incoming;
      secondary = existing;
    } else {
      primary = existing;
      secondary = incoming;
    }
  } else if (incoming.createdAt >= existing.createdAt) {
    primary = incoming;
    secondary = existing;
  } else {
    primary = existing;
    secondary = incoming;
  }

  const confirmed = existingConfirmed || incomingConfirmed;
  const serverId =
    messageServerId(primary) ?? messageServerId(secondary) ?? primary.id;
  const clientId =
    primary.clientId ||
    secondary.clientId ||
    messageClientKey(primary) ||
    messageClientKey(secondary);

  return {
    ...secondary,
    ...primary,
    id: serverId,
    clientId,
    text: primary.text || secondary.text || '',
    senderName: primary.senderName || secondary.senderName || '?',
    // Keep hydrated media so bubbles do not flash/remount.
    imageUrl: primary.imageUrl || secondary.imageUrl,
    posterUrl: primary.posterUrl || secondary.posterUrl,
    imageId: primary.imageId ?? secondary.imageId,
    albumId: primary.albumId ?? secondary.albumId,
    replyToMessageId: primary.replyToMessageId ?? secondary.replyToMessageId,
    replyToSenderId: primary.replyToSenderId ?? secondary.replyToSenderId,
    replyToSenderName: primary.replyToSenderName ?? secondary.replyToSenderName,
    replyToPreview: primary.replyToPreview ?? secondary.replyToPreview,
    replyToType: primary.replyToType ?? secondary.replyToType,
    sequence: primary.sequence ?? secondary.sequence,
    pending: confirmed ? false : Boolean(primary.pending),
    provisional: confirmed ? false : Boolean(primary.provisional || secondary.provisional),
    failed: confirmed ? false : primary.failed ?? secondary.failed,
    error: confirmed ? undefined : primary.error ?? secondary.error,
  };
}
