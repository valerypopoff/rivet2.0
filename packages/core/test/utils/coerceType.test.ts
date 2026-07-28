import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ChatMessage,
  type DataType,
  type DataValue,
  dataTypes,
  functionTypeToReturnType,
  functionTypeToScalarType,
  getDefaultValue,
  getScalarTypeOf,
  isArrayDataType,
  isNotFunctionDataValue,
  scalarTypes,
  unwrapDataValue,
} from '../../src/model/DataValue.js';
import {
  canBeCoerced,
  canBeCoercedAny,
  coerceType,
  coerceTypeOptional,
  inferType,
} from '../../src/utils/coerceType.js';
import { expectType, expectTypeOptional } from '../../src/utils/expectType.js';

function legacyCanBeCoerced(from: DataType, to: DataType): boolean {
  if (to === 'any' || from === 'any') {
    return true;
  }

  if (isArrayDataType(to) && isArrayDataType(from)) {
    return legacyCanBeCoerced(getScalarTypeOf(from), getScalarTypeOf(to));
  }

  if (isArrayDataType(to) && !isArrayDataType(from)) {
    return legacyCanBeCoerced(from, getScalarTypeOf(to));
  }

  if (isArrayDataType(from) && !isArrayDataType(to)) {
    return to === 'string' || to === 'object';
  }

  if (to === 'gpt-function') {
    return from === 'object';
  }

  if (
    to === 'audio' ||
    to === 'binary' ||
    to === 'image' ||
    to === 'knowledge-source' ||
    to === 'knowledge-document' ||
    to === 'knowledge-evidence' ||
    to === 'llm-config'
  ) {
    return from === to || from === 'object';
  }

  if (
    from === 'knowledge-source' ||
    from === 'knowledge-document' ||
    from === 'knowledge-evidence' ||
    from === 'llm-config'
  ) {
    return to === 'object' || to === 'string';
  }

  return true;
}

describe('data coercion compatibility policy', () => {
  it('preserves the complete DataType compatibility matrix', () => {
    let matrix = '';
    let incompatiblePairs = 0;

    for (const from of dataTypes) {
      for (const to of dataTypes) {
        const actual = canBeCoerced(from, to);
        const expected = legacyCanBeCoerced(from, to);
        assert.equal(actual, expected, `${from} -> ${to}`);
        matrix += actual ? '1' : '0';
        if (!actual) incompatiblePairs += 1;
      }
    }

    assert.equal(dataTypes.length, 84);
    assert.equal(incompatiblePairs, 2_655);
    assert.equal(
      createHash('sha256').update(matrix).digest('hex'),
      '17e085ba5f5300f0cb9d6fc1156aab63508d49b3dfe475931e3e85107f310b01',
    );
  });

  it('checks alternatives without changing pair compatibility', () => {
    assert.equal(canBeCoercedAny(['knowledge-source', 'knowledge-document'], ['number', 'binary']), false);
    assert.equal(canBeCoercedAny(['knowledge-source', 'knowledge-document'], ['number', 'object']), true);
  });
});

