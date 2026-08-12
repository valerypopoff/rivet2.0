import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('app executor exposes a host entrypoint without changing standalone startup', async () => {
  const [executorSource, hostSource, stateSource] = await Promise.all([
    readFile(new URL('./executor.mts', import.meta.url), 'utf8'),
    readFile(new URL('./executorHost.mts', import.meta.url), 'utf8'),
    readFile(new URL('./executorHostState.mts', import.meta.url), 'utf8'),
  ]);

  assert.match(hostSource, /export function startAppExecutor\(options: AppExecutorHostOptions = \{\}\)/);
  assert.match(hostSource, /startPromise = import\('\.\/executor\.mjs'\)/);
  assert.match(hostSource, /if \(hasAppExecutorModuleLoaded\(\)\)/);
  assert.match(executorSource, /markAppExecutorModuleLoaded\(\)/);
  assert.match(executorSource, /getAppExecutorHostOptions\(\)\.createProcessorOptions/);
  assert.match(
    executorSource,
    /const \{ executionEnvironment: hostExecutionEnvironment, \.\.\.hostProcessorOptions \} = injectedProcessorOptions;/,
  );
  assert.match(
    executorSource,
    /const \{ executionEnvironment: ignoredUploadedExecutionEnvironment, \.\.\.uploadedSettings \}/,
  );
  assert.match(
    executorSource,
    /\.\.\.hostProcessorOptions,[\s\S]*graph: graphId,[\s\S]*\.\.\.uploadedSettings,[\s\S]*executionEnvironment: hostExecutionEnvironment,/,
  );
  assert.match(executorSource, /isWebAppAction: initialWebAppStorage !== undefined/);
  assert.doesNotMatch(executorSource, /from '\.\/executorHost\.mjs'/);
  assert.match(stateSource, /export function configureAppExecutorHost/);
});
