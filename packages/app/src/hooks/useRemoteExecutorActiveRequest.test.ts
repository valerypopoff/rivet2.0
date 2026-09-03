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

test('useRemoteExecutor keeps one message subscription across execution-state rerenders', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  assert.match(source, /const handleExecutorMessage(?:: RemoteExecutorMessageHandler)? = useStableCallback\(/);
  assert.match(source, /executorSession\.subscribeMessages\(handleExecutorMessage\)/);
  assert.match(source, /\[executorSession, handleExecutorMessage\]/);
  assert.doesNotMatch(source, /executorSession\.subscribeMessages\(\(message, data, requestId\) =>/);
  assert.doesNotMatch(source, /\[eventDispatcher, executorSession,/);
});

test('useRemoteExecutor captures suspension-causing hosted Node runs before sending them', async () => {
  const source = await readFile(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8');

  assert.match(source, /useLocalExecutionRecordingPersistence\(\)/);
  assert.match(source, /sessionState\.target\?\.type === 'internal-hosted'/);
  assert.match(source, /localExecutionRecordingPersistence\.getCapability\(\)\.catch\(\(\) => false\)/);
  assert.match(source, /llmProfileHealthExecutionCorrelationId: remoteLocalRecordingCorrelationId/);
  assert.match(
    source,
    /executorSession\.recordSocketEvents\(\(socket\) =>[\s\S]*?capture\.recorder\.recordSocket\(socket, \{/,
  );
  assert.match(source, /onRequestCreated: startRemoteLocalExecutionRecording/);
  assert.match(
    source,
    /event\.stage === 'health-update' && event\.outcome === 'success' && event\.healthOutcome === 'unhealthy'/,
  );
  assert.match(source, /capture\.provider\.persist\(\{[\s\S]*?projectContents: serializeProject\(capture\.project\)/);
  assert.match(source, /capture\.provider\.markUnavailable\(capture\.correlationId\)/);
  assert.match(source, /Remote LLM-profile replay could not report a failed local recording/);

  const messageHandler = source.match(
    /const handleExecutorMessage[\s\S]*?captureRemoteLocalExecutionTerminal\([\s\S]*?if \(store\.get\(projectState\)\.metadata\.id !== project\.metadata\.id\)/,
  )?.[0];
  assert.ok(messageHandler, 'the recording must see a terminal event even if the active editor tab changed');
});
