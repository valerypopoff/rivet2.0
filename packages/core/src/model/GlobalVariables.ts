import { type ScalarOrArrayDataType, type ScalarOrArrayDataValue, scalarTypes } from './DataValue.js';
import type { Project, ProjectId } from './Project.js';
import { base64ToUint8Array, uint8ArrayToBase64Sync } from '../utils/base64.js';

/**
 * A JSON-safe representation of a global value authored in project metadata.
 *
 * The marker is intentionally private to this codec. User objects with the
 * marker key are escaped, so no ordinary object can be mistaken for a value
 * sentinel after a project is saved and loaded again.
 */
/** Runtime validation, rather than a recursive TypeScript JSON type, keeps Project usable with Immer. */
export type ProjectGlobalVariableLiteral = unknown;

export type ProjectGlobalVariableDefinition = {
  type: ScalarOrArrayDataType;
  value: ProjectGlobalVariableLiteral;
};

export type ProjectGlobalVariables = Record<string, ProjectGlobalVariableDefinition>;

const literalMarkerKey = '$rivetProjectGlobalLiteral';
const literalMarkerObject = 'object';
const projectGlobalVariableScalarTypes = new Set<string>(
  scalarTypes.filter((type) => type !== 'control-flow-excluded'),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProjectGlobalVariableDataType(value: unknown): value is ScalarOrArrayDataType {
  if (typeof value !== 'string') return false;
  const scalarType = value.endsWith('[]') ? value.slice(0, -2) : value;
  return projectGlobalVariableScalarTypes.has(scalarType);
}

function isSparseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return true;
  }
  return false;
}

function marker(kind: string, value?: ProjectGlobalVariableLiteral): ProjectGlobalVariableLiteral {
  return value === undefined ? { [literalMarkerKey]: kind } : { [literalMarkerKey]: kind, value };
}

function encodeLiteral(value: unknown, seen: Set<object>): ProjectGlobalVariableLiteral {
  if (value === undefined) return marker('undefined');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (Number.isNaN(value)) return marker('number', 'nan');
    if (value === Infinity) return marker('number', 'infinity');
    if (value === -Infinity) return marker('number', '-infinity');
    return value;
  }

  if (value instanceof Uint8Array) {
    return marker('uint8array', uint8ArrayToBase64Sync(value));
  }

  if (typeof value !== 'object' || value === null) {
    throw new Error(`cannot persist ${typeof value} values`);
  }

  if (seen.has(value)) throw new Error('cannot persist circular values');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (isSparseArray(value)) throw new Error('cannot persist sparse arrays');
      return value.map((item) => encodeLiteral(item, seen));
    }
    if (!isPlainRecord(value)) throw new Error('can only persist plain objects and Uint8Array values');

    const entries = Object.entries(value).map(([key, item]) => [key, encodeLiteral(item, seen)] as const);
    if (Object.hasOwn(value, literalMarkerKey)) {
      return marker(
        literalMarkerObject,
        entries.map(([key, item]) => [key, item]) as unknown as ProjectGlobalVariableLiteral,
      );
    }

    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

function literalError(label: string, message: string): Error {
  return new Error(`${label}: ${message}`);
}

