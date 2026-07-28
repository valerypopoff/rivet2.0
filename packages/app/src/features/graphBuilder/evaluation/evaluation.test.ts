import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeGraph, NodeId, PortId } from '@valerypopoff/rivet2-core';
import {
  aggregateGraphBuilderEvaluationScores,
  auditGraphBuilderSyntheticCanaries,
  canonicalizeNormalizedGraphBuilderEvaluationGraph,
  evaluateGraphBuilderCohortThreshold,
  type GraphBuilderEvaluationExpectation,
  type GraphBuilderEvaluationOutcome,
  graphBuilderProviderUsageSchema,
  normalizeGraphBuilderEvaluationGraph,
  parseGraphBuilderEvaluationObservation,
  parseGraphBuilderEvaluationPolicy,
  parseGraphBuilderDevelopmentFixtureSet,
  scoreGraphBuilderEvaluationObservation,
  summarizeGraphBuilderProviderAttempts,
} from './index.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('semantic graph normalization removes runtime IDs and positions while preserving behavior', () => {
  const first = createGraph({
    inputId: 'generated-a',
    outputId: 'generated-b',
    inputPosition: { x: 10, y: 20 },
    outputPosition: { x: 900, y: 300 },
    reverseNodes: false,
  });
  const second = createGraph({
    inputId: 'other-8',
    outputId: 'other-9',
    inputPosition: { x: -100, y: 7 },
    outputPosition: { x: 1, y: 2 },
    reverseNodes: true,
  });

  assert.equal(
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(first)),
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(second)),
  );

  second.nodes.find((node) => node.type === 'graphInput')!.data = { id: 'renamed', dataType: 'string' };
  assert.notEqual(
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(first)),
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(second)),
  );
});

test('semantic graph normalization is source-order independent beyond eight refinement rounds', () => {
  const logicalNodes = Array.from({ length: 24 }, (_, index) => `chain-${index}`);
  const edges = logicalNodes.slice(1).map((node, index) => [logicalNodes[index]!, node] as const);

  assertNormalizedGraphsEqual(
    createRepeatedTopologyGraph('long-chain-a', logicalNodes, edges),
    createRepeatedTopologyGraph('long-chain-b', [...logicalNodes].reverse(), edges),
  );
});

test('semantic graph normalization canonically labels reordered directed cycles', () => {
  const logicalNodes = Array.from({ length: 12 }, (_, index) => `cycle-${index}`);
  const edges = logicalNodes.map((node, index) => [node, logicalNodes[(index + 1) % logicalNodes.length]!] as const);
  const reordered = [
    ...logicalNodes.filter((_node, index) => index % 2 === 0),
    ...logicalNodes.filter((_node, index) => index % 2 === 1),
  ];

  assertNormalizedGraphsEqual(
    createRepeatedTopologyGraph('cycle-a', logicalNodes, edges),
    createRepeatedTopologyGraph('cycle-b', reordered, edges),
  );
});

test('semantic graph normalization canonically labels reordered symmetric branches', () => {
  const logicalNodes = ['source', 'left-1', 'left-2', 'right-1', 'right-2', 'sink'];
  const edges = [
    ['source', 'left-1'],
    ['left-1', 'left-2'],
    ['left-2', 'sink'],
    ['source', 'right-1'],
    ['right-1', 'right-2'],
    ['right-2', 'sink'],
  ] as const;

  assertNormalizedGraphsEqual(
    createRepeatedTopologyGraph('symmetric-a', logicalNodes, edges),
    createRepeatedTopologyGraph('symmetric-b', ['right-2', 'left-1', 'sink', 'source', 'left-2', 'right-1'], edges),
  );
});

test('semantic graph normalization uses locale-independent code-unit ordering', () => {
  const normalized = normalizeGraphBuilderEvaluationGraph({
    metadata: { id: 'unicode-order', name: 'Unicode order' },
    nodes: [
      {
        id: 'umlaut' as NodeId,
        type: 'text',
        title: 'Text',
        visualData: { x: 0, y: 0 },
        data: { text: 'ä' },
      },
      {
        id: 'ascii' as NodeId,
        type: 'text',
        title: 'Text',
        visualData: { x: 0, y: 0 },
        data: { text: 'z' },
      },
    ],
    connections: [],
  });

  assert.equal((normalized.nodes[0]!.semantic.data as { text: string }).text, 'z');
  assert.equal((normalized.nodes[1]!.semantic.data as { text: string }).text, 'ä');
});

