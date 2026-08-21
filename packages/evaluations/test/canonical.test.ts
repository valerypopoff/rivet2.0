import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPortableJson, canonicalStringify } from '../src/index.js';

test('portable JSON rejects sparse arrays and array properties that serialization would discard', () => {
  assert.throws(() => assertPortableJson(new Array(1)), /sparse array entry/);

  const withExtraProperty = [1] as number[] & { extra?: number };
  withExtraProperty.extra = 2;
  assert.throws(() => assertPortableJson(withExtraProperty), /hidden or extra array properties/);

  const withSymbol = [1];
  Object.defineProperty(withSymbol, Symbol('hidden'), { value: 2, enumerable: true });
  assert.throws(() => assertPortableJson(withSymbol), /symbol-keyed array properties/);
});

test('portable JSON rejects hidden, symbol-keyed, and accessor object properties', () => {
  const withHidden = { visible: true };
  Object.defineProperty(withHidden, 'hidden', { value: true, enumerable: false });
  assert.throws(() => assertPortableJson(withHidden), /non-enumerable object properties/);

  const withSymbol = { visible: true };
  Object.defineProperty(withSymbol, Symbol('hidden'), { value: true, enumerable: true });
  assert.throws(() => assertPortableJson(withSymbol), /symbol-keyed object properties/);

  const withAccessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(withAccessor, 'value', { enumerable: true, get: () => 'not data' });
  assert.throws(() => assertPortableJson(withAccessor), /enumerable data property/);
});

test('canonical stringification remains stable for ordinary portable JSON', () => {
  assert.equal(canonicalStringify({ z: [1, { b: true, a: null }], a: 'value' }), '{"a":"value","z":[1,{"a":null,"b":true}]}');
});
