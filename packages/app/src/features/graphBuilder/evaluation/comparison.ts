import {
  graphBuilderEvaluationCohortSchema,
  parseGraphBuilderDevelopmentFixtureSet,
  parseGraphBuilderEvaluationPolicy,
  type GraphBuilderDevelopmentFixtureSet,
  type GraphBuilderEvaluationCohort,
  type GraphBuilderEvaluationPolicy,
} from './contracts.js';
import { checkedGraphBuilderDevelopmentFixtures, checkedGraphBuilderEvaluationPolicy } from './assets.js';
import {
  runGraphBuilderDevelopmentEvaluation,
  type GraphBuilderDevelopmentEvaluationRun,
  type GraphBuilderEvaluationAdapter,
} from './harness.js';
import { evaluateGraphBuilderCohortThreshold, type GraphBuilderEvaluationThresholdResult } from './scoring.js';

export type RunGraphBuilderDevelopmentComparisonOptions = Readonly<{
  fixtureIds?: readonly string[];
  fixtureSet?: Readonly<GraphBuilderDevelopmentFixtureSet>;
  hardenedLegacyAdapter: GraphBuilderEvaluationAdapter;
  planBAdapter: GraphBuilderEvaluationAdapter;
  policy?: Readonly<GraphBuilderEvaluationPolicy>;
  signal?: AbortSignal;
  trialsPerFixture?: number;
}>;

export type GraphBuilderDevelopmentComparison = Readonly<{
  hardenedLegacy: GraphBuilderDevelopmentEvaluationRun;
  planB: GraphBuilderDevelopmentEvaluationRun;
  thresholds: Readonly<Record<GraphBuilderEvaluationCohort, GraphBuilderEvaluationThresholdResult>>;
}>;

/**
 * Runs both currently selectable implementations over fresh copies of the
 * same checked fixtures, then applies the frozen cohort thresholds. Each
 * adapter remains singly authoritative for its own materialization.
 */
export async function runGraphBuilderDevelopmentComparison(
  options: RunGraphBuilderDevelopmentComparisonOptions,
): Promise<GraphBuilderDevelopmentComparison> {
  const fixtureSet = options.fixtureSet
    ? parseGraphBuilderDevelopmentFixtureSet(options.fixtureSet)
    : checkedGraphBuilderDevelopmentFixtures;
  const policy = options.policy
    ? parseGraphBuilderEvaluationPolicy(options.policy)
    : checkedGraphBuilderEvaluationPolicy;
  const sharedOptions = {
    fixtureSet,
    policy,
    fixtureIds: options.fixtureIds,
    trialsPerFixture: options.trialsPerFixture,
    signal: options.signal,
  };
  const hardenedLegacy = await runGraphBuilderDevelopmentEvaluation({
    ...sharedOptions,
    adapter: options.hardenedLegacyAdapter,
    resultSlot: 'hardened-legacy',
  });
  const planB = await runGraphBuilderDevelopmentEvaluation({
    ...sharedOptions,
    adapter: options.planBAdapter,
    resultSlot: 'plan-b',
  });

  return {
    hardenedLegacy,
    planB,
    thresholds: Object.fromEntries(
      graphBuilderEvaluationCohortSchema.options.map((cohort) => [
        cohort,
        evaluateGraphBuilderCohortThreshold({
          candidate: planB.aggregates['plan-b'][cohort],
          hardenedLegacy: hardenedLegacy.aggregates['hardened-legacy'][cohort],
          policy,
        }),
      ]),
    ) as Record<GraphBuilderEvaluationCohort, GraphBuilderEvaluationThresholdResult>,
  };
}
