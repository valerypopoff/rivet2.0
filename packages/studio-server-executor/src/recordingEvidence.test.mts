import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { HostedExecutorRecordingEvidence } from './recordingEvidence.mjs';
import type { AppExecutorProcessorOptionsContext } from '../../app-executor/bin/executorHostState.mjs';

const context = {
  requestId: 'request-one',
  project: { metadata: { id: 'p' } },
  graphId: 'g',
  recordSubgraphProjectRuns: true,
  llmProfileHealthExecutionCorrelationId: 'rvt-durable-local-' + randomUUID(),
} as AppExecutorProcessorOptionsContext;
test('executor adopts and settles its actual request independently of browser connectivity', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [],
    handle = { id: randomUUID(), token: randomUUID() };
  const owner = new HostedExecutorRecordingEvidence(
    'http://fixture',
    () => ({}),
    async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ handle });
    },
  );
  await owner.prepare(context);
  await owner.prepare(context);
  assert.equal(calls.length, 1);
  assert.equal(owner.handle(context.llmProfileHealthExecutionCorrelationId)?.id, handle.id);
  await owner.settled({ requestId: context.requestId, state: 'succeeded', durationMs: 300 });
  assert.deepEqual(calls[1]?.body.outcome, { state: 'succeeded', durationMs: 300 });
  assert.equal(owner.handle(context.llmProfileHealthExecutionCorrelationId), undefined);
});
test('legacy or recording-disabled requests do not negotiate durable ownership', async () => {
  const owner = new HostedExecutorRecordingEvidence(
    'http://fixture',
    () => ({}),
    async () => {
      throw new Error('not called');
    },
  );
  await owner.prepare({ ...context, recordSubgraphProjectRuns: false });
  await owner.prepare({ ...context, llmProfileHealthExecutionCorrelationId: 'rvt-local-legacy' });
});
test('an unconfirmed adoption rejects before execution and leaves no heartbeat owner', async () => {
  const owner = new HostedExecutorRecordingEvidence(
    'http://fixture',
    () => ({}),
    async () => new Response('', { status: 503 }),
  );
  await assert.rejects(owner.prepare(context), /unavailable/);
  assert.equal(owner.handle(context.llmProfileHealthExecutionCorrelationId), undefined);
});
test('lost terminal acknowledgement is confirmed by readback without replaying a run or writing twice', async () => {
  const paths: string[] = [],
    handle = { id: randomUUID(), token: randomUUID() };
  const owner = new HostedExecutorRecordingEvidence(
    'http://fixture',
    () => ({}),
    async (url) => {
      const name = new URL(url).pathname.split('/').at(-1)!;
      paths.push(name);
      if (name === 'outcome') throw new Error('response lost');
      return Response.json(name === 'read' ? { state: 'failed' } : { handle });
    },
  );
  await owner.prepare(context);
  await owner.settled({ requestId: context.requestId, state: 'failed', durationMs: 300 });
  assert.deepEqual(paths, ['executor-owner', 'outcome', 'read']);
});
