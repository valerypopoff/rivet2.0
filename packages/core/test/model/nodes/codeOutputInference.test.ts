import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCodeOutputs,
  getCodeOutputFields,
  getCodeOutputKeys,
  prepareCodeOutputEdit,
} from '../../../src/model/nodes/codeOutputInference.js';

test('direct returns expose ordered explicit fields without evaluating expressions', () => {
  assert.deepEqual(
    analyzeCodeOutputs(
      'if (ok) return ({ foo, "quoted key": await run(), 7: {{input}}, foo: 2 }); return { bar: { nested: 1 } };',
    ),
    { valid: true, keys: ['foo', 'quoted key', '7', 'bar'] },
  );
  assert.deepEqual(
    analyzeCodeOutputs(
      'function helper() { return { hidden: 1 }; } const f = () => { return { hidden2: 1 }; }; class C { x() { return { hidden3: 1 }; } } return { ...value, [key]: 1, method() {}, get getter() { return 1; }, shown: 2 };',
    ),
    { valid: true, keys: ['shown'] },
  );
});

test('indirect returns and ASI do not invent fields; invalid syntax is distinct', () => {
  for (const code of [
    'return result;',
    'return ok ? { foo: 1 } : { bar: 2 };',
    'return\n{ foo: 1 }',
    'return [1, 2];',
  ]) {
    assert.deepEqual(analyzeCodeOutputs(code), { valid: true, keys: [] });
  }
  assert.deepEqual(analyzeCodeOutputs('return {'), { valid: false });
});

test('walks containing-function control flow in source order', () => {
  assert.deepEqual(
    analyzeCodeOutputs(`
    for (const item of items) { if (item) return { loop: item }; }
    switch (choice) { case 1: return { selected: 1 }; }
    try { return { success: true }; } catch { return { failure: true }; }
    finally { if (override) return { final: true }; }
  `),
    { valid: true, keys: ['loop', 'selected', 'success', 'failure', 'final'] },
  );
});

test('retained keys survive invalid edits and serialized reload but valid code wins', () => {
  const previous = { code: 'return { foo: 1 };' };
  const invalid = prepareCodeOutputEdit(previous, { code: 'return {' });
  assert.deepEqual(getCodeOutputKeys(JSON.parse(JSON.stringify(invalid))), ['foo']);
  assert.deepEqual(getCodeOutputKeys({ code: 'return 3;', inferredOutputKeys: ['stale'] }), []);
  assert.deepEqual(getCodeOutputKeys({ code: 'return {' }), []);
  assert.deepEqual(prepareCodeOutputEdit(invalid, { code: 'return { bar: 2 };' }).inferredOutputKeys, ['bar']);
  const result = analyzeCodeOutputs(previous.code);
  assert.equal(Object.isFrozen(result), true);
  if (result.valid) assert.equal(Object.isFrozen(result.keys), true);
});

test('proven property-key renames retain the existing port identity through incomplete code', () => {
  const original = { code: 'return { foo: 1, bar: {{value}} };' };
  const renamed = prepareCodeOutputEdit(original, { code: 'return { foo1: 1, bar: {{value}} };' });
  assert.deepEqual(getCodeOutputFields(renamed), [
    { id: 'field:foo', key: 'foo1' },
    { id: 'field:bar', key: 'bar' },
  ]);

  const incomplete = prepareCodeOutputEdit(original, { code: 'return { foo' });
  const completed = prepareCodeOutputEdit(incomplete, { code: 'return { foo1: 1, bar: {{value}} };' });
  assert.deepEqual(getCodeOutputFields(completed), getCodeOutputFields(renamed));
  assert.equal('inferredOutputLastValidCode' in completed, false);
});

test('output identities follow exact keys through reordering and do not guess across ambiguous edits', () => {
  const original = prepareCodeOutputEdit(
    { code: 'return { foo: 1, bar: 2 };' },
    { code: 'return { foo: 1, bar: 2 };' },
  );
  const reordered = prepareCodeOutputEdit(original, { code: 'return { bar: 2, foo: 1 };' });
  assert.deepEqual(
    getCodeOutputFields(reordered).map(({ key, id }) => [key, id]),
    [
      ['bar', original.inferredOutputFields![1]!.id],
      ['foo', original.inferredOutputFields![0]!.id],
    ],
  );

  const ambiguous = prepareCodeOutputEdit(original, { code: 'return { bar: 2, baz: 3 };' });
  assert.equal(
    getCodeOutputFields(ambiguous).find((field) => field.key === 'bar')?.id,
    original.inferredOutputFields![1]!.id,
  );
  assert.notEqual(
    getCodeOutputFields(ambiguous).find((field) => field.key === 'baz')?.id,
    original.inferredOutputFields![0]!.id,
  );
});

test('repeated branch fields and broad edits do not claim a rename', () => {
  const original = { code: 'if (left) return { foo: 1 }; return { foo: 2 };' };
  const renamed = prepareCodeOutputEdit(original, { code: 'if (left) return { foo1: 1 }; return { foo1: 2 };' });
  assert.notEqual(getCodeOutputFields(renamed)[0]?.id, 'field:foo');
});

test('ignores malformed persisted output IDs instead of allowing prototype-like output maps', () => {
  assert.deepEqual(
    getCodeOutputFields({
      code: 'return { foo: 1 };',
      inferredOutputFields: [{ id: '__proto__', key: 'foo' }],
    }),
    [{ id: 'field:foo', key: 'foo' }],
  );
  assert.deepEqual(
    getCodeOutputFields({
      code: 'return {',
      inferredOutputFields: [{ id: '__proto__', key: 'foo' }],
      inferredOutputKeys: ['foo'],
    }),
    [{ id: 'field:foo', key: 'foo' }],
  );
});

test('partial data patches retain source and recompute metadata from the complete node data', () => {
  assert.deepEqual(
    prepareCodeOutputEdit(
      { code: 'return { foo: 1 };', inferredOutputKeys: ['old'] },
      {
        inferredOutputFields: [{ id: 'field:untrusted', key: 'untrusted' }],
        inferredOutputKeys: ['untrusted patch value'],
        inferredOutputRetiredFields: [{ id: 'field:retired', key: 'retired' }],
        inferredOutputLastValidCode: 'return { untrusted: 1 };',
      },
    ),
    {
      code: 'return { foo: 1 };',
      inferredOutputFields: [{ id: 'field:foo', key: 'foo' }],
      inferredOutputKeys: ['foo'],
    },
  );

  assert.deepEqual(
    prepareCodeOutputEdit({ code: 'return {' }, { inferredOutputLastValidCode: 'return { untrusted: 1 };' }),
    {
      code: 'return {',
      inferredOutputFields: [],
      inferredOutputKeys: [],
    },
  );
});
