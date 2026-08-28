import { z } from 'zod';

import { badRequest } from '../utils/httpError.js';

export type SettingsRecord = Record<string, unknown>;

const recordSchema = z.record(z.string(), z.unknown());
const stringSchema = z.string();
const booleanSchema = z.boolean();
const integerSchema = z.number().int();

export function toSettingsRecord(value: unknown): SettingsRecord {
  return recordSchema.safeParse(value).data ?? {};
}

export function requireSettingsRecord(value: unknown, message: string): SettingsRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(message);
  }

  return parsed.data;
}

export function hasSetting(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function normalizeTrimmedString(value: unknown): string {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data.trim() : '';
}

export function requireStringSetting(value: unknown, message: string): string {
  const parsed = stringSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(message);
  }

  return parsed.data;
}

export function requireBooleanSetting(value: unknown, fieldLabel: string): boolean {
  const parsed = booleanSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`${fieldLabel} must be true or false`);
  }

  return parsed.data;
}

export function normalizeEnumSetting<T extends readonly [string, ...string[]]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  const parsed = z.enum(values).safeParse(normalized);
  return parsed.success ? parsed.data : fallback;
}

export function normalizeStrictEnumSetting<T extends readonly [string, ...string[]]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const parsed = z.enum(values).safeParse(normalized);
  if (!parsed.success) {
    throw badRequest(`Invalid configuration value "${value}"`);
  }

  return parsed.data;
}

export function normalizeBoundedText(
  value: unknown,
  fieldLabel: string,
  maxLength: number,
  options: { singleLine?: boolean } = {},
): string {
  const normalized = normalizeTrimmedString(value);
  if (!normalized) {
    return '';
  }

  const parsed = stringSchema.max(maxLength).safeParse(normalized);
  if (!parsed.success) {
    throw badRequest(`${fieldLabel} is too long`);
  }
  if (/\0/.test(normalized)) {
    throw badRequest(`${fieldLabel} contains an invalid character`);
  }
  if (options.singleLine && /[\r\n]/.test(normalized)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }

  return normalized;
}

export function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function normalizeBoundedSingleLineString(
  value: unknown,
  fieldLabel: string,
  maxLength: number,
  options: { strict?: boolean } = {},
): string {
  if (options.strict && typeof value !== 'undefined' && !stringSchema.safeParse(value).success) {
    throw badRequest(`${fieldLabel} must be a string`);
  }

  const normalized = normalizeTrimmedString(value);
  if (!normalized) {
    return '';
  }

  const parsed = stringSchema
    .max(maxLength)
    .refine((candidate) => !/[\r\n\0]/.test(candidate))
    .safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  throw badRequest(issue?.code === 'too_big'
    ? `${fieldLabel} is too long`
    : `${fieldLabel} must be a single-line value`);
}

export function parseIntegerSetting(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;
  const parsed = integerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizePositiveIntegerSetting(
  value: unknown,
  fieldLabel: string,
  maxValue: number,
): number {
  if (value === '') {
    throw badRequest(`${fieldLabel} is required`);
  }

  const parsed = parseIntegerSetting(value);
  if (parsed == null || parsed < 1) {
    throw badRequest(`${fieldLabel} must be a positive whole number`);
  }

  if (parsed > maxValue) {
    throw badRequest(`${fieldLabel} is too large`);
  }

  return parsed;
}
