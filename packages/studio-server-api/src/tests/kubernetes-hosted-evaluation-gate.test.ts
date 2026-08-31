import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deserializeEvaluationProjectData, validateEvaluationDataset } from '@valerypopoff/rivet2-evaluations';

import {
  buildHostedEvaluationGateConfig,
  createHostedEvaluationEvidence,
  createHostedEvaluationSubmission,
} from '../../../../deploy/studio-server/scripts/kubernetes-hosted-evaluation-gate.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const digest = (letter: string) => 'sha256:' + letter.repeat(64);

function environment(configFile: string, valuesFile: string, overrides: NodeJS.ProcessEnv = {}) {
  return {
    RIVET_K8S_PROVIDER_GATE_CONFIRM: 'deploy-staging',
    RIVET_K8S_PROVIDER_GATE_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_CONFIG_FILE: configFile,
    RIVET_K8S_PROVIDER_GATE_VALUES_FILE: valuesFile,
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_PROVIDER_GATE_REGISTRY_USERNAME: 'provider-gate',
    RIVET_K8S_PROVIDER_GATE_REGISTRY_PASSWORD: 'provider-gate-token',
    RIVET_K8S_EVALUATION_GATE_CONFIRM: 'disrupt-staging-evaluations',
    ...overrides,
  };
}

function providerConfig() {
  return {
    namespace: 'rivet-staging-evaluations',
    release: 'rivet-staging',
    baseUrl: 'https://rivet-staging.example.test',
    requestHeaders: { authorization: 'Bearer test-only' },
    workflowProbe: {
      path: '/workflows/provider-gate',
      method: 'POST',
      body: { input: 'provider' },
      contains: 'provider',
    },
    webAppProbe: { path: '/apps/provider-gate', contains: 'Provider gate' },
    hostedEvaluationGate: { waitSeconds: 180, publicProbeRequests: 4 },
  };
}

test('hosted Evaluation gate is protected, bounded, and uses a valid isolated benchmark submission', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-hosted-evaluation-gate-test-'));
  const configFile = path.join(directory, 'provider-gate.json');
  const valuesFile = path.join(directory, 'values.yaml');
  try {
    await fs.writeFile(configFile, JSON.stringify(providerConfig()));
    await fs.writeFile(valuesFile, 'hostedEvaluations:\n  enabled: true\n');
    const config = buildHostedEvaluationGateConfig({ rootDir, env: environment(configFile, valuesFile) });
    assert.equal(config.hostedEvaluation.waitSeconds, 180);
    assert.equal(config.hostedEvaluation.publicProbeRequests, 4);
    assert.throws(
      () =>
        buildHostedEvaluationGateConfig({
          rootDir,
          env: environment(configFile, valuesFile, { RIVET_K8S_EVALUATION_GATE_CONFIRM: 'yes' }),
        }),
      /must equal disrupt-staging-evaluations/u,
    );

    const submission = createHostedEvaluationSubmission({ runId: 'run-1', label: 'interruption' });
    assert.equal(submission.purpose, 'execution-benchmark');
    assert.equal(submission.dataset.projectId, '230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b');
    assert.equal(submission.evaluationData.suites[0].targetGraphId, 'd6d3c1cf-670d-4b8d-bf64-617be4e3df81');
    assert.equal(submission.evaluationData.suites[0].configuration.trialCount, 1);
    assert.deepEqual(submission.evaluationData.suites[0].assertions, []);
    assert.equal(deserializeEvaluationProjectData(submission.evaluationData).suites[0]?.id, submission.suiteId);
    assert.equal(validateEvaluationDataset(submission.dataset).id, 'dataset-run-1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('hosted Evaluation evidence records durable job state but never raw failure text', () => {
  const evidence = createHostedEvaluationEvidence({
    phase: 'wait-for-interruption',
    completed: false,
    runs: [
      {
        id: 'run-1',
        state: {
          status: 'interrupted',
          jobs: [{ jobId: 'job-1', status: 'interrupted', attempt: 1 }],
        },
      },
    ],
    publicProbe: { requested: 4, statusCounts: { 200: 4 } },
    failure: new Error('do not serialize provider secret'),
  });
  assert.deepEqual(evidence, {
    version: 1,
    status: 'failed',
    phase: 'wait-for-interruption',
    runs: [
      {
        id: 'run-1',
        status: 'interrupted',
        jobs: [{ jobId: 'job-1', status: 'interrupted', attempt: 1, acceptedAt: null, settledAt: null }],
      },
    ],
    publicProbe: { requested: 4, statusCounts: { 200: 4 } },
    failure: { phase: 'wait-for-interruption', kind: 'Error' },
    cleanup: { attempted: true, succeeded: true, failureKind: null },
  });
  assert.equal(JSON.stringify(evidence).includes('provider secret'), false);
});
