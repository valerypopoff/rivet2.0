import { badRequest } from './httpError.js';

export function parseBoolean(value: string | undefined, fallback = false): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function parseEnum<T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
  fallback: T,
  options: { strict?: boolean } = {},
): T {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if ((allowedValues as readonly string[]).includes(normalized)) {
    return normalized as T;
  }

  if (options.strict) {
    throw badRequest(`Invalid configuration value "${value}"`);
  }

  return fallback;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function parseIntWithMinimum(value: string | undefined, fallback: number, minimum: number): number {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, parsed);
}