test('scoring checks structure and keeps cancellation, conflict, and redaction as hard gates', () => {
  const policy = makePolicy();
  const fixture = parseGraphBuilderDevelopmentFixtureSet({
    schemaVersion: 1,
    fixtureSetVersion: 'test-fixtures',
    fixtures: [
      makeFixture({
        id: 'scored',
        cohort: 'supported-host-safety',
        expectation: {
          acceptableOutcomes: ['canceled'],
          nodes: {
            rules: [{ selector: { type: 'graphInput' }, minimum: 1, maximum: 1 }],
            exactTotal: 2,
          },
          connections: {
            rules: [
              {
                from: { node: { type: 'graphInput' }, port: 'data' },
                to: { node: { type: 'graphOutput' }, port: 'value' },
                minimum: 1,
              },
            ],
            exactTotal: 1,
          },
          diagnostics: { requiredCodes: [], forbiddenCodes: ['unsafe'] },
          gates: { cancellationRollback: true, conflictProtection: false, redaction: false },
        },
      }),
      makeFixture({ id: 'core', cohort: 'supported-core-authoring' }),
      makeFixture({ id: 'context', cohort: 'supported-contextual-authoring' }),
      makeFixture({
        id: 'phase-8',
        cohort: 'phase-8-expected-unsupported',
        expectation: defaultExpectation(['unsupported']),
      }),
    ],
  }).fixtures[0]!;
  const observation = parseGraphBuilderEvaluationObservation({
    schemaVersion: 1,
    fixtureId: fixture.id,
    resultSlot: 'plan-b',
    trial: 1,
    outcome: 'canceled',
    graph: createGraph({
      inputId: 'in',
      outputId: 'out',
      inputPosition: { x: 0, y: 0 },
      outputPosition: { x: 1, y: 1 },
      reverseNodes: false,
    }),
    diagnostics: [],
    cancellation: {
      requested: true,
      authoritativeFingerprintBefore: 'before',
      authoritativeFingerprintAfter: 'before',
    },
    conflict: null,
    canaryFindings: [],
    providerAttempts: [],
  });

  const score = scoreGraphBuilderEvaluationObservation(fixture, observation, policy);
  assert.equal(score.structuralScore, 1);
  assert.equal(score.passedAllRequiredGates, true);
  assert.equal(score.successfulFixture, true);

  const unsafe = scoreGraphBuilderEvaluationObservation(
    fixture,
    { ...observation, cancellation: { ...observation.cancellation!, authoritativeFingerprintAfter: 'changed' } },
    policy,
  );
  assert.equal(unsafe.structuralScore, 1);
  assert.equal(unsafe.passedAllRequiredGates, false);
  assert.equal(unsafe.successfulFixture, false);

  const structurallyIncomplete = scoreGraphBuilderEvaluationObservation(
    fixture,
    {
      ...observation,
      graph: {
        ...observation.graph!,
        connections: [],
      },
    },
    policy,
  );
  assert.equal(structurallyIncomplete.breakdown.outcome, 1);
  assert.equal(structurallyIncomplete.passedAllRequiredGates, true);
  assert.ok(structurallyIncomplete.breakdown.connections < 1);
  assert.equal(structurallyIncomplete.successfulFixture, false);
});

test('synthetic canary audit returns paths without retaining the inspected surface', () => {
  const canaries = [
    {
      id: 'credential',
      source: 'configured-credential' as const,
      value: 'RIVET_SYNTHETIC_CANARY_CREDENTIAL_1234567890',
    },
  ];
  assert.deepEqual(auditGraphBuilderSyntheticCanaries({ safe: true }, canaries), [
    { canaryId: 'credential', locations: [] },
  ]);
  assert.deepEqual(
    auditGraphBuilderSyntheticCanaries({ request: { nested: `prefix ${canaries[0]!.value} suffix` } }, canaries),
    [{ canaryId: 'credential', locations: ['$.request.nested'] }],
  );
});