function decodeLiteral(value: unknown, label: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw literalError(label, 'must use a Rivet marker for a non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw literalError(label, 'value must be JSON-compatible');
  if (seen.has(value)) throw literalError(label, 'cannot be circular');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (isSparseArray(value)) throw literalError(label, 'cannot be a sparse array');
      return value.map((item, index) => decodeLiteral(item, `${label}[${index}]`, seen));
    }
    if (!isPlainRecord(value)) throw literalError(label, 'value must be JSON-compatible');

    if (Object.hasOwn(value, literalMarkerKey)) {
      const kind = value[literalMarkerKey];
      if (kind === 'undefined' && Object.keys(value).length === 1) return undefined;
      if (kind === 'number' && Object.keys(value).length === 2 && Object.hasOwn(value, 'value')) {
        if (value.value === 'nan') return Number.NaN;
        if (value.value === 'infinity') return Infinity;
        if (value.value === '-infinity') return -Infinity;
      }
      if (
        kind === 'uint8array' &&
        Object.keys(value).length === 2 &&
        Object.hasOwn(value, 'value') &&
        typeof value.value === 'string'
      ) {
        try {
          return base64ToUint8Array(value.value);
        } catch {
          throw literalError(label, 'has an invalid Uint8Array base64 value');
        }
      }
      if (
        kind === literalMarkerObject &&
        Object.keys(value).length === 2 &&
        Object.hasOwn(value, 'value') &&
        Array.isArray(value.value)
      ) {
        if (isSparseArray(value.value)) throw literalError(label, 'has a sparse escaped object value');
        const result: Record<string, unknown> = {};
        for (const [index, entry] of value.value.entries()) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            throw literalError(label, `has an invalid escaped object entry at index ${index}`);
          }
          Object.defineProperty(result, entry[0], {
            configurable: true,
            enumerable: true,
            value: decodeLiteral(entry[1], `${label}.${entry[0]}`, seen),
            writable: true,
          });
        }
        return result;
      }
      throw literalError(label, 'has an invalid reserved literal marker');
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: decodeLiteral(item, `${label}.${key}`, seen),
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function validateMetadata(value: unknown, label: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return;
  if (!Array.isArray(value) || isSparseArray(value))
    throw literalError(label, 'must contain only JSON-compatible metadata values');
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') continue;
    throw literalError(`${label}[${index}]`, 'must be a scalar value');
  }
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw literalError(label, 'must be an object');
  return value;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== 'string') throw literalError(label, 'must be a string');
}

function requireBoolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw literalError(label, 'must be a boolean');
}

function requireUint8Array(value: unknown, label: string): void {
  if (!(value instanceof Uint8Array)) throw literalError(label, 'must be a Uint8Array');
}

function validateChatMessagePart(value: unknown, label: string): void {
  if (typeof value === 'string') return;
  const part = requirePlainRecord(value, label);
  if (part.type === 'url') {
    requireString(part.url, `${label}.url`);
    return;
  }
  if (part.type === 'image') {
    requireString(part.mediaType, `${label}.mediaType`);
    requireUint8Array(part.data, `${label}.data`);
    return;
  }
  if (part.type === 'document') {
    requireString(part.mediaType, `${label}.mediaType`);
    requireUint8Array(part.data, `${label}.data`);
    if (part.title !== undefined) requireString(part.title, `${label}.title`);
    if (part.context !== undefined) requireString(part.context, `${label}.context`);
    requireBoolean(part.enableCitations, `${label}.enableCitations`);
    return;
  }
  throw literalError(label, 'has an unsupported message part');
}

