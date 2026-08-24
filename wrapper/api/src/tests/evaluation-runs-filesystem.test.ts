import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectId } from '@valerypopoff/rivet2-node';
import type { EvaluationRun } from '@valerypopoff/rivet2-evaluations';

import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

const projectId = 'scoring-project' as ProjectId;
const {
  withWorkflowApiServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

function scoringRun(): EvaluationRun {
  return {
    version: 2,
    id: 'scored-run',
    projectId,
    suiteId: 'scoring-suite',
    suiteName: 'Scoring suite',
    startedAt: '2026-08-24T00:00:00.000Z',
    completedAt: '2026-08-24T00:00:01.000Z',
    purpose: 'evaluation',
    evaluationMode: 'scoring',
    executionStatus: 'completed',
    qualityStatus: 'scored',
    qualityReason: {
      code: 'scores-complete',
      message: 'Every requested trial produced a score.',
    },
    accountingStatus: 'complete',
    provenance: {
      projectFingerprint: 'project',
      suiteFingerprint: 'suite',
      datasetFingerprint: 'dataset',
      targetFingerprint: 'target',
      evaluatorFingerprints: { evaluator: 'evaluator' },
      executionMode: 'test',
      accountingComplete: true,
    },
    aggregate: {
      trialCount: 1,
      evaluatedTrialCount: 1,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
      passedTrialCount: 0,
      failedTrialCount: 0,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      passRate: 0,
      averageLatencyMs: 1,
      p95LatencyMs: 1,
      targetErrorRate: 0,
      evaluatorErrorRate: 0,
      toolFailureRate: 0,
      metrics: {},
    },
    thresholdResults: [],
    trials: [
      {
        id: 'scored-trial',
        caseId: 'case',
        caseName: 'Case',
        caseIndex: 0,
        trialIndex: 0,
        executionStatus: 'completed',
        qualityStatus: 'scored',
        qualityReason: {
          code: 'scores-complete',
          message: 'The evaluator graph returned a score.',
        },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [
          {
            id: 'evaluator',
            kind: 'graph',
            name: 'Evaluator',
            required: true,
            status: 'scored',
            score: 0.85,
          },
        ],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 1 },
        totalMetrics: { durationMs: 2 },
      },
    ],
    warnings: [],
  };
}

test('evaluation history API persists and renames completed scoring runs', async () => {
  const run = scoringRun();

  await withWorkflowApiServer(async (baseUrl) => {
    const runUrl = `${baseUrl}/evaluation-runs/${run.id}`;
    const writeResponse = await fetch(runUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, run }),
    });
    assert.equal(writeResponse.status, 204);

    const listResponse = await fetch(`${baseUrl}/evaluation-runs?projectId=${projectId}`);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as EvaluationRun[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.qualityStatus, 'scored');
    assert.equal(listed[0]?.qualityReason.code, 'scores-complete');

    const getResponse = await fetch(`${runUrl}?projectId=${projectId}`);
    assert.equal(getResponse.status, 200);
    const stored = (await getResponse.json()) as EvaluationRun;
    assert.equal(stored.qualityStatus, 'scored');
    assert.equal(stored.qualityReason.code, 'scores-complete');

    const renameResponse = await fetch(runUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '  Scoring baseline  ' }),
    });
    assert.equal(renameResponse.status, 200);
    const renamed = (await renameResponse.json()) as EvaluationRun;
    assert.equal(renamed.name, 'Scoring baseline');

    const renamedGetResponse = await fetch(`${runUrl}?projectId=${projectId}`);
    assert.equal(renamedGetResponse.status, 200);
    const renamedStored = (await renamedGetResponse.json()) as EvaluationRun;
    assert.equal(renamedStored.name, 'Scoring baseline');
  });
});
