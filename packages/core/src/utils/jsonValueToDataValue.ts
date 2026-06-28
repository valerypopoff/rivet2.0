import type { DataValue } from '../model/DataValue.js';

export function jsonValueToDataValue(value: unknown): DataValue {
  if (isDataValue(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }

  if (Array.isArray(value)) {
    return jsonArrayToDataValue(value);
  }

  if (isRecord(value)) {
    return { type: 'object', value };
  }

  return { type: 'any', value };
}

function jsonArrayToDataValue(value: unknown[]): DataValue {
  if (value.length === 0) {
    return { type: 'any[]', value: [] } as DataValue;
  }

  if (value.every((item) => typeof item === 'string')) {
    return { type: 'string[]', value } as DataValue;
  }

  if (value.every((item) => typeof item === 'number')) {
    return { type: 'number[]', value } as DataValue;
  }

  if (value.every((item) => typeof item === 'boolean')) {
    return { type: 'boolean[]', value } as DataValue;
  }

  if (value.every(isRecord)) {
    return { type: 'object[]', value } as DataValue;
  }

  return { type: 'any[]', value } as DataValue;
}

function isDataValue(value: unknown): value is DataValue {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    'value' in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
