export const NODE_BODY_FIELD_LABEL_CLASS = 'rivet-node-body-field-label';
export const NODE_BODY_FIELD_VALUE_CLASS = 'rivet-node-body-field-value';
export const NODE_BODY_FIELD_ROW_CLASS = 'rivet-node-body-field-row';
export const NODE_BODY_TEXT_ROW_CLASS = 'rivet-node-body-text-row';
export const NODE_BODY_SEPARATOR_CLASS = 'rivet-node-body-separator';

/**
 * Renders a label/value pair for a Markdown node body without letting authored
 * values become Markdown. Class-based styling is deliberately used instead of
 * inline styles because node-body Markdown is sanitized before it reaches DOM.
 */
export function formatNodeBodyMarkdownField(label: string, value: unknown): string {
  return `<div class="${NODE_BODY_FIELD_ROW_CLASS}">${formatNodeBodyMarkdownLabel(label)} ${formatNodeBodyMarkdownValue(value)}</div>`;
}

/** Renders a sanitized, styled field label without adding an empty value node. */
export function formatNodeBodyMarkdownLabel(label: string): string {
  return `<span class="${NODE_BODY_FIELD_LABEL_CLASS}">${escapeNodeBodyMarkdownText(label)}:</span>`;
}

/** Wraps authored text in a raw HTML span so Markdown punctuation stays literal. */
export function formatNodeBodyMarkdownValue(value: unknown): string {
  return `<span class="${NODE_BODY_FIELD_VALUE_CLASS}">${escapeNodeBodyMarkdownText(value)}</span>`;
}

/** Renders unlabelled authored text as a standalone Markdown body row. */
export function formatNodeBodyMarkdownTextRow(value: unknown): string {
  return `<div class="${NODE_BODY_TEXT_ROW_CLASS}">${formatNodeBodyMarkdownValue(value)}</div>`;
}

/** A block separator that does not cause Markdown to create empty paragraphs. */
export function formatNodeBodyMarkdownSeparator(): string {
  return `<div class="${NODE_BODY_SEPARATOR_CLASS}"></div>`;
}

function escapeNodeBodyMarkdownText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
