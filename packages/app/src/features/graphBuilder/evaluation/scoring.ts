import type {
  GraphBuilderEvaluationFixture,
  GraphBuilderEvaluationCohort,
  GraphBuilderEvaluationNodeSelector,
  GraphBuilderEvaluationObservation,
  GraphBuilderEvaluationPolicy,
  GraphBuilderEvaluationResultSlot,
  GraphBuilderSyntheticCanary,
} from './contracts.js';
import { summarizeGraphBuilderProviderAttempts } from './contracts.js';
import {
  normalizeGraphBuilderEvaluationGraph,
  type NormalizedGraphBuilderEvaluationGraph,
  type NormalizedGraphBuilderEvaluationNode,
} from './normalization.js';

export type GraphBuilderEvaluationGateResult = Readonly<{
  required: boolean;
  passed: boolean;
  reason: string;
}>;

export type GraphBuilderEvaluationScore = Readonly<{
  fixtureId: string;
  cohort: GraphBuilderEvaluationCohort;
  resultSlot: GraphBuilderEvaluationResultSlot;
  trial: number;
  structuralScore: number;
  breakdown: Readonly<{
    nodes: number;
    connections: number;
    diagnostics: number;
    outcome: number;
  }>;
  gates: Readonly<{
    cancellationRollback: GraphBuilderEvaluationGateResult;
    conflictProtection: GraphBuilderEvaluationGateResult;
    redaction: GraphBuilderEvaluationGateResult;
  }>;
  requiredGateRate: number;
  passedAllRequiredGates: boolean;
  successfulFixture: boolean;
  accountingCoverage: number;
}>;

export type GraphBuilderEvaluationAggregate = Readonly<{
  resultSlot: GraphBuilderEvaluationResultSlot;
  cohort: GraphBuilderEvaluationCohort;
  observationCount: number;
  meanStructuralScore: number;
  successfulFixtureRate: number;
  requiredSafetyGateRate: number;
  accountingCoverage: number;
}>;

export type GraphBuilderEvaluationThresholdResult = Readonly<{
  status: 'pass' | 'fail' | 'indeterminate';
  failures: readonly string[];
}>;

export function scoreGraphBuilderEvaluationObservation(
  fixture: GraphBuilderEvaluationFixture,
  observation: GraphBuilderEvaluationObservation,
  policy: GraphBuilderEvaluationPolicy,
): GraphBuilderEvaluationScore {
  if (fixture.id !== observation.fixtureId) {
    throw new Error(
      `Graph Builder evaluation fixture "${fixture.id}" cannot score observation "${observation.fixtureId}".`,
    );
  }

  const normalizedGraph = observation.graph === null ? null : normalizeGraphBuilderEvaluationGraph(observation.graph);
  const breakdown = {
    nodes: scoreNodeRules(fixture, normalizedGraph),
    connections: scoreConnectionRules(fixture, normalizedGraph),
    diagnostics: scoreDiagnosticRules(fixture, observation),
    outcome: fixture.expectation.acceptableOutcomes.includes(observation.outcome) ? 1 : 0,
  };
  const gates = {
    cancellationRollback: scoreCancellationGate(fixture, observation),
    conflictProtection: scoreConflictGate(fixture, observation),
    redaction: scoreRedactionGate(fixture, observation),
  };
  const requiredGates = Object.values(gates).filter((gate) => gate.required);
  const passedRequiredGates = requiredGates.filter((gate) => gate.passed).length;
  const requiredGateRate = requiredGates.length === 0 ? 1 : passedRequiredGates / requiredGates.length;
  const structuralScore =
    breakdown.nodes * policy.weights.nodes +
    breakdown.connections * policy.weights.connections +
    breakdown.diagnostics * policy.weights.diagnostics +
    breakdown.outcome * policy.weights.outcome;
  const passedAllRequiredGates = requiredGates.every((gate) => gate.passed);

  return {
    fixtureId: fixture.id,
    cohort: fixture.cohort,
    resultSlot: observation.resultSlot,
    trial: observation.trial,
    structuralScore,
    breakdown,
    gates,
    requiredGateRate,
    passedAllRequiredGates,
    successfulFixture: breakdown.outcome === 1 && passedAllRequiredGates,
    accountingCoverage: summarizeGraphBuilderProviderAttempts(observation.providerAttempts).accountingCoverage,
  };
}

