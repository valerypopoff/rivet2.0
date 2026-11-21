import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationAggregate } from '@valerypopoff/rivet2-evaluations';
import {
  formatEvaluationCompletionToast,
  formatEvaluationRunHistoryPersistenceWarning,
} from './evaluationRunSummary.js';

function makeAggregate(overrides: Partial<EvaluationAggregate>): EvaluationAggregate {
  return {
    trialCount: 0,
    evaluatedTrialCount: 0,
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
    ...overrides,
  };
}

test('evaluation completion summaries use authoritative quality and evaluated trial counts', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'evaluation',
      executionStatus: 'completed',
      qualityStatus: 'failed',
      aggregate: makeAggregate({
        trialCount: 3,
        evaluatedTrialCount: 2,
        unableToEvaluateTrialCount: 1,
        passedTrialCount: 1,
        failedTrialCount: 1,
        passRate: 0.5,
      }),
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
      aggregate: makeAggregate({
        trialCount: 2,
        notEvaluatedTrialCount: 2,
      }),
      trials: [],
    }),
    'Execution benchmark completed: 2 trials measured.',
  );
});

test('scoring completion summaries show the normalized score and coverage', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'evaluation',
      executionStatus: 'completed',
      qualityStatus: 'scored',
      aggregate: makeAggregate({
        trialCount: 4,
        scoredTrialCount: 4,
        missingScoreTrialCount: 0,
        meanScore: 0.85,
      }),
      trials: [],
    }),
    'Evaluation Scored: 85/100; 4 of 4 requested trials scored.',
  );
});

test('incomplete scoring summaries retain zero-score coverage instead of describing thresholds', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'evaluation',
      evaluationMode: 'scoring',
      executionStatus: 'completed',
      qualityStatus: 'unable-to-evaluate',
      aggregate: makeAggregate({
        trialCount: 2,
        unableToEvaluateTrialCount: 2,
        scoredTrialCount: 0,
        missingScoreTrialCount: 2,
        evaluatorErrorRate: 1,
      }),
      trials: [],
    }),
    'Evaluation Unable to evaluate: unavailable; 0 of 2 requested trials scored.',
  );
});

test('execution benchmark summaries surface trial execution errors', () => {
  assert.equal(
    formatEvaluationCompletionToast({
      purpose: 'execution-benchmark',
      executionStatus: 'completed',
      qualityStatus: 'not-evaluated',
      aggregate: makeAggregate({
        trialCount: 2,
        notEvaluatedTrialCount: 1,
        erroredTrialCount: 1,
        targetErrorRate: 0.5,
      }),
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
      aggregate: makeAggregate({
        trialCount: 1,
        notEvaluatedTrialCount: 1,
      }),
      trials: [],
    }),
    'Evaluation Passed: aggregate requirements passed; no per-trial quality checks ran.',
  );
});

test('run-history persistence warnings expose the storage reason without calling the evaluation failed', () => {
  assert.equal(
    formatEvaluationRunHistoryPersistenceWarning(new Error('QuotaExceededError: storage is full')),
    'This completed evaluation could not be saved to run history: QuotaExceededError: storage is full',
  );
});
