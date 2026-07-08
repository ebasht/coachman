const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match?.length) return null;
  const url = match[0].replace(/[),.!?;:]+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function linkifyText(text: string): Array<{ type: 'text' | 'link'; value: string }> {
  const parts: Array<{ type: 'text' | 'link'; value: string }> = [];
  let lastIndex = 0;
  const re = new RegExp(URL_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const raw = match[0].replace(/[),.!?;:]+$/, '');
    parts.push({ type: 'link', value: raw });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: 'text', value: text }];
}
