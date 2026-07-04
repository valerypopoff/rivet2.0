function normalizeEditorLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function jsonEscapeText(text: string): string {
  return JSON.stringify(normalizeEditorLineEndings(text)).slice(1, -1);
}

export function jsonUnescapeText(text: string): string | undefined {
  try {
    const value = JSON.parse(`"${text}"`);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