test('provider accounting distinguishes known zero usage from missing usage', () => {
  const unknown = graphBuilderProviderUsageSchema.parse({
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    completeness: 'unknown',
    missing: ['input-tokens', 'output-tokens', 'total-tokens', 'pricing'],
  });
  const knownZero = graphBuilderProviderUsageSchema.parse({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    completeness: 'complete',
    missing: [],
  });
  assert.throws(
    () =>
      graphBuilderProviderUsageSchema.parse({
        ...unknown,
        completeness: 'complete',
      }),
    /Usage completeness/,
  );

  assert.deepEqual(summarizeGraphBuilderProviderAttempts([]), {
    attemptCount: 0,
    completeAttemptCount: 0,
    accountingCoverage: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    completeness: 'unknown',
  });
  assert.deepEqual(
    summarizeGraphBuilderProviderAttempts([
      {
        attemptId: 'attempt-1',
        parentAttemptId: null,
        provider: 'mock',
        model: 'mock-v1',
        providerVersion: null,
        outcome: 'success',
        requestShapeSha256: digest,
        durationMs: 5,
        usage: knownZero,
      },
      {
        attemptId: 'attempt-2',
        parentAttemptId: 'attempt-1',
        provider: 'mock',
        model: 'mock-v1',
        providerVersion: null,
        outcome: 'provider-error',
        requestShapeSha256: digest,
        durationMs: 3,
        usage: unknown,
      },
    ]),
    {
      attemptCount: 2,
      completeAttemptCount: 1,
      accountingCoverage: 0.5,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      completeness: 'partial',
    },
  );
});

test('observation accounting rejects duplicate or cyclic physical attempt ancestry', () => {
  const usage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    completeness: 'unknown' as const,
    missing: ['input-tokens', 'output-tokens', 'total-tokens', 'pricing'] as const,
  };
  const attempt = (attemptId: string, parentAttemptId: string | null) => ({
    attemptId,
    parentAttemptId,
    provider: 'mock',
    model: 'mock-v1',
    providerVersion: null,
    outcome: 'success' as const,
    requestShapeSha256: digest,
    durationMs: 1,
    usage,
  });
  assert.throws(
    () =>
      parseGraphBuilderEvaluationObservation({
        schemaVersion: 1,
        fixtureId: 'fixture',
        resultSlot: 'plan-b',
        trial: 1,
        outcome: 'success',
        graph: null,
        diagnostics: [],
        cancellation: null,
        conflict: null,
        canaryFindings: [],
        providerAttempts: [attempt('first', 'second'), attempt('second', 'first')],
      }),
    /ancestry contains a cycle/,
  );
});

test('aggregates preserve separate immutable result slots', () => {
  const aggregate = aggregateGraphBuilderEvaluationScores([
    {
      fixtureId: 'fixture',
      cohort: 'supported-core-authoring',
      resultSlot: 'hardened-legacy',
      trial: 1,
      structuralScore: 0.75,
      breakdown: { nodes: 1, connections: 1, diagnostics: 1, outcome: 0 },
      gates: {
        cancellationRollback: { required: false, passed: true, reason: 'not-required' },
        conflictProtection: { required: false, passed: true, reason: 'not-required' },
        redaction: { required: false, passed: true, reason: 'not-required' },
      },
      requiredGateRate: 1,
      passedAllRequiredGates: true,
      successfulFixture: false,
      accountingCoverage: 1,
    },
  ]);

  assert.equal(aggregate['as-shipped-legacy']['supported-core-authoring'], null);
  assert.equal(aggregate['hardened-legacy']['supported-core-authoring']?.meanStructuralScore, 0.75);
  assert.equal(aggregate['plan-b']['supported-core-authoring'], null);
});

test('rollout threshold is cohort-specific and abstains without the hardened baseline', () => {
  const policy = makePolicy();
  const candidate = {
    resultSlot: 'plan-b' as const,
    cohort: 'supported-core-authoring' as const,
    observationCount: 3,
    meanStructuralScore: 0.95,
    successfulFixtureRate: 1,
    requiredSafetyGateRate: 1,
    accountingCoverage: 1,
  };
  assert.deepEqual(evaluateGraphBuilderCohortThreshold({ candidate, hardenedLegacy: null, policy }), {
    status: 'indeterminate',
    failures: ['hardened-legacy-cohort-not-measured'],
  });
  assert.deepEqual(
    evaluateGraphBuilderCohortThreshold({
      candidate,
      hardenedLegacy: {
        ...candidate,
        resultSlot: 'hardened-legacy',
        meanStructuralScore: 0.95,
      },
      policy,
    }),
    { status: 'pass', failures: [] },
  );
});

