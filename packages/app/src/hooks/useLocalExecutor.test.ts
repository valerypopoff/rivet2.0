import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const useLocalExecutorSource = readFileSync(new URL('./useLocalExecutor.ts', import.meta.url), 'utf8');
const remoteExecutorHelpersSource = readFileSync(new URL('./remoteExecutorHelpers.ts', import.meta.url), 'utf8');

test('local executor forces execution cleanup after the processor settles', () => {
  assert.match(
    useLocalExecutorSource,
    /finally\s*\{[\s\S]*if \(processor\) \{[\s\S]*dispatchGraphExecutionEvent\('stop', \(\) => currentExecution\.onStop\(\)\);[\s\S]*currentProcessor\.current = null;/,
  );
});

test('local executor isolates awaited processor event handlers from UI projection failures', () => {
  assert.match(
    useLocalExecutorSource,
    /dispatchGraphExecutionEvent\('nodeFinish', \(\) => currentExecution\.onNodeFinish\(data\)\)/,
  );
  assert.doesNotMatch(useLocalExecutorSource, /processor\.on\('nodeFinish', currentExecution\.onNodeFinish\)/);
});

test('remote executor dispatch also isolates UI projection failures', () => {
  assert.match(
    remoteExecutorHelpersSource,
    /dispatchGraphExecutionEvent\('nodeFinish', \(\) =>[\s\S]*currentExecution\.onNodeFinish\(data as ProcessEvents\['nodeFinish'\]\)/,
  );
  assert.doesNotMatch(remoteExecutorHelpersSource, /nodeFinish: \(data: unknown\) => currentExecution\.onNodeFinish/);
});
