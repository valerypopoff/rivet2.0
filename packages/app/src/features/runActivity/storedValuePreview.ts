import type { StoredDataPreview, StoredDataValue } from '../../state/dataFlow.js';

export const RUN_ACTIVITY_PREVIEW_MAX_CHARS = 240;
const INLINE_PREVIEW_MAX_DEPTH = 2;
const INLINE_PREVIEW_MAX_ITEMS = 8;

export function previewStoredDataValue(value: StoredDataValue): string {
  if (value.storage === 'ref') return previewStoredRef(value.preview);
  return truncatePreview(previewInlineValue(value.value));
}

function previewStoredRef(preview: StoredDataPreview): string {
  if (preview.kind === 'summary') return truncatePreview(preview.label);
  return truncatePreview(preview.excerpt);
}

function previewInlineValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return projectInlineValue(value, 0, new WeakSet<object>());
}

function projectInlineValue(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (typeof value === 'string') return JSON.stringify(truncatePreview(value));
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= INLINE_PREVIEW_MAX_DEPTH) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, INLINE_PREVIEW_MAX_ITEMS)
        .map((entry) => projectInlineValue(entry, depth + 1, seen));
      if (value.length > INLINE_PREVIEW_MAX_ITEMS) entries.push(`... ${value.length - INLINE_PREVIEW_MAX_ITEMS} more`);
      return `[${entries.join(', ')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const projected = entries
      .slice(0, INLINE_PREVIEW_MAX_ITEMS)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${projectInlineValue(entry, depth + 1, seen)}`);
    if (entries.length > INLINE_PREVIEW_MAX_ITEMS)
      projected.push(`... ${entries.length - INLINE_PREVIEW_MAX_ITEMS} more`);
    return `{${projected.join(', ')}}`;
  } catch {
    return '[Unpreviewable value]';
  } finally {
    seen.delete(value);
  }
}

function truncatePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= RUN_ACTIVITY_PREVIEW_MAX_CHARS) return normalized;
  return `${normalized.slice(0, RUN_ACTIVITY_PREVIEW_MAX_CHARS - 3)}...`;
}
