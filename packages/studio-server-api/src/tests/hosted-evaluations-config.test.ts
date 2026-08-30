import assert from 'node:assert/strict';
import test from 'node:test';

import { getHostedEvaluationsCoordinatorConfig } from '../hosted-evaluations-config.js';

const disabledConfig = {
  enabled: false,
  workerEnabled: false,
  workerConcurrency: 0,
  leaseMs: 0,
  maxJobsPerRun: 0,
  maxOutstandingJobs: 0,
  pollMs: 0,
};

const defaultEnabledConfig = {
  enabled: true,
  workerConcurrency: 1,
  leaseMs: 60_000,
  maxJobsPerRun: 2_000,
  maxOutstandingJobs: 10_000,
  pollMs: 1_000,
};

test('hosted Evaluations are disabled unless explicitly enabled', () => {
  assert.deepEqual(getHostedEvaluationsCoordinatorConfig({}, 'combined', true), disabledConfig);
});

test('hosted Evaluations require managed storage and run workers only on the batch profile', () => {
  assert.throws(
    () => getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'combined', false),
    /requires managed workflow storage/,
  );

  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'control', true),
    { ...defaultEnabledConfig, workerEnabled: false },
  );
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'execution', true),
    { ...defaultEnabledConfig, workerEnabled: false },
  );
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'evaluation', true),
    { ...defaultEnabledConfig, workerEnabled: true },
  );
  // A combined process remains the explicit local-development topology.
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'true' }, 'combined', true),
    { ...defaultEnabledConfig, workerEnabled: true },
  );
});

test('hosted Evaluation configuration bounds workers, leases, polling, and batch quotas conservatively', () => {
  assert.deepEqual(
    getHostedEvaluationsCoordinatorConfig(
      {
        RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
        RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY: '99',
        RIVET_HOSTED_EVALUATIONS_LEASE_MS: '1',
        RIVET_HOSTED_EVALUATIONS_MAX_JOBS_PER_RUN: '999999999',
        RIVET_HOSTED_EVALUATIONS_MAX_OUTSTANDING_JOBS: '999999999',
        RIVET_HOSTED_EVALUATIONS_POLL_MS: '1',
      },
      'evaluation',
      true,
    ),
    {
      enabled: true,
      workerEnabled: true,
      workerConcurrency: 8,
      leaseMs: 15_000,
      maxJobsPerRun: 100_000,
      maxOutstandingJobs: 1_000_000,
      pollMs: 250,
    },
  );
  assert.throws(
    () => getHostedEvaluationsCoordinatorConfig({ RIVET_HOSTED_EVALUATIONS_ENABLED: 'yes' }, 'evaluation', true),
    /must be true or false/,
  );
  assert.throws(
    () =>
      getHostedEvaluationsCoordinatorConfig(
        {
          RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
          RIVET_HOSTED_EVALUATIONS_MAX_JOBS_PER_RUN: '10',
          RIVET_HOSTED_EVALUATIONS_MAX_OUTSTANDING_JOBS: '9',
        },
        'evaluation',
        true,
      ),
    /must be greater than or equal to/,
  );
});
