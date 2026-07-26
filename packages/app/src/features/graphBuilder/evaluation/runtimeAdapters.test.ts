import assert from 'node:assert/strict';
import test from 'node:test';
import { GRAPH_BUILDER_PROTOCOL_VERSION, type GraphBuilderDecision } from '../../../domain/graphBuilder/index.js';
import type { GraphBuilderPolicyExecutionResult, GraphBuilderPolicyTurn } from '../sessionController.js';
import { runGraphBuilderDevelopmentComparison } from './comparison.js';
import { runGraphBuilderDevelopmentEvaluation } from './harness.js';
import {
  createHardenedLegacyGraphBuilderEvaluationAdapter,
  createPlanBGraphBuilderEvaluationAdapter,
} from './runtimeAdapters.js';

function policyResult(turn: GraphBuilderPolicyTurn, decision: GraphBuilderDecision): GraphBuilderPolicyExecutionResult {
  return {
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    policyVersion: turn.policyVersion,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    attemptId: turn.attemptId,
    decision,
    usage: { completeness: 'unavailable' },
  };
}

test('Plan B evaluation adapter runs a checked fixture through the production host runtime', async () => {
  const adapter = createPlanBGraphBuilderEvaluationAdapter({
    executePolicy: async (turn) =>
      policyResult(turn, {
        type: 'propose-patch',
        proposal: {
          protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
          operations: [
            {
              op: 'createNode',
              clientId: 'number',
              authoringChoiceId: 'registered:number',
            },
          ],
        },
        afterApply: 'ready-for-preview',
        summary: 'Created a Number node.',
      }),
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'plan-b',
    fixtureIds: ['repair-provider-failure'],
  });

  assert.equal(run.observations[0]?.outcome, 'success');
  assert.equal(
    run.observations[0]?.graph &&
      typeof run.observations[0].graph === 'object' &&
      'nodes' in run.observations[0].graph &&
      Array.isArray(run.observations[0].graph.nodes) &&
      run.observations[0].graph.nodes.some((node) => node?.type === 'number'),
    true,
  );
  assert.equal(run.scores[0]?.structuralScore, 1);
  assert.equal(run.scores[0]?.accountingCoverage, 0);
});

test('Plan B evaluation requires a provider-wire audit in addition to its exact policy-turn source input', async () => {
  const executePolicy = async (turn: GraphBuilderPolicyTurn) =>
    policyResult(turn, {
      type: 'no-change',
      summary: 'No graph change is required.',
    });
  const sourceOnlyRun = await runGraphBuilderDevelopmentEvaluation({
    adapter: createPlanBGraphBuilderEvaluationAdapter({ executePolicy }),
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
  });
  assert.equal(sourceOnlyRun.scores[0]?.gates.redaction.passed, false);
  assert.equal(
    sourceOnlyRun.observations[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'redaction-audit-incomplete'),
    true,
  );

  const adapter = createPlanBGraphBuilderEvaluationAdapter({
    createTrialCollector: () => ({
      takeProviderAttempts: () => [],
      takeAuditedSurfaces: () => [
        {
          kind: 'provider-wire',
          label: 'provider-request',
          value: { messages: ['safe policy request'] },
        },
      ],
    }),
    executePolicy,
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
  });

  assert.equal(run.observations[0]?.outcome, 'success');
  assert.deepEqual(
    run.observations[0]?.canaryFindings.map((finding) => finding.locations),
    [[], [], []],
  );
  assert.equal(run.scores[0]?.gates.redaction.passed, true);
});

test('failed legacy adapter execution drains provider telemetry exactly once', async () => {
  let providerDrains = 0;
  let surfaceDrains = 0;
  const providerAttempt = {
    attemptId: 'failed-provider-attempt',
    parentAttemptId: null,
    provider: 'synthetic',
    model: 'synthetic-model',
    providerVersion: null,
    outcome: 'provider-error' as const,
    requestShapeSha256: `sha256:${'0'.repeat(64)}`,
    durationMs: 5,
    usage: {
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
      costUsd: 0.01,
      completeness: 'complete' as const,
      missing: [],
    },
  };
  const adapter = createHardenedLegacyGraphBuilderEvaluationAdapter({
    createTrialCollector: () => ({
      takeProviderAttempts: () => {
        providerDrains += 1;
        return [providerAttempt];
      },
      takeAuditedSurfaces: () => {
        surfaceDrains += 1;
        return [{ kind: 'provider-wire', label: 'failed-provider-request', value: { body: 'safe' } }];
      },
    }),
    executeAgent: async () => {
      throw new Error('raw provider failure');
    },
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'hardened-legacy',
    fixtureIds: ['repair-provider-failure'],
  });

  assert.equal(run.observations[0]?.outcome, 'failed');
  assert.deepEqual(run.observations[0]?.providerAttempts, [providerAttempt]);
  assert.equal(providerDrains, 1);
  assert.equal(surfaceDrains, 1);
});