describe('data coercion runtime behavior', () => {
  it('resolves every composite data type to an actual scalar type', () => {
    const scalarTypeSet = new Set(scalarTypes);

    for (const dataType of dataTypes) {
      assert.ok(scalarTypeSet.has(getScalarTypeOf(dataType)), dataType);
    }

    assert.equal(functionTypeToScalarType('fn<string[]>'), 'string');
    assert.equal(functionTypeToReturnType('fn<string[]>'), 'string[]');
  });

  it('preserves nullish, empty, false, zero, and parseFloat behavior', () => {
    assert.equal(coerceTypeOptional(undefined, 'string'), '');
    assert.equal(coerceTypeOptional(undefined, 'boolean'), false);
    assert.equal(coerceTypeOptional(undefined, 'number'), undefined);
    assert.equal(coerceTypeOptional({ type: 'any', value: null }, 'string'), undefined);
    assert.equal(coerceTypeOptional({ type: 'string', value: '' }, 'boolean'), false);
    assert.equal(coerceTypeOptional({ type: 'boolean', value: false }, 'number'), 0);
    assert.equal(coerceTypeOptional({ type: 'number', value: 0 }, 'boolean'), false);
    assert.equal(coerceTypeOptional({ type: 'string', value: '12.5px' }, 'number'), 12.5);
    assert.ok(Number.isNaN(coerceTypeOptional({ type: 'string', value: 'not-a-number' }, 'number')));
  });

  it('preserves scalar wrapping, array mapping order, undefined elements, and identity', () => {
    assert.deepEqual(coerceTypeOptional({ type: 'string', value: '3.5' }, 'number[]'), [3.5]);

    const graphReferences = coerceTypeOptional(
      {
        type: 'object[]',
        value: [{ graphName: 'first', graphId: 'graph-1' }, {}, { graphName: 'third', graphId: 'graph-3' }],
      },
      'graph-reference[]',
    );
    assert.deepEqual(graphReferences, [
      { graphName: 'first', graphId: 'graph-1' },
      undefined,
      { graphName: 'third', graphId: 'graph-3' },
    ]);

    const strings = ['first', 'second'];
    assert.equal(coerceTypeOptional({ type: 'string[]', value: strings }, 'string[]'), strings);
    assert.equal(coerceTypeOptional({ type: 'string[]', value: strings }, 'object'), strings);
    assert.equal(coerceTypeOptional({ type: 'string[]', value: strings }, 'string'), 'first\nsecond');
    assert.throws(
      () => coerceTypeOptional({ type: 'date[]', value: ['2026-07-24'] }, 'time[]'),
      /Expected value of type time but got date/,
    );
  });

  it('does not double-wrap arrays carried by any or object values', () => {
    const anyArray = ['first', 'second'];
    const objectArray = [{ id: 1 }, { id: 2 }];
    const objectValue = { type: 'object', value: objectArray } as unknown as DataValue;

    assert.equal(coerceTypeOptional({ type: 'any', value: anyArray }, 'any[]'), anyArray);
    assert.equal(coerceTypeOptional(objectValue, 'object[]'), objectArray);
    assert.equal(expectType(objectValue, 'object[]'), objectArray);
    assert.equal(expectTypeOptional(objectValue, 'object[]'), objectArray);
  });

  it('preserves any inference and first-element array inference', () => {
    const object = { answer: 42 };
    assert.equal(coerceTypeOptional({ type: 'any', value: object }, 'object'), object);
    assert.equal(coerceTypeOptional({ type: 'any', value: object }, 'string'), '{"answer":42}');

    const mixed = [1, 'two', false];
    const inferred = inferType(mixed);
    assert.equal(inferred.type, 'number[]');
    assert.equal(inferred.value, mixed);
    assert.deepEqual(inferType([]), { type: 'any[]', value: [] });
  });

  it('unwraps function values once before applying the target coercer', () => {
    let calls = 0;
    const value: DataValue = {
      type: 'fn<number>',
      value: () => {
        calls += 1;
        return 42;
      },
    };

    assert.equal(coerceTypeOptional(value, 'string'), '42');
    assert.equal(calls, 1);
    assert.equal(coerceTypeOptional(value, 'fn<number>'), value.value);
    assert.equal(calls, 1);
  });

  it('wraps concrete values for matching deferred targets without nesting existing functions', () => {
    const value: DataValue = { type: 'string', value: 'deferred value' };
    assert.equal(expectType(value, 'fn<string>')(), 'deferred value');
    assert.equal(expectTypeOptional(value, 'fn<string>')?.(), 'deferred value');
    assert.equal(coerceTypeOptional(value, 'fn<string>')?.(), 'deferred value');

    const existingFunction = () => 'existing value';
    const existingFunctionValue: DataValue = { type: 'fn<string>', value: existingFunction };
    assert.equal(expectType(existingFunctionValue, 'fn<string>'), existingFunction);
    assert.equal(expectTypeOptional(existingFunctionValue, 'fn<string>'), existingFunction);
    assert.equal(expectType(existingFunctionValue, 'fn<any>'), existingFunction);
    assert.equal(expectTypeOptional(existingFunctionValue, 'fn<any>'), existingFunction);
    assert.equal(coerceTypeOptional(existingFunctionValue, 'fn<any>'), existingFunction);

    const runtimeFunction = () => 'runtime value';
    const runtimeFunctionValue: DataValue = { type: 'any', value: runtimeFunction };
    assert.equal(expectType(runtimeFunctionValue, 'fn<string>'), runtimeFunction);
    assert.equal(expectTypeOptional(runtimeFunctionValue, 'fn<string>'), runtimeFunction);
    assert.equal(coerceTypeOptional(runtimeFunctionValue, 'fn<string>'), runtimeFunction);

    const runtimeConcreteValue: DataValue = { type: 'any', value: 'runtime concrete value' };
    assert.equal(expectType(runtimeConcreteValue, 'fn<string>')(), 'runtime concrete value');
    assert.equal(expectTypeOptional(runtimeConcreteValue, 'fn<string>')?.(), 'runtime concrete value');
    assert.equal(coerceTypeOptional(runtimeConcreteValue, 'fn<string>')?.(), 'runtime concrete value');

    assert.throws(
      () => expectType({ type: 'fn<number>', value: () => 42 }, 'fn<string>'),
      /Expected value of type fn<string> but got fn<number>/,
    );
    assert.throws(() => expectType(undefined, 'fn<any>'), /Expected value of type fn<any> but got undefined/);
  });

  it('keeps any function results inside a valid any DataValue', () => {
    let calls = 0;
    const value: DataValue = {
      type: 'any',
      value: () => {
        calls += 1;
        return 'plain text';
      },
    };

    assert.deepEqual(unwrapDataValue(value), { type: 'any', value: 'plain text' });
    assert.equal(calls, 1);
    assert.equal(coerceTypeOptional(value, 'string'), 'plain text');
    assert.equal(calls, 2);
    assert.equal(coerceTypeOptional({ type: 'any', value: () => 42 }, 'number'), 42);
  });

  it('returns type-correct defaults from scalar and array function values', () => {
    assert.equal(getDefaultValue('fn<string>')(), '');
    const getStringArrayDefault = getDefaultValue('fn<string[]>');
    const firstStringArrayDefault = getStringArrayDefault();
    const secondStringArrayDefault = getStringArrayDefault();
    assert.deepEqual(firstStringArrayDefault, []);
    assert.deepEqual(secondStringArrayDefault, []);
    assert.notEqual(firstStringArrayDefault, secondStringArrayDefault);
    assert.deepEqual(getDefaultValue('fn<object[]>')(), []);
  });

  it('returns isolated reference-valued defaults', () => {
    const firstObject = getDefaultValue('object');
    firstObject.leaked = true;
    assert.deepEqual(getDefaultValue('object'), {});

    const firstVector = getDefaultValue('vector');
    firstVector.push(42);
    assert.deepEqual(getDefaultValue('vector'), []);

    const firstBinary = getDefaultValue('binary');
    const secondBinary = getDefaultValue('binary');
    assert.notEqual(firstBinary, secondBinary);

    const getObjectDefault = getDefaultValue('fn<object>');
    const firstDeferredObject = getObjectDefault();
    firstDeferredObject.leaked = true;
    assert.deepEqual(getObjectDefault(), {});
  });

  it('does not classify missing values as non-function data values', () => {
    assert.equal(isNotFunctionDataValue(undefined), false);
    assert.equal(isNotFunctionDataValue({ type: 'string', value: 'value' }), true);
    assert.equal(isNotFunctionDataValue({ type: 'fn<string>', value: () => 'value' }), false);
  });

  it('preserves object, graph-reference, binary, and media identities', () => {
    const object = { key: 'value' };
    assert.equal(coerceTypeOptional({ type: 'object', value: object }, 'object'), object);

    const graphReference = { graphName: 'Main', graphId: 'graph-id' };
    assert.equal(
      coerceTypeOptional({ type: 'graph-reference', value: graphReference } as DataValue, 'graph-reference'),
      graphReference,
    );
    assert.equal(coerceTypeOptional({ type: 'object', value: graphReference }, 'graph-reference'), graphReference);

    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(coerceTypeOptional({ type: 'binary', value: bytes }, 'binary'), bytes);
    assert.equal(
      coerceTypeOptional({ type: 'image', value: { mediaType: 'image/png', data: bytes } }, 'binary'),
      bytes,
    );
    assert.throws(
      () => coerceTypeOptional({ type: 'object', value: { mediaType: 'image/png', data: bytes } }, 'image'),
      /Expected value of type image but got object/,
    );
  });

  it('normalizes validated object values and returns undefined for malformed values', () => {
    assert.deepEqual(
      coerceTypeOptional(
        { type: 'object', value: { connectionId: ' primary ', sourceId: ' book ', version: ' v1 ' } },
        'knowledge-source',
      ),
      { connectionId: 'primary', sourceId: 'book', version: 'v1' },
    );
    assert.deepEqual(
      coerceTypeOptional(
        { type: 'object', value: { id: ' chapter-1 ', text: ' Chapter text ', title: ' Chapter 1 ' } },
        'knowledge-document',
      ),
      { id: 'chapter-1', text: 'Chapter text', title: 'Chapter 1' },
    );
    assert.deepEqual(
      coerceTypeOptional(
        {
          type: 'object',
          value: {
            id: 'evidence-1',
            text: 'Relevant text',
            source: { connectionId: 'primary', sourceId: 'book' },
            documentId: 'chapter-1',
          },
        },
        'knowledge-evidence',
      ),
      {
        id: 'evidence-1',
        text: 'Relevant text',
        source: { connectionId: 'primary', sourceId: 'book' },
        documentId: 'chapter-1',
      },
    );
    assert.equal(
      coerceTypeOptional({ type: 'object', value: { sourceId: 'missing-connection' } }, 'knowledge-source'),
      undefined,
    );

    const profile = getDefaultValue('llm-config');
    profile.configuration.model = '  model-from-profile  ';
    const normalizedProfile = coerceTypeOptional({ type: 'object', value: profile }, 'llm-config');
    assert.equal(normalizedProfile?.configuration.model, 'model-from-profile');
    assert.equal(coerceTypeOptional({ type: 'object', value: { version: 999 } }, 'llm-config'), undefined);
  });

  it('preserves in-place assistant function-call argument normalization', () => {
    const functionCall = {
      id: 'call-1',
      name: 'lookup',
      arguments: { chapter: 7 },
    } as { id: string; name: string; arguments: unknown };
    const message = {
      type: 'assistant',
      message: 'Looking that up.',
      function_call: functionCall,
      function_calls: undefined,
    } as unknown as ChatMessage;

    const result = coerceTypeOptional({ type: 'chat-message', value: message }, 'chat-message');
    assert.equal(result, message);
    assert.equal(functionCall.arguments, '{"chapter":7}');
  });

  it('preserves exact-type failures and required coercion errors', () => {
    assert.throws(
      () => coerceTypeOptional({ type: 'date', value: '2026-07-24' }, 'time'),
      /Expected value of type time but got date/,
    );
    assert.throws(() => coerceType(undefined, 'number'), /Expected value of type number but got undefined/);
  });
});
