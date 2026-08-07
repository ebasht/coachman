/** Remember chats that fired a push so foreground sync can pull them even if SW prefetch failed. */

const KEY = 'coachman.lastNotifiedChatIds';
const MAX = 30;
/** Keep push targets across cold starts long enough for the user to open the app. */
const TTL_MS = 48 * 60 * 60 * 1000;

type Entry = { id: string; at: number };

function readEntries(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .map((item): Entry | null => {
        if (typeof item === 'string' && item) return { id: item, at: now };
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as Entry).id === 'string' &&
          typeof (item as Entry).at === 'number'
        ) {
          return item as Entry;
        }
        return null;
      })
      .filter((e): e is Entry => e != null && now - e.at < TTL_MS);
  } catch {
    return [];
  }
}

function writeEntries(entries: Entry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    // private mode / quota
  }
}

export function rememberNotifiedChat(chatId: string): void {
  if (!chatId) return;
  const now = Date.now();
  const next = [{ id: chatId, at: now }, ...readEntries().filter((e) => e.id !== chatId)];
  writeEntries(next);
}

export function peekNotifiedChatIds(): string[] {
  return readEntries().map((e) => e.id);
}
