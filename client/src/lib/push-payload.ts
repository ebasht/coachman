/** Parse a Web Push payload, including iOS Declarative Web Push (`web_push: 8030`). */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

export function parsePushJSON(raw: unknown): Record<string, unknown> {
  return asRecord(raw) ?? {};
}

/** iOS sometimes throws on `event.data.json()`; text + JSON.parse is more reliable. */
export function parsePushEventData(source: { json?: () => unknown; text?: () => string } | null | undefined): Record<string, unknown> {
  if (!source) return {};
  try {
    if (typeof source.json === 'function') {
      const parsed = parsePushJSON(source.json());
      if (Object.keys(parsed).length) return parsed;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof source.text === 'function') {
      const text = source.text();
      if (text) return parsePushJSON(JSON.parse(text) as unknown);
    }
  } catch {
    // ignore
  }
  return {};
}

export function pushNotificationFields(
  data: Record<string, unknown>,
  fallback: { title: string; body: string },
): { title: string; body: string } {
  const nested = asRecord(data.notification);
  return {
    title: asNonEmptyString(nested?.title) || asNonEmptyString(data.title) || fallback.title,
    body: asNonEmptyString(nested?.body) || asNonEmptyString(data.body) || fallback.body,
  };
}
