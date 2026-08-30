import assert from 'node:assert/strict';
import test from 'node:test';

import { getHostedEvaluationsCoordinatorConfig } from '../hosted-evaluations-config.js';

test('hosted Evaluations are disabled unless explicitly enabled', () => {
  assert.deepEqual(getHostedEvaluationsCoordinatorConfig({}, 'combined', true), {
    enabled: false,
    workerEnabled: false,
    workerConcurrency: 0,
    leaseMs: 0,
    pollMs: 0,
  });
});

test('hosted Evaluations require managed storage and never run workers in the control profile', () => {
  assert.throws(
    () => getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'combined', false),
    /requires managed workflow storage/,
  );
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'control', true),
    { enabled: true, workerEnabled: false, workerConcurrency: 1, leaseMs: 60_000, pollMs: 1_000 },
  );
});

test('hosted Evaluation configuration bounds workers, leases, and polling conservatively', () => {
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig(
      {
        RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
        RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY: '99',
        RIVET_HOSTED_EVALUATIONS_LEASE_MS: '1',
        RIVET_HOSTED_EVALUATIONS_POLL_MS: '1',
      },
      'execution',
      true,
    ),
    { enabled: true, workerEnabled: true, workerConcurrency: 8, leaseMs: 15_000, pollMs: 250 },
  );
  assert.throws(
    () => getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'yes' }, 'execution', true),
    /must be true or false/,
  );
  assert.equal(
    getHostedEvaluationsCoordinatorConfig(
      {
        RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
        RIVET_HOSTED_EVALUATIONS_LEASE_MS: '999999999',
      },
      'execution',
      true,
    ).leaseMs,
    600_000,
  );
});
