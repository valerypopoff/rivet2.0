import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphOutputs, RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import { createExecutorSessionPendingExecutions } from './executorSessionPendingExecutions.js';

const outputs = (value: string): GraphOutputs => ({
  output: { type: 'string', value },
});

test('pending executor requests create stable incremental request ids', () => {
  const pending = createExecutorSessionPendingExecutions();

  assert.equal(pending.createRemoteExecutionRequest(), 'remote-run-1');
  assert.equal(pending.createRemoteExecutionRequest(), 'remote-run-2');
});

test('pending executor requests track overlapping completions by request id', async () => {
  const pending = createExecutorSessionPendingExecutions();
  const first = pending.createPendingGraphExecution('request-1' as RemoteRunRequestId);
  const second = pending.createPendingGraphExecution('request-2' as RemoteRunRequestId);

  pending.resolvePendingGraphExecution('request-2' as RemoteRunRequestId, outputs('second'));
  pending.resolvePendingGraphExecution('request-1' as RemoteRunRequestId, outputs('first'));

  assert.deepEqual(await first.promise, outputs('first'));
  assert.deepEqual(await second.promise, outputs('second'));
});

test('pending executor requests route progress to the matching overlapping request', () => {
  const pending = createExecutorSessionPendingExecutions();
  const firstProgress: unknown[] = [];
  const secondProgress: unknown[] = [];
  pending.createPendingGraphExecution('request-1' as RemoteRunRequestId, (progress) => firstProgress.push(progress));
  pending.createPendingGraphExecution('request-2' as RemoteRunRequestId, (progress) => secondProgress.push(progress));

  pending.reportPendingGraphProgress('request-2' as RemoteRunRequestId, { message: 'Second', percent: 50 });
  pending.reportPendingGraphProgress('request-1' as RemoteRunRequestId, { message: 'First' });

  assert.deepEqual(firstProgress, [{ message: 'First' }]);
  assert.deepEqual(secondProgress, [{ message: 'Second', percent: 50 }]);
});

test('pending executor requests reject an older request with the same id before replacing it', async () => {
  const pending = createExecutorSessionPendingExecutions();
  const first = pending.createPendingGraphExecution('request-1' as RemoteRunRequestId);
  const replacement = pending.createPendingGraphExecution('request-1' as RemoteRunRequestId);

  pending.resolvePendingGraphExecution('request-1' as RemoteRunRequestId, outputs('replacement'));

  await assert.rejects(first.promise, /newer request/);
  assert.deepEqual(await replacement.promise, outputs('replacement'));
});

test('pending executor requests resolve legacy unscoped completion only when one request is active', async () => {
  const pending = createExecutorSessionPendingExecutions();
  const first = pending.createPendingGraphExecution('request-1' as RemoteRunRequestId);
  const second = pending.createPendingGraphExecution('request-2' as RemoteRunRequestId);

  pending.resolvePendingGraphExecution(undefined, outputs('ignored'));
  pending.resolvePendingGraphExecution('request-2' as RemoteRunRequestId, outputs('second'));
  pending.resolvePendingGraphExecution(undefined, outputs('first'));

  assert.deepEqual(await first.promise, outputs('first'));
  assert.deepEqual(await second.promise, outputs('second'));
});