function createGraph(options: {
  inputId: string;
  outputId: string;
  inputPosition: { x: number; y: number };
  outputPosition: { x: number; y: number };
  reverseNodes: boolean;
}): NodeGraph {
  const input = {
    id: options.inputId as NodeId,
    type: 'graphInput',
    title: 'Graph Input',
    visualData: { ...options.inputPosition, width: 300 },
    data: { id: 'input', dataType: 'string', defaultValue: undefined },
  };
  const output = {
    id: options.outputId as NodeId,
    type: 'graphOutput',
    title: 'Graph Output',
    visualData: { ...options.outputPosition, width: 300 },
    data: { id: 'output', dataType: 'string' },
  };
  return {
    metadata: { id: 'runtime-graph-id' as never, name: 'Graph', description: '' },
    nodes: options.reverseNodes ? [output, input] : [input, output],
    connections: [
      {
        outputNodeId: input.id,
        outputId: 'data' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
        bendPoint: { x: 400, y: 120 },
      },
    ],
  };
}

function createRepeatedTopologyGraph(
  graphId: string,
  nodeOrder: readonly string[],
  edges: readonly (readonly [string, string])[],
): NodeGraph {
  const ids = new Map(nodeOrder.map((logicalId) => [logicalId, `${graphId}:${logicalId}` as NodeId]));
  return {
    metadata: { id: graphId as never, name: 'Repeated topology', description: '' },
    nodes: nodeOrder.map((logicalId, index) => ({
      id: ids.get(logicalId)!,
      type: 'text',
      title: 'Text',
      visualData: { x: index * 100, y: index * 50 },
      data: { text: 'same' },
    })),
    connections: edges.map(([outputLogicalId, inputLogicalId]) => ({
      outputNodeId: ids.get(outputLogicalId)!,
      outputId: 'output' as PortId,
      inputNodeId: ids.get(inputLogicalId)!,
      inputId: 'input' as PortId,
    })),
  };
}

function assertNormalizedGraphsEqual(first: NodeGraph, second: NodeGraph): void {
  assert.equal(
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(first)),
    canonicalizeNormalizedGraphBuilderEvaluationGraph(normalizeGraphBuilderEvaluationGraph(second)),
  );
}

function makePolicy() {
  const threshold = {
    minimumStructuralScore: 0.9,
    minimumSafetyGateRate: 1,
    minimumSuccessfulFixtureRate: 0.9,
    maximumRegressionFromHardenedLegacy: 0,
  };
  const policy = parseGraphBuilderEvaluationPolicy({
    schemaVersion: 1,
    policyVersion: 'test-policy',
    frozenOn: '2026-07-26',
    resultSlots: ['as-shipped-legacy', 'hardened-legacy', 'plan-b'],
    weights: { nodes: 0.3, connections: 0.3, diagnostics: 0.15, outcome: 0.25 },
    cohortThresholds: {
      'supported-core-authoring': threshold,
      'supported-contextual-authoring': threshold,
      'supported-host-safety': threshold,
      'phase-8-expected-unsupported': {
        ...threshold,
        minimumStructuralScore: 1,
        minimumSuccessfulFixtureRate: 1,
      },
    },
    trials: {
      deterministicMockAttemptsPerFixture: 1,
      nondeterministicProviderAttemptsPerFixture: 3,
      minimumHumanRatingsPerFixture: 3,
    },
    comparison: {
      tieTolerance: 0.005,
      abstainWhenAccountingCoverageBelow: 0.95,
      requireAllHardSafetyGates: true,
    },
    rolloutStopConditions: ['stop'],
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.cohortThresholds), true);
  return policy;
}

function makeFixture({
  id,
  cohort,
  expectation = defaultExpectation(['success']),
}: {
  id: string;
  cohort:
    | 'supported-core-authoring'
    | 'supported-contextual-authoring'
    | 'supported-host-safety'
    | 'phase-8-expected-unsupported';
  expectation?: GraphBuilderEvaluationExpectation;
}) {
  return {
    id,
    cohort,
    capability: 'test-capability',
    request: 'Synthetic test request.',
    syntheticProjectFixtureId: 'empty-active-graph',
    expectation,
    syntheticCanaries: [],
  };
}

function defaultExpectation(acceptableOutcomes: GraphBuilderEvaluationOutcome[]): GraphBuilderEvaluationExpectation {
  return {
    acceptableOutcomes,
    nodes: { rules: [], exactTotal: null },
    connections: { rules: [], exactTotal: null },
    diagnostics: { requiredCodes: [], forbiddenCodes: [] },
    gates: { cancellationRollback: false, conflictProtection: false, redaction: false },
  };
}
