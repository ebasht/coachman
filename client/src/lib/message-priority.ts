export function isMediaMessageType(type: string | undefined): boolean {
  return type === 'image' || type === 'video';
}

/** Process text/list/call rows before photos so a media batch cannot stall plaintext. */
export function prioritizeTextMessages<T extends { type?: string }>(rows: T[]): T[] {
  const text: T[] = [];
  const media: T[] = [];
  for (const row of rows) {
    if (isMediaMessageType(row.type)) media.push(row);
    else text.push(row);
  }
  return text.length && media.length ? [...text, ...media] : rows;
}