test('Plan B evaluation adapter cancels the real controller without publishing the draft', async () => {
  const adapter = createPlanBGraphBuilderEvaluationAdapter({
    executePolicy: async (_turn, { abortSignal }) => {
      abortSignal.throwIfAborted();
      return new Promise<never>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    },
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'plan-b',
    fixtureIds: ['cancel-mid-session'],
  });

  assert.equal(run.observations[0]?.outcome, 'canceled');
  assert.equal(run.observations[0]?.cancellation?.requested, true);
  assert.equal(
    run.observations[0]?.cancellation?.authoritativeFingerprintBefore,
    run.observations[0]?.cancellation?.authoritativeFingerprintAfter,
  );
  assert.equal(run.scores[0]?.gates.cancellationRollback.passed, true);
});

test('Plan B evaluation adapter exercises the stale-identity Apply rejection', async () => {
  const adapter = createPlanBGraphBuilderEvaluationAdapter({
    executePolicy: async (turn) =>
      policyResult(turn, {
        type: 'propose-patch',
        proposal: {
          protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
          operations: [
            {
              op: 'createNode',
              clientId: 'text',
              authoringChoiceId: 'registered:text',
            },
          ],
        },
        afterApply: 'ready-for-preview',
        summary: 'Created a Text node.',
      }),
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'plan-b',
    fixtureIds: ['reject-stale-commit'],
  });

  assert.equal(run.observations[0]?.outcome, 'conflicted');
  assert.deepEqual(run.observations[0]?.conflict, {
    baseChanged: true,
    commitRejected: true,
  });
  assert.equal(run.scores[0]?.gates.conflictProtection.passed, true);
});

test('hardened legacy evaluation adapter runs the production private-draft seam', async () => {
  const adapter = createHardenedLegacyGraphBuilderEvaluationAdapter({
    executeAgent: async (execution) => {
      await execution.externalFunctions.createNode!({} as never, 'number');
      execution.onUserEvent.finalMessage?.({
        type: 'string',
        value: 'Created a Number node.',
      });
    },
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'hardened-legacy',
    fixtureIds: ['repair-provider-failure'],
  });

  assert.equal(run.observations[0]?.outcome, 'success');
  assert.equal(
    run.observations[0]?.graph &&
      typeof run.observations[0].graph === 'object' &&
      'nodes' in run.observations[0].graph &&
      Array.isArray(run.observations[0].graph.nodes) &&
      run.observations[0].graph.nodes.some((node) => node?.type === 'number'),
    true,
  );
  assert.equal(run.scores[0]?.structuralScore, 1);
});

test('as-shipped legacy cannot be synthesized from the hardened runtime', async () => {
  const adapter = createHardenedLegacyGraphBuilderEvaluationAdapter({
    executeAgent: async () => undefined,
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'as-shipped-legacy',
    fixtureIds: ['inspect-referenced-alias'],
  });

  assert.equal(run.observations[0]?.outcome, 'failed');
  assert.deepEqual(run.observations[0]?.diagnostics, [{ code: 'evaluation-adapter-error', severity: 'error' }]);
});

test('evaluation rejects a provider collector reused across fixture trials', async () => {
  const sharedCollector = {
    takeAuditedSurfaces: () => [],
    takeProviderAttempts: () => [],
  };
  const adapter = createHardenedLegacyGraphBuilderEvaluationAdapter({
    createTrialCollector: () => sharedCollector,
    executeAgent: async (execution) => {
      execution.onUserEvent.finalMessage?.({
        type: 'string',
        value: 'No change required.',
      });
    },
  });

  const run = await runGraphBuilderDevelopmentEvaluation({
    adapter,
    resultSlot: 'hardened-legacy',
    fixtureIds: ['inspect-referenced-alias'],
    trialsPerFixture: 2,
  });

  assert.equal(run.observations[0]?.outcome, 'success');
  assert.equal(run.observations[1]?.outcome, 'failed');
  assert.deepEqual(run.observations[1]?.diagnostics, [{ code: 'evaluation-adapter-error', severity: 'error' }]);
});

test('development comparison executes both concrete feature adapters over fresh fixtures', async () => {
  const hardenedLegacyAdapter = createHardenedLegacyGraphBuilderEvaluationAdapter({
    executeAgent: async (execution) => {
      await execution.externalFunctions.createNode!({} as never, 'number');
      execution.onUserEvent.finalMessage?.({
        type: 'string',
        value: 'Created a Number node.',
      });
    },
  });
  const planBAdapter = createPlanBGraphBuilderEvaluationAdapter({
    executePolicy: async (turn) =>
      policyResult(turn, {
        type: 'propose-patch',
        proposal: {
          protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
          operations: [
            {
              op: 'createNode',
              clientId: 'number',
              authoringChoiceId: 'registered:number',
            },
          ],
        },
        afterApply: 'ready-for-preview',
        summary: 'Created a Number node.',
      }),
  });

  const comparison = await runGraphBuilderDevelopmentComparison({
    hardenedLegacyAdapter,
    planBAdapter,
    fixtureIds: ['repair-provider-failure'],
  });

  assert.equal(comparison.hardenedLegacy.observations[0]?.outcome, 'success');
  assert.equal(comparison.planB.observations[0]?.outcome, 'success');
  assert.equal(comparison.hardenedLegacy.observations[0]?.graph === comparison.planB.observations[0]?.graph, false);
  assert.equal(comparison.thresholds['supported-host-safety'].status, 'fail');
  assert.ok(
    comparison.thresholds['supported-host-safety'].failures.includes('provider-accounting-coverage-below-threshold'),
  );
});
