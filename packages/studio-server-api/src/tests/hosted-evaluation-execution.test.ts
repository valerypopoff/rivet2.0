import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { getEventListeners } from 'node:events';

import { NodeProjectReferenceLoader, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-node';
import { EvaluationGraphExecutionError, type EvaluationRecordingArtifact } from '@valerypopoff/rivet2-evaluations';

import {
  accountingGraph,
  accountingProviderResponse,
  accountingToolGraph,
} from '../../../evaluations/test/fixtures/accountingGraph.js';

import { createHostedEvaluationGraphRunner } from '../evaluation-runs/hosted-execution.js';

test('hosted evaluation execution captures full provider evidence and persists it on success and failure', async (t) => {
  let failRequest = false;
  let requestCount = 0;
  const provider = createServer((request, response) => {
    request.resume();
    const reply = accountingProviderResponse(requestCount++, failRequest);
    response.writeHead(reply.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  const recordings: EvaluationRecordingArtifact[] = [];
  const runner = createHostedEvaluationGraphRunner({
    createProjectReferenceLoader: async () => new NodeProjectReferenceLoader(),
    evaluationStore: {
      putRecording: async (recording: EvaluationRecordingArtifact) => {
        recordings.push(recording);
      },
    },
    // Profile tracing works without opting into the optional shared health store.
    llmProfileHealthStore: undefined,
  } as unknown as Parameters<typeof createHostedEvaluationGraphRunner>[0]);
  const graphId = 'hosted-evaluation-graph' as GraphId;
  const project: Project = {
    metadata: {
      id: 'hosted-evaluation-project' as ProjectId,
      title: 'Accounting',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        ...accountingGraph(`http://127.0.0.1:${address.port}/v1`),
        metadata: { id: graphId, name: 'Accounting', description: '' },
      },
      ['accounting-tool' as GraphId]: accountingToolGraph,
    },
    plugins: [],
  };
  const abortController = new AbortController();
  const execution = {
    signal: abortController.signal,
    contextValues: {},
    graphId,
    inputs: { apiKey: 'fixture-key' },
    metadata: {
      caseId: 'case',
      evaluationRunId: 'run',
      phase: 'target' as const,
      suiteId: 'suite',
      trialIndex: 0,
    },
    project,
    projectPath: '/workflows/Hosted evaluation.rivet-project',
  };

  const completed = await runner(execution);
  assert.equal(completed.outputs.response, 'evaluation response');
  assert.equal(completed.metrics.modelCallCount, 2);
  assert.equal(completed.metrics.inputTokens, 6);
  assert.equal(completed.metrics.outputTokens, 4);
  assert.equal(completed.metrics.hasUnknownCost, true);
  assert.ok(Array.isArray(completed.providerAttempts));
  assert.equal(completed.metrics.toolCallCount, 1);
  assert.equal(completed.metrics.toolFailureCount, 0);
  assert.ok(
    completed.providerAttempts.some((attempt) => (attempt as Record<string, unknown>).kind === 'profile-decision'),
  );
  const successAttempt = completed.providerAttempts
    .filter((attempt) => (attempt as Record<string, unknown>).kind === 'provider-call')
    .at(-1) as Record<string, unknown> | undefined;
  assert.ok(successAttempt);
  assert.equal(successAttempt.provider, 'custom');
  assert.equal(successAttempt.finishReason, 'stop');
  assert.equal(successAttempt.profileName, 'Accounting profile');
  assert.equal(recordings.length, 1);
  assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
  assert.equal(recordings[0]?.projectId, project.metadata.id);

  failRequest = true;
  await assert.rejects(
    () => runner(execution),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationGraphExecutionError);
      assert.ok(error.metrics);
      assert.equal(error.metrics.modelCallCount, 2);
      assert.ok(Array.isArray(error.providerAttempts));
      assert.equal(error.metrics.toolCallCount, 1);
      assert.equal(error.metrics.toolFailureCount, 0);
      assert.equal(error.metrics.inputTokens, 3);
      const failedAttempt = error.providerAttempts
        .filter((attempt) => (attempt as Record<string, unknown>).kind === 'provider-call')
        .at(-1) as Record<string, unknown> | undefined;
      assert.ok(failedAttempt);
      assert.equal(failedAttempt.outcome, 'provider-failure');
      assert.equal(failedAttempt.finishReason, null);
      assert.equal(failedAttempt.profileName, 'Accounting profile');
      return true;
    },
  );
  assert.equal(recordings.length, 2);
  assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
  abortController.abort();
  await assert.rejects(() => runner(execution), { name: 'AbortError' });
  assert.equal(requestCount, 4);
  assert.equal(recordings.length, 2);
});
