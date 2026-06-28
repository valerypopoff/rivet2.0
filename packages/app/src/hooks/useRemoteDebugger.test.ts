import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('useRemoteDebugger persists active project executor mode when connecting and disconnecting', async () => {
  const source = await readFile(new URL('./useRemoteDebugger.ts', import.meta.url), 'utf8');

  assert.match(source, /updateOpenedProjectExecutorMode/);
  assert.match(source, /setCurrentProjectExecutorMode\(remoteMode\);[\s\S]*runtime\.connectExternalDebugger\(remoteMode\.url\)/);
  assert.match(
    source,
    /runtime\.connectExternalDebugger\(remoteMode\.url\)\.catch\(\(error\) => \{[\s\S]*setCurrentProjectExecutorMode\(createLocalProjectExecutorMode\(selectedExecutor\)\);/,
  );
  assert.match(
    source,
    /runtime\.disconnect\(\);[\s\S]*setCurrentProjectExecutorMode\(createLocalProjectExecutorMode\(selectedExecutor\)\);/,
  );
});
