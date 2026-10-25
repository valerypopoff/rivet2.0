import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataValue } from '@valerypopoff/rivet2-core';
import { getProjectContextValues } from './projectContextValues';

test('getProjectContextValues unwraps stored project context values', () => {
  const storedStringValue: DataValue = { type: 'string', value: 'token' };
  const storedObjectValue: DataValue = { type: 'object', value: { nested: { label: 'value' } } };
  const contextValues = getProjectContextValues({
    string: { value: storedStringValue },
    object: { value: storedObjectValue },
    visible: { value: { type: 'number', value: 3 } },
  });

  assert.deepEqual(contextValues, {
    string: { type: 'string', value: 'token' },
    object: { type: 'object', value: { nested: { label: 'value' } } },
    visible: { type: 'number', value: 3 },
  });
  assert.notEqual(contextValues.string, storedStringValue);

  const unwrappedObjectValue = contextValues.object as Extract<DataValue, { type: 'object' }>;
  const sourceObjectValue = storedObjectValue as Extract<DataValue, { type: 'object' }>;

  assert.notEqual(unwrappedObjectValue, sourceObjectValue);
  assert.notEqual(unwrappedObjectValue.value.nested, sourceObjectValue.value.nested);

  for (const id of ['__proto__', 'constructor', 'toString']) {
    const values = getProjectContextValues(Object.fromEntries([[id, { value: storedObjectValue }]]));
    assert.equal(Object.hasOwn(values, id), true, `Context ${id} must remain an own entry`);
    assert.equal(Object.getPrototypeOf(values), Object.prototype);
    assert.deepEqual(
      JSON.parse(JSON.stringify(values))[id],
      storedObjectValue,
      'Node transport and recordings must retain the value',
    );
    assert.notEqual(values[id], storedObjectValue);
  }
});
