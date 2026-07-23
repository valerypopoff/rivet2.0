import assert from 'node:assert/strict';
import test from 'node:test';
import { formatJsonObjectEditorValue, parseJsonObjectEditorValue } from './jsonObjectEditorValue.js';

test('formats object settings as editable JSON instead of JavaScript string coercions', () => {
  assert.equal(formatJsonObjectEditorValue({}), '{}');
  assert.equal(
    formatJsonObjectEditorValue({ author: 'Octavia Butler', chapter: 3 }),
    '{\n  "author": "Octavia Butler",\n  "chapter": 3\n}',
  );
  assert.equal(formatJsonObjectEditorValue('[object Object]'), '{}');
});

test('parses JSON objects and treats an empty editor as an empty object', () => {
  assert.deepEqual(parseJsonObjectEditorValue(''), { value: {} });
  assert.deepEqual(parseJsonObjectEditorValue('{"field":"language","operator":"eq","value":"en"}'), {
    value: { field: 'language', operator: 'eq', value: 'en' },
  });
});

test('rejects malformed JSON and non-object JSON values', () => {
  assert.match(parseJsonObjectEditorValue('{').error ?? '', /JSON|position|property/i);
  assert.equal(parseJsonObjectEditorValue('null').error, 'Value must be a JSON object.');
  assert.equal(parseJsonObjectEditorValue('[]').error, 'Value must be a JSON object.');
});
