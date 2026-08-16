import assert from 'node:assert/strict';
import test from 'node:test';
import { formatEvaluationCompletionToast } from './evaluationRunSummary.js';

test('evaluation completion summaries use authoritative quality and evaluated trial counts', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'evaluation',
      executionStatus: 'completed',
      qualityStatus: 'failed',
      aggregate: {
        trialCount: 3,
        evaluatedTrialCount: 2,
        notEvaluatedTrialCount: 0,
        unableToEvaluateTrialCount: 1,
        passedTrialCount: 1,
        failedTrialCount: 1,
        erroredTrialCount: 0,
        canceledTrialCount: 0,
        passRate: 0.5,
        averageLatencyMs: 1,
        p95LatencyMs: 1,
        targetErrorRate: 0,
        evaluatorErrorRate: 0,
        toolFailureRate: 0,
        metrics: {},
      },
      trials: [],
    }),
    'Evaluation Failed: 1/2 evaluated trials passed.',
  );
});

test('execution benchmark summaries describe measurement instead of quality passes', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'execution-benchmark',
      executionStatus: 'completed',
      qualityStatus: 'not-evaluated',
      aggregate: {
        trialCount: 2,
        evaluatedTrialCount: 0,
        notEvaluatedTrialCount: 2,
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
      trials: [],
    }),
    'Execution benchmark completed: 2 trials measured.',
  );
});

test('execution benchmark summaries surface trial execution errors', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'execution-benchmark',
      executionStatus: 'completed',
      qualityStatus: 'not-evaluated',
      aggregate: {
        trialCount: 2,
        evaluatedTrialCount: 0,
        notEvaluatedTrialCount: 1,
        unableToEvaluateTrialCount: 0,
        passedTrialCount: 0,
        failedTrialCount: 0,
        erroredTrialCount: 1,
        canceledTrialCount: 0,
        passRate: 0,
        averageLatencyMs: 1,
        p95LatencyMs: 1,
        targetErrorRate: 0.5,
        evaluatorErrorRate: 0,
        toolFailureRate: 0,
        metrics: {},
      },
      trials: [],
    }),
    'Execution benchmark completed with 1 execution error: 1 of 2 trials measured.',
  );
});

test('threshold-only evaluation summaries do not claim that zero of zero trials passed', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'evaluation',
      executionStatus: 'completed',
      qualityStatus: 'passed',
      aggregate: {
        trialCount: 1,
        evaluatedTrialCount: 0,
        notEvaluatedTrialCount: 1,
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
      trials: [],
    }),
    'Evaluation Passed: aggregate requirements passed; no per-trial quality checks ran.',
  );
});
