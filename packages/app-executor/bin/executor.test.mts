import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('app executor scopes editor execution caches by websocket client and project id', async () => {
  const source = await readFile(new URL('./executor.mts', import.meta.url), 'utf8');

  assert.match(
    source,
    /const editorExecutionCachesByClient = new WeakMap<AppExecutorClient, Map<string, Map<string, unknown>>>\(\);/,
  );
  assert.match(source, /function getEditorExecutionCache\(client: AppExecutorClient, project: Rivet\.Project\)/);
  assert.match(source, /editorExecutionCachesByClient\.get\(client\)/);
  assert.match(
    source,
    /editorExecutionCache: useEditorCache \? getEditorExecutionCache\(client, project\) : undefined/,
  );
});

void test('app executor carries Stored Value snapshots and patches across remote editor runs', async () => {
  const source = await readFile(new URL('./executor.mts', import.meta.url), 'utf8');

  assert.match(source, /Rivet\.createRivetStoredValueSnapshotStore\(initialWebAppStorage\)/);
  assert.match(source, /storedValueStore: webAppStorage\?\.store/);
  assert.match(source, /webAppStorage\.getPatch\(\)/);
  assert.match(source, /'webAppStoragePatch'/);
  assert.match(source, /onGraphOutputsReady: publishWebAppStoragePatch/);
  assert.match(source, /onGraphFinish: publishWebAppStoragePatch/);
  assert.match(source, /webAppStorageBoundaryPublished = true/);
  assert.doesNotMatch(source, /setWebAppStorage|getWebAppStorage/);
});

void test('app executor preserves Rivet-owned run options over host injections', async () => {
  const source = await readFile(new URL('./executor.mts', import.meta.url), 'utf8');
  const createProcessorCall = /const processor = createProcessor\(project, \{([\s\S]*?)\n      \}\);/.exec(source)?.[1];

  assert.ok(createProcessorCall);
  assert.ok(createProcessorCall.indexOf('...injectedProcessorOptions') < createProcessorCall.indexOf('graph: graphId'));
  assert.ok(
    createProcessorCall.indexOf('...injectedProcessorOptions') < createProcessorCall.indexOf('remoteDebugger:'),
  );
  assert.ok(
    createProcessorCall.indexOf('...injectedProcessorOptions') < createProcessorCall.indexOf('storedValueStore:'),
  );
});
