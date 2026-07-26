import { GRAPH_BUILDER_LIMITS } from './graphBuilderLimits.js';
import { parsePortableJson, type PortableJsonValue } from './portableJson.js';
import { stringifyPortableJsonValue } from './portableJsonSerialization.js';

const MAX_AUTHORING_IDENTITY_DEPTH = 128;
const MAX_AUTHORING_IDENTITY_BYTES = 64 * 1024 * 1024;

/** Locale-independent ordering for every deterministic Graph Builder surface. */
export function compareGraphBuilderStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Encodes a tuple without relying on a delimiter that could also occur inside
 * a valid Rivet identifier. This is used for internal Map/Set keys only.
 */
export function graphBuilderStringTupleKey(...values: readonly string[]): string {
  return JSON.stringify(values);
}

function sortPortableValue(value: PortableJsonValue): PortableJsonValue {
  if (Array.isArray(value)) {
    return value.map(sortPortableValue);
  }

  if (value !== null && typeof value === 'object') {
    const sorted = Object.create(null) as Record<string, PortableJsonValue>;
    for (const key of Object.keys(value).sort(compareGraphBuilderStrings)) {
      sorted[key] = sortPortableValue(value[key]!);
    }
    return sorted;
  }

  return value;
}

export function canonicalizeGraphBuilderValue(value: unknown): PortableJsonValue {
  return sortPortableValue(parsePortableJson(value));
}

export function canonicalGraphBuilderStringify(value: unknown): string {
  return stringifyPortableJsonValue(canonicalizeGraphBuilderValue(value));
}

/**
 * Canonical serializer for complete Rivet project/editor snapshots.
 *
 * Protocol values use the much tighter portable-JSON limits above. Authoring
 * projects legitimately contain large node arrays and long text settings, so
 * their compare-and-swap identity needs a separate bounded serializer.
 * Undefined optional object properties follow JSON semantics and are omitted;
 * undefined array entries and every other non-JSON value fail closed.
 */
export function canonicalGraphBuilderAuthoringStringify(value: unknown): string {
  const canonicalValue = cloneAuthoringIdentityValue(value, '$', 0, new Set());
  const serialized = JSON.stringify(canonicalValue);
  if (serialized === undefined) {
    throw new Error('Graph Builder authoring identity is not serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_AUTHORING_IDENTITY_BYTES) {
    throw new Error(`Graph Builder authoring identity exceeds ${MAX_AUTHORING_IDENTITY_BYTES} bytes.`);
  }
  return serialized;
}

/**
 * Verifies that an authoring value is a data-only JSON-like structure before
 * callers clone, spread, or otherwise dereference it. Serialized byte limits
 * remain owned by canonicalGraphBuilderAuthoringStringify.
 */
export function assertGraphBuilderAuthoringValue(value: unknown): void {
  cloneAuthoringIdentityValue(value, '$', 0, new Set());
}

/**
 * Produces a stable, non-cryptographic identity for already bounded protocol
 * values. Callers that use the identity as an authority check must retain and
 * compare the canonical string as well.
 */
export function hashCanonicalGraphBuilderValue(value: unknown): string {
  return hashGraphBuilderString(canonicalGraphBuilderStringify(value));
}

export function hashCanonicalGraphBuilderAuthoringValue(value: unknown): string {
  return hashGraphBuilderString(canonicalGraphBuilderAuthoringStringify(value));
}

export function hashGraphBuilderString(value: string): string {
  const bytes = encodeGraphBuilderHashBytes(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function encodeGraphBuilderHashBytes(value: string): Uint8Array {
  let hasUnpairedSurrogate = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
      } else {
        hasUnpairedSurrogate = true;
        break;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      hasUnpairedSurrogate = true;
      break;
    }
  }
  if (!hasUnpairedSurrogate) {
    return new TextEncoder().encode(value);
  }

  // TextEncoder replaces every unpaired UTF-16 surrogate with U+FFFD, making
  // distinct malformed JavaScript strings deterministically alias. 0xff cannot
  // occur in valid UTF-8, so this tagged UTF-16LE fallback stays disjoint from
  // the long-standing UTF-8 encoding used for every well-formed string.
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[2 + index * 2] = codeUnit & 0xff;
    bytes[3 + index * 2] = codeUnit >>> 8;
  }
  return bytes;
}

export function toBoundedGraphBuilderIdentifier(value: string): string {
  if (value.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength) {
    return value;
  }

  const suffix = `:${hashGraphBuilderString(value)}`;
  const prefixLength = GRAPH_BUILDER_LIMITS.maxIdentifierLength - suffix.length;
  let prefix = value.slice(0, prefixLength);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  const nextCodeUnit = value.charCodeAt(prefix.length);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}

function cloneAuthoringIdentityValue(value: unknown, path: string, depth: number, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Graph Builder authoring identity has an unsafe number at ${path}.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new Error(`Graph Builder authoring identity has an unsupported ${typeof value} at ${path}.`);
  }
  if (depth >= MAX_AUTHORING_IDENTITY_DEPTH) {
    throw new Error(`Graph Builder authoring identity is too deeply nested at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Graph Builder authoring identity is cyclic at ${path}.`);
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Graph Builder authoring identity has a non-plain object at ${path}.`);
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Graph Builder authoring identity has symbol keys at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      // An inherited Array.prototype.toJSON must not be able to replace the
      // validated value during serialization.
      Object.defineProperty(output, 'toJSON', { value: undefined, configurable: true });
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          throw new Error(`Graph Builder authoring identity has sparse array data at ${path}[${index}].`);
        }
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new Error(`Graph Builder authoring identity has a non-data array entry at ${path}[${index}].`);
        }
        if (descriptor.value === undefined) {
          throw new Error(`Graph Builder authoring identity has undefined array data at ${path}[${index}].`);
        }
        output.push(cloneAuthoringIdentityValue(descriptor.value, `${path}[${index}]`, depth + 1, ancestors));
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new Error(`Graph Builder authoring identity has hidden or extra array data at ${path}.`);
      }
      return output;
    }

    const enumerableKeys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== enumerableKeys.length) {
      throw new Error(`Graph Builder authoring identity has non-enumerable data at ${path}.`);
    }

    const output = Object.create(null) as Record<string, unknown>;
    for (const key of enumerableKeys.sort(compareGraphBuilderStrings)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new Error(`Graph Builder authoring identity has an accessor at ${path}.${key}.`);
      }
      if (descriptor.value === undefined) {
        continue;
      }
      output[key] = cloneAuthoringIdentityValue(descriptor.value, `${path}.${key}`, depth + 1, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
