import { assertPortableJson } from './canonical.js';
import type { PortableJson } from './types.js';

function isObject(value: PortableJson): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: PortableJson): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isArrayOf(value: PortableJson, predicate: (item: PortableJson) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

/**
 * Checks a portable dataset value against the Rivet data type selected for an
 * evaluation field. This is shared by authoring UI and execution validation so
 * a value cannot look valid in the editor and then fail under a different rule
 * in the runner.
 */
export function isEvaluationValueCompatibleWithDataType(value: PortableJson, dataType: string): boolean {
  try {
    assertPortableJson(value);
  } catch {
    return false;
  }

  if (dataType === 'any') return true;
  if (dataType === 'any[]') return Array.isArray(value);
  if (dataType === 'string' || dataType === 'date' || dataType === 'time' || dataType === 'datetime') {
    return typeof value === 'string';
  }
  if (dataType === 'string[]' || dataType === 'date[]' || dataType === 'time[]' || dataType === 'datetime[]') {
    return isArrayOf(value, (item) => typeof item === 'string');
  }
  if (dataType === 'number') return isFiniteNumber(value);
  if (dataType === 'number[]' || dataType === 'vector') return isArrayOf(value, isFiniteNumber);
  if (dataType === 'vector[]') {
    return isArrayOf(value, (item) => isArrayOf(item, isFiniteNumber));
  }
  if (dataType === 'boolean') return typeof value === 'boolean';
  if (dataType === 'boolean[]') return isArrayOf(value, (item) => typeof item === 'boolean');
  if (dataType === 'object') return isObject(value);
  if (dataType === 'object[]') return isArrayOf(value, isObject);

  // Functions, binary/media values, and provider-specific structured types
  // do not have a safe portable dataset representation here. Unknown future
  // types must also fail closed until their exact JSON contract is defined.
  return false;
}
