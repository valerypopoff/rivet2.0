export type JsonObjectParseResult =
  | { value: Record<string, unknown>; error?: never }
  | { value?: never; error: string };

export function formatJsonObjectEditorValue(value: unknown): string {
  if (!isPlainObject(value)) {
    return '{}';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

export function parseJsonObjectEditorValue(text: string): JsonObjectParseResult {
  if (!text.trim()) {
    return { value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid JSON.' };
  }

  if (!isPlainObject(parsed)) {
    return { error: 'Value must be a JSON object.' };
  }

  return { value: parsed };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
