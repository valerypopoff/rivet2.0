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
  assert.match(source, /editorExecutionCache: useEditorCache \? getEditorExecutionCache\(client, project\) : undefined/);
});
