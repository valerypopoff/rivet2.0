import { createHash } from 'node:crypto';
import { badRequest } from '../utils/httpError.js';

export function requestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    throw badRequest('A UUID requestId is required for this action.');
  return value.toLowerCase();
}

// Key order is not part of an intent; fingerprints contain no raw input.
export function requestFingerprint(intent: unknown): string {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(intent)))
    .digest('hex');
}
