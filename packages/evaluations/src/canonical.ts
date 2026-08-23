import type { EvaluationDatasetSnapshot, EvaluationRecordingArtifact, PortableJson } from './types.js';

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
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} must not contain symbol-keyed array properties.`);
    }
    stack.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) throw new Error(`${path}[${index}] must not be a sparse array entry.`);
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new Error(`${path}[${index}] must be an enumerable data property.`);
        }
        assertPortableJson(descriptor.value, `${path}[${index}]`, stack);
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new Error(`${path} must not contain hidden or extra array properties.`);
      }
    } finally {
      stack.delete(value);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${path} must not contain symbol-keyed object properties.`);
  }
  const ownPropertyNames = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (ownPropertyNames.length !== keys.length) {
    throw new Error(`${path} must not contain non-enumerable object properties.`);
  }
  stack.add(value);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new Error(`${path}.${key} must be an enumerable data property.`);
      }
      assertPortableJson(descriptor.value, `${path}.${key}`, stack);
    }
  } finally {
    stack.delete(value);
  }
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
  if (
    typeof snapshot.projectId !== 'string' ||
    snapshot.projectId.length === 0 ||
    typeof snapshot.fingerprint !== 'string' ||
    snapshot.fingerprint.length === 0 ||
    typeof snapshot.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.createdAt))
  ) {
    throw new Error('An evaluation dataset snapshot has invalid identity or creation time.');
  }
  if (snapshot.dataset.projectId !== snapshot.projectId) {
    throw new Error('An evaluation dataset snapshot must belong to its project.');
  }
  if (fingerprintEvaluationDataset(snapshot.dataset) !== snapshot.fingerprint) {
    throw new Error('An evaluation dataset snapshot fingerprint must match its dataset ID, fields, and cases.');
  }
}

/** Rejects malformed replay evidence at both write and durable-read boundaries. */
export function assertEvaluationRecordingArtifact(value: unknown): asserts value is EvaluationRecordingArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('An evaluation recording artifact must be an object.');
  }
  const artifact = value as Partial<EvaluationRecordingArtifact>;
  if (
    typeof artifact.projectId !== 'string' ||
    artifact.projectId.length === 0 ||
    typeof artifact.runId !== 'string' ||
    artifact.runId.length === 0 ||
    typeof artifact.trialId !== 'string' ||
    artifact.trialId.length === 0 ||
    typeof artifact.serialized !== 'string' ||
    typeof artifact.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.createdAt))
  ) {
    throw new Error('An evaluation recording artifact has invalid identity, payload, or creation time.');
  }
  const reference = artifact.reference;
  if (
    typeof reference !== 'object' ||
    reference === null ||
    typeof reference.id !== 'string' ||
    reference.id.length === 0 ||
    !['temporary', 'failure', 'baseline', 'retained'].includes(reference.retention ?? '') ||
    (reference.expiresAt !== undefined &&
      (typeof reference.expiresAt !== 'string' || !Number.isFinite(Date.parse(reference.expiresAt))))
  ) {
    throw new Error('An evaluation recording artifact has an invalid retention reference.');
  }
}
