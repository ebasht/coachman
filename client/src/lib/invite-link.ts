export function buildInviteLink(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

export function parseInviteToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, window.location.origin);
    const token = url.searchParams.get('invite');
    if (token) return token;
  } catch {
    // not a full URL
  }

  const match = trimmed.match(/[?&]invite=([^&\s#]+)/i);
  if (match?.[1]) return decodeURIComponent(match[1]);

  return null;
}
