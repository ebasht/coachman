/**
 * Heuristic for a brief plaintext experiment that stored readable text without iv=plain.
 * Must NOT treat short AES-GCM base64 blobs as plaintext (that showed «битые» messages).
 */
export function looksLikeLegacyPlaintext(ciphertext: string): boolean {
  const t = ciphertext.trim();
  if (!t) return false;
  // Pure base64 alphabet (with optional padding) — almost certainly ciphertext.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(t) && !/[а-яёА-ЯЁ\s]/.test(t)) {
    return false;
  }
  // Readable text usually has spaces, punctuation, or non-latin letters.
  if (/[\s.,!?;:()«»"'…]/.test(t) || /[а-яёА-ЯЁ]/.test(t)) {
    return true;
  }
  // Short Latin-only tokens without base64 padding can still be ciphertext; be conservative.
  return false;
}