function validateStructuredScalar(type: string, value: unknown, label: string): void {
  switch (type) {
    case 'any':
      return;
    case 'boolean':
      return requireBoolean(value, label);
    case 'number':
      if (typeof value !== 'number') throw literalError(label, 'must be a number');
      return;
    case 'string':
    case 'date':
    case 'time':
    case 'datetime':
      return requireString(value, label);
    case 'object':
      requirePlainRecord(value, label);
      return;
    case 'vector': {
      if (!Array.isArray(value) || isSparseArray(value) || !value.every((item) => typeof item === 'number')) {
        throw literalError(label, 'must be an array of numbers');
      }
      return;
    }
    case 'binary':
      return requireUint8Array(value, label);
    case 'image': {
      const image = requirePlainRecord(value, label);
      requireString(image.mediaType, `${label}.mediaType`);
      requireUint8Array(image.data, `${label}.data`);
      return;
    }
    case 'audio': {
      const audio = requirePlainRecord(value, label);
      if (audio.mediaType !== undefined) requireString(audio.mediaType, `${label}.mediaType`);
      requireUint8Array(audio.data, `${label}.data`);
      return;
    }
    case 'document': {
      const document = requirePlainRecord(value, label);
      requireString(document.mediaType, `${label}.mediaType`);
      requireUint8Array(document.data, `${label}.data`);
      if (document.title !== undefined) requireString(document.title, `${label}.title`);
      if (document.context !== undefined) requireString(document.context, `${label}.context`);
      requireBoolean(document.enableCitations, `${label}.enableCitations`);
      return;
    }
    case 'graph-reference': {
      const graph = requirePlainRecord(value, label);
      requireString(graph.graphId, `${label}.graphId`);
      requireString(graph.graphName, `${label}.graphName`);
      return;
    }
    case 'knowledge-source': {
      const source = requirePlainRecord(value, label);
      requireString(source.connectionId, `${label}.connectionId`);
      requireString(source.sourceId, `${label}.sourceId`);
      if (source.version !== undefined) requireString(source.version, `${label}.version`);
      return;
    }
    case 'knowledge-document': {
      const document = requirePlainRecord(value, label);
      requireString(document.text, `${label}.text`);
      if (document.id !== undefined) requireString(document.id, `${label}.id`);
      if (document.title !== undefined) requireString(document.title, `${label}.title`);
      if (document.metadata !== undefined) requirePlainRecord(document.metadata, `${label}.metadata`);
      for (const [key, item] of Object.entries((document.metadata ?? {}) as Record<string, unknown>)) {
        validateMetadata(item, `${label}.metadata.${key}`);
      }
      return;
    }
    case 'knowledge-evidence': {
      const evidence = requirePlainRecord(value, label);
      requireString(evidence.id, `${label}.id`);
      requireString(evidence.text, `${label}.text`);
      requireString(evidence.documentId, `${label}.documentId`);
      validateStructuredScalar('knowledge-source', evidence.source, `${label}.source`);
      if (evidence.relevanceScore !== undefined && typeof evidence.relevanceScore !== 'number') {
        throw literalError(`${label}.relevanceScore`, 'must be a number');
      }
      if (evidence.title !== undefined) requireString(evidence.title, `${label}.title`);
      if (evidence.chunkIndex !== undefined && typeof evidence.chunkIndex !== 'number') {
        throw literalError(`${label}.chunkIndex`, 'must be a number');
      }
      if (evidence.metadata !== undefined) requirePlainRecord(evidence.metadata, `${label}.metadata`);
      for (const [key, item] of Object.entries((evidence.metadata ?? {}) as Record<string, unknown>)) {
        validateMetadata(item, `${label}.metadata.${key}`);
      }
      return;
    }
    case 'gpt-function': {
      const fn = requirePlainRecord(value, label);
      requireString(fn.name, `${label}.name`);
      requireString(fn.description, `${label}.description`);
      requirePlainRecord(fn.parameters, `${label}.parameters`);
      requireBoolean(fn.strict, `${label}.strict`);
      if (fn.namespace !== undefined) requireString(fn.namespace, `${label}.namespace`);
      if (
        fn.resultHandling !== undefined &&
        fn.resultHandling !== 'continue' &&
        fn.resultHandling !== 'return-direct'
      ) {
        throw literalError(`${label}.resultHandling`, 'must be "continue" or "return-direct"');
      }
      return;
    }
    case 'chat-message': {
      const message = requirePlainRecord(value, label);
      if (
        message.type !== 'system' &&
        message.type !== 'developer' &&
        message.type !== 'user' &&
        message.type !== 'assistant' &&
        message.type !== 'function'
      ) {
        throw literalError(`${label}.type`, 'must be a supported chat message type');
      }
      const parts = Array.isArray(message.message) ? message.message : [message.message];
      if (Array.isArray(message.message) && isSparseArray(message.message)) {
        throw literalError(`${label}.message`, 'cannot be a sparse array');
      }
      for (const [index, part] of parts.entries()) validateChatMessagePart(part, `${label}.message[${index}]`);
      if (message.isCacheBreakpoint !== undefined)
        requireBoolean(message.isCacheBreakpoint, `${label}.isCacheBreakpoint`);
      if (message.type === 'assistant') {
        if (message.function_call !== undefined && !isPlainRecord(message.function_call)) {
          throw literalError(`${label}.function_call`, 'must be an object');
        }
        if (message.function_calls !== undefined && !Array.isArray(message.function_calls)) {
          throw literalError(`${label}.function_calls`, 'must be an array');
        }
      }
      if (message.type === 'function') requireString(message.name, `${label}.name`);
      return;
    }
    case 'llm-config': {
      const profile = requirePlainRecord(value, label);
      if (profile.version !== 1) throw literalError(`${label}.version`, 'must be version 1');
      requirePlainRecord(profile.configuration, `${label}.configuration`);
      requirePlainRecord(profile.credential, `${label}.credential`);
      return;
    }
    default:
      throw literalError(label, `has unsupported data type "${type}"`);
  }
}

