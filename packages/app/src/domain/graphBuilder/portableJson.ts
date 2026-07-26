import { GRAPH_BUILDER_DANGEROUS_KEYS, GRAPH_BUILDER_LIMITS } from './graphBuilderLimits.js';
import { stringifyPortableJsonValue } from './portableJsonSerialization.js';

export type PortableJsonPrimitive = null | boolean | number | string;
export type PortableJsonArray = PortableJsonValue[];
export type PortableJsonObject = { [key: string]: PortableJsonValue };
export type PortableJsonValue = PortableJsonPrimitive | PortableJsonArray | PortableJsonObject;

export type PortableJsonLimits = {
  maxArrayItems: number;
  maxBytes: number;
  maxDepth: number;
  maxObjectEntries: number;
  maxStringLength: number;
};

const DEFAULT_LIMITS: PortableJsonLimits = {
  maxArrayItems: GRAPH_BUILDER_LIMITS.maxArrayItems,
  maxBytes: GRAPH_BUILDER_LIMITS.maxPortableBytes,
  maxDepth: GRAPH_BUILDER_LIMITS.maxObjectDepth,
  maxObjectEntries: GRAPH_BUILDER_LIMITS.maxDictionaryEntries,
  maxStringLength: GRAPH_BUILDER_LIMITS.maxStringLength,
};

export class GraphBuilderPortableJsonError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = 'GraphBuilderPortableJsonError';
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePortableValue(
  value: unknown,
  path: string,
  depth: number,
  limits: PortableJsonLimits,
  ancestors: Set<object>,
): PortableJsonValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) {
      throw new GraphBuilderPortableJsonError(`String exceeds the ${limits.maxStringLength}-character limit`, path);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new GraphBuilderPortableJsonError('Number must be finite and within the safe numeric range', path);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== 'object') {
    throw new GraphBuilderPortableJsonError(`Unsupported ${typeof value} value`, path);
  }

  if (depth >= limits.maxDepth) {
    throw new GraphBuilderPortableJsonError(`Value exceeds the maximum depth of ${limits.maxDepth}`, path);
  }

  if (ancestors.has(value)) {
    throw new GraphBuilderPortableJsonError('Cyclic values are not portable JSON', path);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new GraphBuilderPortableJsonError(`Array exceeds the ${limits.maxArrayItems}-item limit`, path);
      }

      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new GraphBuilderPortableJsonError('Symbol-keyed array properties are not portable JSON', path);
      }

      const output: PortableJsonArray = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          throw new GraphBuilderPortableJsonError('Sparse arrays are not portable JSON', `${path}[${index}]`);
        }
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new GraphBuilderPortableJsonError(
            'Array entries must be enumerable data properties',
            `${path}[${index}]`,
          );
        }
        output.push(clonePortableValue(descriptor.value, `${path}[${index}]`, depth + 1, limits, ancestors));
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new GraphBuilderPortableJsonError('Array has hidden or extra properties', path);
      }
      return output;
    }

    if (!isPlainObject(value)) {
      throw new GraphBuilderPortableJsonError('Only plain objects are portable JSON', path);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new GraphBuilderPortableJsonError('Symbol-keyed object properties are not portable JSON', path);
    }
    const ownPropertyNames = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (ownPropertyNames.length !== keys.length) {
      throw new GraphBuilderPortableJsonError('Object has non-enumerable properties', path);
    }
    if (keys.length > limits.maxObjectEntries) {
      throw new GraphBuilderPortableJsonError(`Object exceeds the ${limits.maxObjectEntries}-property limit`, path);
    }

    const output = Object.create(null) as PortableJsonObject;
    for (const key of keys) {
      if (GRAPH_BUILDER_DANGEROUS_KEYS.has(key)) {
        throw new GraphBuilderPortableJsonError(`Dangerous object key "${key}" is not allowed`, path);
      }
      if (key.length > limits.maxStringLength) {
        throw new GraphBuilderPortableJsonError(
          `Object key exceeds the ${limits.maxStringLength}-character limit`,
          path,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new GraphBuilderPortableJsonError('Object entries must be data properties', `${path}.${key}`);
      }
      output[key] = clonePortableValue(descriptor.value, `${path}.${key}`, depth + 1, limits, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function enforceSerializedSize(value: PortableJsonValue, limits: PortableJsonLimits): void {
  const serialized = stringifyPortableJsonValue(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > limits.maxBytes) {
    throw new GraphBuilderPortableJsonError(`Value exceeds the ${limits.maxBytes}-byte limit`, '$');
  }
}

export function parsePortableJson(value: unknown, limitOverrides: Partial<PortableJsonLimits> = {}): PortableJsonValue {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const parsed = clonePortableValue(value, '$', 0, limits, new Set());
  enforceSerializedSize(parsed, limits);
  return parsed;
}

export function parsePortableJsonObject(
  value: unknown,
  limitOverrides: Partial<PortableJsonLimits> = {},
): PortableJsonObject {
  const parsed = parsePortableJson(value, limitOverrides);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new GraphBuilderPortableJsonError('Expected a portable JSON object', '$');
  }
  return parsed;
}

export function isPortableJson(value: unknown, limitOverrides: Partial<PortableJsonLimits> = {}): boolean {
  try {
    parsePortableJson(value, limitOverrides);
    return true;
  } catch {
    return false;
  }
}
