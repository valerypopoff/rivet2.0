import type { EvaluationDatasetSnapshot, PortableJson } from './types.js';

export function assertPortableJson(
  value: unknown,
  path = '$',
  stack = new Set<object>(),
): asserts value is PortableJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain a non-finite number.`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${path} must be portable JSON.`);
  if (stack.has(value)) throw new Error(`${path} must not contain a cycle.`);
  if (Array.isArray(value)) {
    stack.add(value);
    value.forEach((entry, index) => assertPortableJson(entry, `${path}[${index}]`, stack));
    stack.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${path} must be a plain object.`);
  }
  stack.add(value);
  for (const [key, entry] of Object.entries(value)) assertPortableJson(entry, `${path}.${key}`, stack);
  stack.delete(value);
}

export function canonicalizePortableJson(value: unknown): PortableJson {
  assertPortableJson(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizePortableJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizePortableJson(value[key])]),
  );
}

/**
 * Evaluation inputs and observations cross concurrent graph-run boundaries.
 * Clone them before handing them to an adapter so a Code or evaluator graph
 * cannot mutate a dataset case, another trial, or the persisted run model.
 */
export function clonePortableJson<T extends PortableJson>(value: T): T {
  assertPortableJson(value);
  return structuredClone(value);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalizePortableJson(value));
}

/** Stable, synchronously available content fingerprint for project-local identities. */
export function fingerprint(value: unknown): string {
  const source = canonicalStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function fingerprintEvaluationDataset(value: { id: unknown; fields: unknown; cases: unknown }): string {
  return fingerprint({ datasetId: value.id, fields: value.fields, cases: value.cases });
}

/**
 * A dataset fingerprint is the link between a compact run summary and its
 * historical input cases. Stores must reject a mismatched key rather than
 * accepting a snapshot that can no longer prove which cases were run.
 */
export function assertEvaluationDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): void {
  if (snapshot.dataset.projectId !== snapshot.projectId) {
    throw new Error('An evaluation dataset snapshot must belong to its project.');
  }
  if (fingerprintEvaluationDataset(snapshot.dataset) !== snapshot.fingerprint) {
    throw new Error('An evaluation dataset snapshot fingerprint must match its dataset ID, fields, and cases.');
  }
}
