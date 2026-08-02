import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('useRemoteExecutor restores runtime-owned active request id after project tab switches', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  assert.match(source, /activeGraphRequestIdRef\.current = executorSession\.getActiveGraphRunRequestId\(\);/);
  assert.match(
    source,
    /activeRequestId: activeGraphRequestIdRef\.current \?\? executorSession\.getActiveGraphRunRequestId\(\),/,
  );
  assert.match(source, /store\.get\(projectState\)\.metadata\.id !== project\.metadata\.id/);
  assert.match(source, /store\.get\(graphRunningState\)[\s\S]*?currentExecution\.onRunActivityEvent\('error'/);
  assert.match(source, /currentExecution\.onStop\(\);/);
  assert.match(
    source,
    /remoteDebugger\.send\(\s*'user-input',\s*requestId \? \{ nodeId, answers, requestId \} : \{ nodeId, answers \},\s*\)/,
  );
  assert.match(source, /remoteDebugger\.send\('abort', requestId \? \{ requestId \} : undefined\)/);
  assert.match(source, /remoteDebugger\.send\('pause', requestId \? \{ requestId \} : undefined\)/);
  assert.match(source, /remoteDebugger\.send\('resume', requestId \? \{ requestId \} : undefined\)/);
});

test('useRemoteExecutor closes response-bound storage patches at the early output boundary', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /case 'graphOutputsReady':[\s\S]*?earlyResultRequestIdsRef\.current\.add\(requestId\);[\s\S]*?webAppStoragePatchCallbacksByRequestIdRef\.current\.delete\(requestId\);[\s\S]*?resolvePendingGraphExecution/,
  );
});

test('useRemoteExecutor releases delivered response traces on abort and error terminals', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  for (const terminal of ['abort', 'error']) {
    const terminalCase = source.match(new RegExp(`case '${terminal}':([\\s\\S]*?)break;`))?.[1];
    assert.ok(terminalCase, `missing ${terminal} event handler`);
    assert.match(terminalCase, /emitRemoteResponseTrace\(responseTraceByRequestIdRef\.current,/);
    assert.match(terminalCase, /responseTraceByRequestIdRef\.current\.delete\(requestId\);/);
  }
});
