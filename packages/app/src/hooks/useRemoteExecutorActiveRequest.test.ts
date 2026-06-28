import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('useRemoteExecutor restores runtime-owned active request id after project tab switches', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /activeGraphRequestIdRef\.current = executorSession\.getActiveGraphRunRequestId\(\);/,
  );
  assert.match(
    source,
    /activeRequestId: activeGraphRequestIdRef\.current \?\? executorSession\.getActiveGraphRunRequestId\(\),/,
  );
  assert.match(source, /store\.get\(projectState\)\.metadata\.id !== project\.metadata\.id/);
  assert.match(source, /currentExecution\.onStop\(\);/);
  assert.match(
    source,
    /remoteDebugger\.send\(\s*'user-input',\s*requestId \? \{ nodeId, answers, requestId \} : \{ nodeId, answers \},\s*\)/,
  );
  assert.match(source, /remoteDebugger\.send\('abort', requestId \? \{ requestId \} : undefined\)/);
  assert.match(source, /remoteDebugger\.send\('pause', requestId \? \{ requestId \} : undefined\)/);
  assert.match(source, /remoteDebugger\.send\('resume', requestId \? \{ requestId \} : undefined\)/);
});
