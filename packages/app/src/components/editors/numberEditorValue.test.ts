import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNumberEditorChange } from './numberEditorValue';

test('numeric editor preserves zero and fractional values without unit conversion', () => {
  for (const value of [0, 0.1, 0.35, 0.5, 1.75, -0.35]) {
    assert.deepEqual(resolveNumberEditorChange(String(value), value, false), { valid: true, value });
  }
});

test('only optional blank fields commit unset; invalid drafts never commit NaN', () => {
  assert.deepEqual(resolveNumberEditorChange('', NaN, true), { valid: true, value: undefined });
  for (const allowEmpty of [false, true]) {
    for (const [text, value] of [
      ['bad', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
    ] as const) {
      assert.deepEqual(resolveNumberEditorChange(text, value, allowEmpty), { valid: false });
    }
  }
  assert.deepEqual(resolveNumberEditorChange('', NaN, false), { valid: false });
  assert.deepEqual(resolveNumberEditorChange('', NaN, true, 1, true), { valid: false });
});

test('explicit unit conversion retains integer storage and rejects overflow', () => {
  for (const [seconds, milliseconds] of [
    [0.001, 1],
    [0.25, 250],
    [0.5, 500],
    [1.25, 1250],
  ] as const) {
    assert.deepEqual(resolveNumberEditorChange(String(seconds), seconds, false, 1000), {
      valid: true,
      value: milliseconds,
    });
  }
  assert.deepEqual(resolveNumberEditorChange('0.3505', 0.3505, false, 1000), { valid: true, value: 351 });
  assert.deepEqual(resolveNumberEditorChange('0', 0, false, 1000), { valid: true, value: 0 });
  assert.deepEqual(resolveNumberEditorChange('1e308', 1e308, false, 1000), { valid: false });
});
