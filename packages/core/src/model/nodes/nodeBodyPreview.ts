const MAX_BODY_PREVIEW_LINES = 15;
const MAX_BODY_PREVIEW_LINE_LENGTH = 240;
const MAX_BODY_PREVIEW_CHARS = 3000;

/**
 * Bounds node-card previews without changing the full value persisted in node data.
 *
 * The limits are intentionally shared by text-like node bodies so one long field
 * cannot make its canvas card taller than the familiar Text-node preview.
 */
export function buildNodeBodyPreview(text: string, maximumLines = MAX_BODY_PREVIEW_LINES): string {
  const allLines = text.split('\n');
  const previewLines = allLines.slice(0, maximumLines).map((line) =>
    line.length > MAX_BODY_PREVIEW_LINE_LENGTH ? `${line.slice(0, MAX_BODY_PREVIEW_LINE_LENGTH)}...` : line,
  );

  const omittedLines = allLines.length > maximumLines;
  let previewText = previewLines.join('\n').trim();

  if (previewText.length > MAX_BODY_PREVIEW_CHARS) {
    previewText = previewText.slice(0, MAX_BODY_PREVIEW_CHARS).trimEnd();

    return previewText.length === 0 ? '...' : `${previewText}\n...`;
  }

  if (omittedLines) {
    return previewText.length === 0 ? '...' : `${previewText}\n...`;
  }

  return previewText;
}