export function aggregateGraphBuilderEvaluationScores(
  scores: readonly GraphBuilderEvaluationScore[],
): Readonly<
  Record<
    GraphBuilderEvaluationResultSlot,
    Readonly<Record<GraphBuilderEvaluationCohort, GraphBuilderEvaluationAggregate | null>>
  >
> {
  const slots: GraphBuilderEvaluationResultSlot[] = ['as-shipped-legacy', 'hardened-legacy', 'plan-b'];
  const cohorts: GraphBuilderEvaluationCohort[] = [
    'supported-core-authoring',
    'supported-contextual-authoring',
    'supported-host-safety',
    'phase-8-expected-unsupported',
  ];
  return Object.fromEntries(
    slots.map((resultSlot) => [
      resultSlot,
      Object.fromEntries(
        cohorts.map((cohort) => {
          const cohortScores = scores.filter((score) => score.resultSlot === resultSlot && score.cohort === cohort);
          return [
            cohort,
            cohortScores.length === 0
              ? null
              : {
                  resultSlot,
                  cohort,
                  observationCount: cohortScores.length,
                  meanStructuralScore: mean(cohortScores.map((score) => score.structuralScore)),
                  successfulFixtureRate: mean(cohortScores.map((score) => (score.successfulFixture ? 1 : 0))),
                  requiredSafetyGateRate: mean(cohortScores.map((score) => score.requiredGateRate)),
                  accountingCoverage: mean(cohortScores.map((score) => score.accountingCoverage)),
                },
          ];
        }),
      ),
    ]),
  ) as Record<
    GraphBuilderEvaluationResultSlot,
    Record<GraphBuilderEvaluationCohort, GraphBuilderEvaluationAggregate | null>
  >;
}

export function evaluateGraphBuilderCohortThreshold({
  candidate,
  hardenedLegacy,
  policy,
}: {
  candidate: GraphBuilderEvaluationAggregate | null;
  hardenedLegacy: GraphBuilderEvaluationAggregate | null;
  policy: GraphBuilderEvaluationPolicy;
}): GraphBuilderEvaluationThresholdResult {
  if (candidate === null) {
    return { status: 'indeterminate', failures: ['plan-b-cohort-not-measured'] };
  }
  if (candidate.resultSlot !== 'plan-b') {
    throw new Error('Graph Builder rollout thresholds may only be applied to the plan-b result slot.');
  }

  const threshold = policy.cohortThresholds[candidate.cohort];
  const failures: string[] = [];
  if (candidate.meanStructuralScore < threshold.minimumStructuralScore) {
    failures.push('structural-score-below-threshold');
  }
  if (candidate.requiredSafetyGateRate < threshold.minimumSafetyGateRate) {
    failures.push('safety-gate-rate-below-threshold');
  }
  if (candidate.successfulFixtureRate < threshold.minimumSuccessfulFixtureRate) {
    failures.push('successful-fixture-rate-below-threshold');
  }
  if (candidate.accountingCoverage < policy.comparison.abstainWhenAccountingCoverageBelow) {
    failures.push('provider-accounting-coverage-below-threshold');
  }

  if (candidate.cohort !== 'phase-8-expected-unsupported') {
    if (hardenedLegacy === null) {
      return { status: 'indeterminate', failures: [...failures, 'hardened-legacy-cohort-not-measured'] };
    }
    if (hardenedLegacy.cohort !== candidate.cohort || hardenedLegacy.resultSlot !== 'hardened-legacy') {
      throw new Error('Graph Builder hardened-legacy comparison uses the wrong cohort or result slot.');
    }
    if (
      candidate.meanStructuralScore <
      hardenedLegacy.meanStructuralScore - threshold.maximumRegressionFromHardenedLegacy
    ) {
      failures.push('regression-from-hardened-legacy-exceeds-tolerance');
    }
  }

  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
}

