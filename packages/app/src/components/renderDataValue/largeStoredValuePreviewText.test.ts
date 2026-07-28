import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveLargeStoredValuePreviewFullText } from './largeStoredValuePreviewText.js';

test('deriveLargeStoredValuePreviewFullText returns raw string values', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'string',
      value: 'hello',
    }),
    'hello',
  );
});

test('deriveLargeStoredValuePreviewFullText joins string arrays with newlines', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'string[]',
      value: ['alpha', 'beta'],
    }),
    'alpha\nbeta',
  );
});

test('deriveLargeStoredValuePreviewFullText pretty-prints object values', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'object',
      value: { alpha: 1 },
    }),
    '{\n  "alpha": 1\n}',
  );
});

test('deriveLargeStoredValuePreviewFullText pretty-prints object array values', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'object[]',
      value: [{ alpha: 1 }],
    }),
    '[\n  {\n    "alpha": 1\n  }\n]',
  );
});

test('deriveLargeStoredValuePreviewFullText keeps string any values raw', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'any',
      value: 'hello',
    }),
    'hello',
  );
});

test('deriveLargeStoredValuePreviewFullText pretty-prints object any values', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'any',
      value: { alpha: true },
    }),
    '{\n  "alpha": true\n}',
  );
});

test('deriveLargeStoredValuePreviewFullText keeps explicit undefined any-array items visible', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'any[]',
      value: [undefined, { alpha: true }, [undefined]],
    }),
    '[\n  "undefined",\n  {\n    "alpha": true\n  },\n  [\n    "undefined"\n  ]\n]',
  );
});

test('deriveLargeStoredValuePreviewFullText returns plain function-result text', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'chat-message',
      value: {
        type: 'function',
        name: 'call_1',
        toolName: 'lookup',
        message: 'tool result',
      },
    }),
    'tool result',
  );
});

test('deriveLargeStoredValuePreviewFullText preserves non-function messages for the role-aware renderer', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'chat-message',
      value: {
        type: 'assistant',
        message: 'assistant response',
        function_call: undefined,
        function_calls: undefined,
      },
    }),
    undefined,
  );
});

test('deriveLargeStoredValuePreviewFullText joins plain function-result arrays', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'chat-message[]',
      value: [
        { type: 'function', name: 'call_1', toolName: 'first', message: 'first result' },
        { type: 'function', name: 'call_2', toolName: 'second', message: 'second result' },
      ],
    }),
    'first result\nsecond result',
  );
});

test('deriveLargeStoredValuePreviewFullText preserves mixed message arrays for the role-aware renderer', () => {
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'chat-message[]',
      value: [
        { type: 'function', name: 'call_1', toolName: 'first', message: 'first result' },
        { type: 'assistant', message: 'assistant response', function_call: undefined, function_calls: undefined },
      ],
    }),
    undefined,
  );
});

test('deriveLargeStoredValuePreviewFullText returns undefined for missing or unsupported values', () => {
  assert.equal(deriveLargeStoredValuePreviewFullText(undefined), undefined);
  assert.equal(
    deriveLargeStoredValuePreviewFullText({
      type: 'number',
      value: 1,
    }),
    undefined,
  );
});
