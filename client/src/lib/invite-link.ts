export type AuthLink =
  | { type: 'invite'; token: string }
  | { type: 'bootstrap'; token: string };

export function buildInviteLink(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

export function buildBootstrapLink(token: string): string {
  return `${window.location.origin}/?bootstrap=${encodeURIComponent(token)}`;
}

/** Parse invite or bootstrap token from a pasted URL / raw token fragment. */
export function parseAuthLink(text: string): AuthLink | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, window.location.origin);
    const bootstrap = url.searchParams.get('bootstrap');
    if (bootstrap) return { type: 'bootstrap', token: bootstrap };
    const invite = url.searchParams.get('invite');
    if (invite) return { type: 'invite', token: invite };
  } catch {
    // not a full URL
  }

  const bootstrapMatch = trimmed.match(/[?&]bootstrap=([^&\s#]+)/i);
  if (bootstrapMatch?.[1]) {
    return { type: 'bootstrap', token: decodeURIComponent(bootstrapMatch[1]) };
  }

  const inviteMatch = trimmed.match(/[?&]invite=([^&\s#]+)/i);
  if (inviteMatch?.[1]) {
    return { type: 'invite', token: decodeURIComponent(inviteMatch[1]) };
  }

  return null;
}

/** @deprecated Prefer parseAuthLink — kept for QR invite-only callers. */
export function parseInviteToken(text: string): string | null {
  const link = parseAuthLink(text);
  return link?.type === 'invite' ? link.token : null;
}