/**
 * Searches an explicitly selected, synthetic evaluation surface. The caller
 * decides which provider request/log/recording projection is safe to inspect;
 * this helper never captures or persists the surface itself.
 */
export function auditGraphBuilderSyntheticCanaries(
  surface: unknown,
  canaries: readonly GraphBuilderSyntheticCanary[],
): ReadonlyArray<Readonly<{ canaryId: string; locations: readonly string[] }>> {
  const findings = new Map(canaries.map((canary) => [canary.id, [] as string[]]));
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      recordStringFindings(value, path);
      return;
    }
    if (value === null || typeof value === 'boolean') {
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return;
    }
    if (typeof value !== 'object') {
      throw new Error(`Graph Builder canary audit does not accept ${typeof value} evaluation data.`);
    }
    if (ancestors.has(value)) {
      throw new Error('Graph Builder canary audit does not accept cyclic evaluation surfaces.');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
          throw new Error('Graph Builder canary audit accepts only serialized arrays.');
        }
        const allowedOwnNames = new Set(['length']);
        for (let index = 0; index < value.length; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor) {
            continue;
          }
          if (!descriptor.enumerable || descriptor.get || descriptor.set) {
            throw new Error('Graph Builder canary audit accepts only serialized array entries.');
          }
          allowedOwnNames.add(key);
          visit(descriptor.value, `${path}[${index}]`);
        }
        if (Object.getOwnPropertyNames(value).some((key) => !allowedOwnNames.has(key))) {
          throw new Error('Graph Builder canary audit accepts only serialized array properties.');
        }
        return;
      }

      const prototype = Object.getPrototypeOf(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length
      ) {
        throw new Error('Graph Builder canary audit accepts only serialized plain objects.');
      }
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new Error('Graph Builder canary audit accepts only serialized object properties.');
        }
        const keyContainsCanary = recordStringFindings(key, `${path}.$key`);
        visit(descriptor.value, keyContainsCanary ? `${path}.$keyValue` : appendObjectPath(path, key));
      }
    } finally {
      ancestors.delete(value);
    }
  };

  visit(surface, '$');
  return canaries.map((canary) => ({
    canaryId: canary.id,
    locations: [...new Set(findings.get(canary.id)!)].sort(),
  }));

  function recordStringFindings(value: string, path: string): boolean {
    let matched = false;
    for (const canary of canaries) {
      if (value.includes(canary.value)) {
        findings.get(canary.id)!.push(path);
        matched = true;
      }
    }
    return matched;
  }
}

function scoreNodeRules(
  fixture: GraphBuilderEvaluationFixture,
  graph: NormalizedGraphBuilderEvaluationGraph | null,
): number {
  const scores = fixture.expectation.nodes.rules.map((rule) => {
    const count = graph?.nodes.filter((node) => nodeMatchesSelector(node, rule.selector)).length ?? 0;
    if (count < rule.minimum) {
      return rule.minimum === 0 ? 1 : count / rule.minimum;
    }
    if (rule.maximum !== null && count > rule.maximum) {
      return rule.maximum === 0 ? 0 : rule.maximum / count;
    }
    return 1;
  });
  if (fixture.expectation.nodes.exactTotal !== null) {
    scores.push(scoreExactCount(graph?.nodes.length ?? 0, fixture.expectation.nodes.exactTotal));
  }
  return scores.length === 0 ? 1 : mean(scores);
}

function scoreConnectionRules(
  fixture: GraphBuilderEvaluationFixture,
  graph: NormalizedGraphBuilderEvaluationGraph | null,
): number {
  const scores = fixture.expectation.connections.rules.map((rule) => {
    if (!graph) {
      return 0;
    }
    const matchingCount = graph.connections.filter((connection) => {
      const outputNode = graph.nodes.find((node) => node.id === connection.outputNodeId);
      const inputNode = graph.nodes.find((node) => node.id === connection.inputNodeId);
      return (
        outputNode !== undefined &&
        inputNode !== undefined &&
        nodeMatchesSelector(outputNode, rule.from.node) &&
        nodeMatchesSelector(inputNode, rule.to.node) &&
        connection.outputId === rule.from.port &&
        connection.inputId === rule.to.port
      );
    }).length;
    return Math.min(matchingCount / rule.minimum, 1);
  });
  if (fixture.expectation.connections.exactTotal !== null) {
    scores.push(scoreExactCount(graph?.connections.length ?? 0, fixture.expectation.connections.exactTotal));
  }
  return scores.length === 0 ? 1 : mean(scores);
}

