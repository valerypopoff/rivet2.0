import assert from 'node:assert/strict';
import test from 'node:test';
import { isEvaluationValueCompatibleWithDataType, type PortableJson } from '../src/index.js';

test('checks scalar evaluation field values by their declared Rivet type', () => {
  assert.equal(isEvaluationValueCompatibleWithDataType('topic', 'string'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType(42, 'number'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType(true, 'boolean'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType('42', 'number'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType(1, 'boolean'), false);
});

test('distinguishes arrays, objects, and unrestricted values', () => {
  assert.equal(isEvaluationValueCompatibleWithDataType(['singer'], 'string[]'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType([42], 'string[]'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType({ role: 'singer' }, 'object'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType([{ role: 'singer' }], 'object[]'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType(['singer'], 'object'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType({ role: 'singer' }, 'object[]'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType(null, 'object'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType(null, 'any'), true);
});

test('supports exact portable date and vector representations', () => {
  assert.equal(isEvaluationValueCompatibleWithDataType('2026-08-16', 'date'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType(['12:00', '13:00'], 'time[]'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType([0.25, 0.75], 'vector'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType([[0.25], [0.75]], 'vector[]'), true);
  assert.equal(isEvaluationValueCompatibleWithDataType(['0.25'], 'vector'), false);
});

test('fails closed for unknown and non-portable Rivet data types', () => {
  assert.equal(isEvaluationValueCompatibleWithDataType('value', 'string-with-typo'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType([], 'array-with-typo'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType({}, 'fn<object>'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType({}, 'image'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType({}, 'future-provider-value'), false);
});

test('rejects non-portable runtime values even for any', () => {
  assert.equal(isEvaluationValueCompatibleWithDataType(Number.NaN as unknown as PortableJson, 'any'), false);
  assert.equal(isEvaluationValueCompatibleWithDataType(new Date() as unknown as PortableJson, 'any'), false);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isEvaluationValueCompatibleWithDataType(cyclic as unknown as PortableJson, 'any'), false);
});
