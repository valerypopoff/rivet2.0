import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGraphExecutionEvent } from './graphExecutionEventDispatch.js';

test('dispatchGraphExecutionEvent calls the handler and reports success', () => {
  let handledValue: string | undefined;

  const dispatched = dispatchGraphExecutionEvent('nodeFinish', () => {
    handledValue = 'value';
  });

  assert.equal(dispatched, true);
  assert.equal(handledValue, 'value');
});

test('dispatchGraphExecutionEvent catches UI event projection failures', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const dispatched = dispatchGraphExecutionEvent('nodeFinish', () => {
      throw new Error('projection failed');
    });

    assert.equal(dispatched, false);
  } finally {
    console.error = originalConsoleError;
  }
});