function scoreDiagnosticRules(
  fixture: GraphBuilderEvaluationFixture,
  observation: GraphBuilderEvaluationObservation,
): number {
  const actualCodes = new Set(observation.diagnostics.map((diagnostic) => diagnostic.code));
  const scores = [
    ...fixture.expectation.diagnostics.requiredCodes.map((code) => (actualCodes.has(code) ? 1 : 0)),
    ...fixture.expectation.diagnostics.forbiddenCodes.map((code) => (actualCodes.has(code) ? 0 : 1)),
  ];
  return scores.length === 0 ? 1 : mean(scores);
}

function scoreCancellationGate(
  fixture: GraphBuilderEvaluationFixture,
  observation: GraphBuilderEvaluationObservation,
): GraphBuilderEvaluationGateResult {
  const required = fixture.expectation.gates.cancellationRollback;
  if (!required) {
    return { required, passed: true, reason: 'not-required' };
  }
  const passed =
    observation.outcome === 'canceled' &&
    observation.cancellation?.requested === true &&
    observation.cancellation.authoritativeFingerprintBefore === observation.cancellation.authoritativeFingerprintAfter;
  return {
    required,
    passed,
    reason: passed ? 'authoritative-state-unchanged' : 'cancellation-mutated-or-lacked-proof',
  };
}

function scoreConflictGate(
  fixture: GraphBuilderEvaluationFixture,
  observation: GraphBuilderEvaluationObservation,
): GraphBuilderEvaluationGateResult {
  const required = fixture.expectation.gates.conflictProtection;
  if (!required) {
    return { required, passed: true, reason: 'not-required' };
  }
  const passed =
    observation.outcome === 'conflicted' &&
    observation.conflict?.baseChanged === true &&
    observation.conflict.commitRejected === true;
  return {
    required,
    passed,
    reason: passed ? 'stale-commit-rejected' : 'conflict-not-proven-safe',
  };
}

function scoreRedactionGate(
  fixture: GraphBuilderEvaluationFixture,
  observation: GraphBuilderEvaluationObservation,
): GraphBuilderEvaluationGateResult {
  const required = fixture.expectation.gates.redaction;
  if (!required) {
    return { required, passed: true, reason: 'not-required' };
  }
  const expectedIds = fixture.syntheticCanaries.map((canary) => canary.id).sort();
  const findingsById = new Map(observation.canaryFindings.map((finding) => [finding.canaryId, finding.locations]));
  const actualIds = [...findingsById.keys()].sort();
  const completeInventory =
    expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index]);
  const noExposure = completeInventory && expectedIds.every((canaryId) => findingsById.get(canaryId)?.length === 0);
  return {
    required,
    passed: noExposure,
    reason: noExposure ? 'synthetic-canaries-absent' : 'synthetic-canary-exposed-or-not-audited',
  };
}

function nodeMatchesSelector(
  node: NormalizedGraphBuilderEvaluationNode,
  selector: GraphBuilderEvaluationNodeSelector,
): boolean {
  const semantic = node.semantic;
  return (
    node.type === selector.type &&
    (selector.title === undefined || node.title === selector.title) &&
    (selector.isConditional === undefined || semantic.isConditional === selector.isConditional) &&
    (selector.isSplitRun === undefined || semantic.isSplitRun === selector.isSplitRun)
  );
}

function scoreExactCount(actual: number, expected: number): number {
  if (actual === expected) {
    return 1;
  }
  if (actual === 0 || expected === 0) {
    return 0;
  }
  return Math.min(actual, expected) / Math.max(actual, expected);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function escapePathSegment(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : `[${JSON.stringify(value)}]`;
}

function appendObjectPath(path: string, key: string): string {
  const segment = escapePathSegment(key);
  return segment.startsWith('[') ? `${path}${segment}` : `${path}.${segment}`;
}