function validateProjectGlobalVariableDataValue(type: ScalarOrArrayDataType, value: unknown, label: string): void {
  const isArrayType = type.endsWith('[]');
  const scalarType = isArrayType ? type.slice(0, -2) : type;
  const values = isArrayType ? value : [value];
  if (!Array.isArray(values) || (isArrayType && isSparseArray(values))) {
    throw literalError(label, isArrayType ? 'must be an array' : 'has an invalid value');
  }
  for (const [index, item] of values.entries()) {
    validateStructuredScalar(scalarType, item, isArrayType ? `${label}[${index}]` : label);
  }
}

/** Encodes a normal global value into a portable project-file definition. */
export function encodeProjectGlobalVariable(value: ScalarOrArrayDataValue): ProjectGlobalVariableDefinition {
  if (!isProjectGlobalVariableDataType(value.type)) {
    throw new Error(`Project global variables do not support data type "${value.type}".`);
  }

  validateProjectGlobalVariableDataValue(value.type, value.value, 'Project global variable');
  return { type: value.type, value: encodeLiteral(value.value, new Set()) };
}

/** Decodes and validates a single portable project-file global definition. */
export function decodeProjectGlobalVariable(value: unknown, label = 'Project global variable'): ScalarOrArrayDataValue {
  if (!isPlainRecord(value)) throw literalError(label, 'definition must be an object');
  if (!isProjectGlobalVariableDataType(value.type)) {
    throw literalError(label, 'type must be a supported non-function data type');
  }
  if (!Object.hasOwn(value, 'value')) throw literalError(label, 'definition is missing value');

  const decoded = {
    type: value.type,
    value: decodeLiteral(value.value, label),
  } as ScalarOrArrayDataValue;
  validateProjectGlobalVariableDataValue(decoded.type, decoded.value, label);
  return decoded;
}

function decodeProjectGlobalVariables(value: unknown, label: string): Array<[string, ScalarOrArrayDataValue]> {
  if (!isPlainRecord(value)) throw literalError(label, 'must be a plain object');

  return Object.entries(value).map(([id, definition]) => {
    if (!id.trim()) throw literalError(label, 'contains an empty variable ID');
    return [id, decodeProjectGlobalVariable(definition, `${label}.${id}`)];
  });
}

/** Validates definitions without retaining decoded runtime values. */
export function validateProjectGlobalVariables(value: unknown, label = 'Project metadata.globalVariables'): void {
  decodeProjectGlobalVariables(value, label);
}

export function getProjectGlobalVariableIds(project: Pick<Project, 'metadata'> | undefined): string[] {
  return Object.keys(project?.metadata.globalVariables ?? {}).filter((id) => id.trim().length > 0);
}

/**
 * Resolves referenced projects depth-first in reference order, then the root
 * project. Later definitions intentionally replace earlier ones; the root
 * project therefore always wins a collision with one of its references.
 */
export function resolveProjectGlobalVariables(
  rootProject: Project,
  loadedProjects: Readonly<Record<ProjectId, Project>>,
): Map<string, ScalarOrArrayDataValue> {
  const resolved = new Map<string, ScalarOrArrayDataValue>();
  const visited = new Set<ProjectId>();

  const visit = (project: Project) => {
    const projectId = project.metadata.id;
    if (visited.has(projectId)) return;

    // Existing project loading is cycle-tolerant: the first visit owns a
    // project and later back-edges reuse it. Keep project-global resolution
    // compatible with that behavior so adding defaults cannot reject a legacy
    // reference graph that ran before this feature existed.
    visited.add(projectId);
    for (const reference of project.references ?? []) {
      // The root is supplied separately from the referenced-project lookup.
      // A legacy child -> root back-edge must therefore reuse that in-memory
      // root, not require loaders to resolve the active project as if it were
      // another reference.
      if (reference.id === rootProject.metadata.id) {
        visit(rootProject);
        continue;
      }
      if (!Object.hasOwn(loadedProjects, reference.id)) {
        throw new Error(`Referenced project "${reference.id}" was not loaded while resolving project global variables.`);
      }
      const referencedProject = loadedProjects[reference.id]!;
      visit(referencedProject);
    }

    if (project.metadata.globalVariables !== undefined) {
      for (const [id, definition] of decodeProjectGlobalVariables(
        project.metadata.globalVariables,
        `Global variables in project "${projectId}"`,
      )) {
        resolved.set(id, definition);
      }
    }
  };

  visit(rootProject);
  return resolved;
}
