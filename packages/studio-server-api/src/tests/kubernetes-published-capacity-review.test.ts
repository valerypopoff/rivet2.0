import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCapacityCalibrationReview,
  writeCapacityCalibrationReview,
} from '../../../../deploy/studio-server/scripts/kubernetes-published-capacity-review.mjs';

test('capacity calibration review summarizes safe observations without reproducing sensitive values', () => {
  const review = createCapacityCalibrationReview({
    version: 1,
    mode: 'observe',
    status: 'completed',
    phase: 'capture-diagnostics',
    report: {
      stages: [
        {
          name: 'steady',
          scenario: '[long calibration]',
          requestTimings: { p50Ms: 120, p95Ms: 450, p99Ms: 700 },
          outcomes: { succeeded: 20, rejected: 0, unexpected: 0 },
        },
      ],
    },
    snapshots: [
      {
        baseline: true,
        podCount: 1,
        metrics: { activeRuns: 0, admissionLimit: 4, recordingQueueDepth: 0 },
        restartCountsByPod: { 'execution-0': 3 },
        oomKilledPods: ['old-oom'],
        evictedPods: ['old-eviction'],
      },
      {
        baseline: false,
        podCount: 1,
        metrics: { activeRuns: 4, admissionLimit: 4, recordingQueueDepth: 2 },
        recordingDropsObserved: 0,
        restartCountsByPod: { 'execution-0': 4 },
        oomKilledPods: ['old-oom', 'new-oom'],
        evictedPods: ['old-eviction', 'new-eviction'],
        prometheus: {
          available: true,
          values: {
            memoryHighWaterBytes: 1_572_864,
            nodeEphemeralHighWaterBytes: 2_097_152,
            downstreamConcurrency: 3,
          },
        },
      },
      {
        baseline: false,
        podCount: 1,
        metrics: { activeRuns: 4, admissionLimit: 4, recordingQueueDepth: 2 },
        restartCountsByPod: { 'execution-0': 4 },
        oomKilledPods: ['old-oom', 'new-oom'],
        evictedPods: ['old-eviction', 'new-eviction'],
        recordingDropsObserved: 0,
      },
    ],
    certificate: { evaluated: true, passed: false, failures: ['Bearer capacity-secret must not be reproduced'] },
    cleanup: { succeeded: true },
  });

  assert.match(review, /Published capacity calibration review/);
  assert.match(review, /Observe-mode boundary/);
  assert.match(review, /steady/);
  assert.match(review, /\\[long calibration\\]/);
  assert.match(review, /450 ms/);
  assert.match(review, /1\.5 MiB/);
  assert.match(review, /2 MiB/);
  assert.match(review, /Findings recorded/);
  assert.match(review, /Execution container restarts \| 1/);
  assert.match(review, /Execution OOM-kill observations \| 1/);
  assert.match(review, /Execution eviction observations \| 1/);
  assert.doesNotMatch(review, /capacity-secret/);
  assert.doesNotMatch(review, /Bearer/);
});

test('capacity calibration review keeps missing evidence diagnostic rather than passing it', () => {
  const review = createCapacityCalibrationReview(null);

  assert.match(review, /No readable capacity evidence was available/);
  assert.match(review, /cannot support sizing, threshold, or promotion decisions/);
});

test('capacity calibration review fails closed for an unsupported evidence schema', () => {
  const review = createCapacityCalibrationReview({
    version: 2,
    mode: 'observe',
    status: 'completed',
    cleanup: { succeeded: true },
    report: { stages: [] },
  });

  assert.match(review, /unsupported or missing schema version/);
  assert.doesNotMatch(review, /Stage observations/);
});

test('capacity calibration review remains available after a capacity runner fails before writing JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-capacity-review-test-'));
  const outputFile = path.join(directory, 'capacity-review.md');
  try {
    await writeCapacityCalibrationReview({
      inputFile: path.join(directory, 'missing-capacity-report.json'),
      outputFile,
    });
    const review = await fs.readFile(outputFile, 'utf8');
    assert.match(review, /No readable capacity evidence was available/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
