import { JSONPath } from 'jsonpath-plus';

/**
 * Evaluates a JSONPath expression with the same engine and options used by the
 * object-path nodes. Callers retain ownership of their no-match and error
 * policy; this helper deliberately lets JSONPath errors propagate.
 */
export function evaluateJsonPath<T = unknown>(value: unknown, path: string, wrap = false): T | T[] | undefined {
  return JSONPath<T>({
    json: value ?? null,
    path: path.trim(),
    wrap,
  });
}
