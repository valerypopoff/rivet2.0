import type { ClassifierEntry } from './types.js';
import type { DataValue } from '../DataValue.js';
import type { Inputs } from '../GraphProcessor.js';
import { ClassifierValueBudget, type ClassifierPreparationCheck } from './limits.js';

/** Read evidence fields without invoking getters or accepting prototype-provided content. */
export function classifierDataProperty(value: object, key: string, label = 'State'): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property ? !('value' in property) : key in value)
    throw new Error(`${label} must use own data properties, not accessors or inherited fields.`);
  return property?.value;
}

/** Snapshot only the selected port's wrapper; never read unrelated input getters. */
export function classifierInputDataValue(inputs: Inputs, port: string): DataValue | undefined {
  const label = `Classifier ${port} input`;
  const input = classifierDataProperty(inputs, port, label);
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${label} must contain a Rivet data value.`);
  return {
    type: classifierDataProperty(input, 'type', label),
    value: classifierDataProperty(input, 'value', label),
  } as DataValue;
}

/** Match JSON array order; never invoke a caller-provided iterator or index getter. */
export function* classifierArrayValues(value: readonly unknown[], label: string): Generator<unknown> {
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !('value' in property))
      throw new Error(`${label} is not JSON-compatible: use own data properties, not accessors or sparse arrays.`);
    yield property.value;
  }
}

/** Validate the data JSON.stringify will read, without invoking property getters or array iterators. */
export function assertClassifierJson(
  value: unknown,
  label = 'State',
  allowUndefinedProperties = false,
  check?: ClassifierPreparationCheck,
  maxBytes?: number,
): number {
  return new ClassifierValueBudget(check, maxBytes).inspect(value, { label, allowUndefinedProperties }).bytes;
}

/** Validate, account and detach JSON in one bounded walk, without serialization hooks. */
export function snapshotClassifierJson(
  value: unknown,
  label: string,
  budget: ClassifierValueBudget,
  allowUndefinedProperties = false,
): unknown {
  return budget.inspect(value, { label, allowUndefinedProperties, copy: true }).value;
}

/** Root entry kinds are narrower than the JSON values allowed inside structured entries. */
export function assertClassifierEntryKind(value: unknown, label: string): asserts value is ClassifierEntry {
  if (value !== null && typeof value !== 'string' && typeof value !== 'object')
    throw new Error(`${label} must contain only strings, null, objects, and arrays.`);
}

export function assertClassifierEntry(value: unknown, label: string): asserts value is ClassifierEntry {
  assertClassifierEntryKind(value, label);
  assertClassifierJson(value, label);
}

export function assertClassifierInstructionsKind(
  value: unknown,
  label = 'Instructions',
): asserts value is Exclude<ClassifierEntry, null> {
  assertClassifierEntryKind(value, label);
  if (value === null || (typeof value === 'string' && value.trim() === '')) throw new Error(`${label} are required.`);
}

export function assertClassifierInstructions(
  value: unknown,
  label = 'Instructions',
): asserts value is Exclude<ClassifierEntry, null> {
  // Bound strings before trim(), which can otherwise scan an oversized authored value.
  assertClassifierEntry(value, label);
  assertClassifierInstructionsKind(value, label);
}
