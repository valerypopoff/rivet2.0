import type { PortableJsonObject, PortableJsonValue } from './portableJson.js';

function createSerializationSafePortableValue(value: PortableJsonValue): PortableJsonValue {
  if (Array.isArray(value)) {
    const output = value.map(createSerializationSafePortableValue);
    // JSON.stringify invokes an inherited Array.prototype.toJSON before it
    // visits any entries. Shadow it only on this private serialization clone;
    // parsed values remain ordinary portable arrays.
    Object.defineProperty(output, 'toJSON', { value: undefined, configurable: true });
    return output;
  }

  if (value !== null && typeof value === 'object') {
    const output = Object.create(null) as PortableJsonObject;
    for (const key of Object.keys(value)) {
      output[key] = createSerializationSafePortableValue(value[key]!);
    }
    return output;
  }

  return value;
}

/**
 * Internal serializer for values that have already crossed the portable-JSON
 * boundary. It prevents prototype behavior from replacing validated data.
 */
export function stringifyPortableJsonValue(value: PortableJsonValue): string {
  return JSON.stringify(createSerializationSafePortableValue(value));
}
