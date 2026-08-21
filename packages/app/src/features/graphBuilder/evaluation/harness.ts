import type { NodeGraph } from '@valerypopoff/rivet2-core';
import { runEvaluationWorkPool } from '@valerypopoff/rivet2-evaluations';
import { cloneDeep } from 'lodash-es';
import { canonicalGraphBuilderAuthoringStringify } from '../graphBuilderDomain.js';
import {
  GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION,
  graphBuilderEvaluationResultSlotSchema,
  parseGraphBuilderEvaluationObservation,
  parseGraphBuilderDevelopmentFixtureSet,
  parseGraphBuilderEvaluationPolicy,
  type GraphBuilderDevelopmentFixtureSet,
  type GraphBuilderEvaluationFixture,
  type GraphBuilderEvaluationObservation,
  type GraphBuilderEvaluationOutcome,
  type GraphBuilderEvaluationPolicy,
  type GraphBuilderEvaluationResultSlot,
  type GraphBuilderProviderAttempt,
} from './contracts.js';
import { checkedGraphBuilderDevelopmentFixtures, checkedGraphBuilderEvaluationPolicy } from './assets.js';
import {
  aggregateGraphBuilderEvaluationScores,
  auditGraphBuilderSyntheticCanaries,
  scoreGraphBuilderEvaluationObservation,
  type GraphBuilderEvaluationScore,
} from './scoring.js';
import { materializeGraphBuilderEvaluationFixture, type GraphBuilderSyntheticProject } from './syntheticProjects.js';

type EvaluationDiagnostic = GraphBuilderEvaluationObservation['diagnostics'][number];
type EvaluationConflict = NonNullable<GraphBuilderEvaluationObservation['conflict']>;

export type GraphBuilderEvaluationAuditSurfaceKind = 'source-input' | 'provider-wire' | 'log' | 'recording';

export type GraphBuilderEvaluationAuditSurface = Readonly<{
  kind: GraphBuilderEvaluationAuditSurfaceKind;
  /**
   * Stable, non-secret label such as "provider-request" or "recording". The
   * surface itself is inspected transiently and is never stored in the result.
   */
  label: string;
  value: unknown;
}>;

export type GraphBuilderEvaluationAdapterResult = Readonly<{
  outcome: GraphBuilderEvaluationOutcome;
  /**
   * Omit to score the final active graph in the disposable materialization.
   * Use null for terminal outcomes that intentionally have no candidate graph.
   */
  graph?: NodeGraph | null;
  diagnostics?: readonly EvaluationDiagnostic[];
  cancellationRequested?: boolean;
  conflict?: EvaluationConflict | null;
  providerAttempts?: readonly GraphBuilderProviderAttempt[];
  /**
   * Additional enabled sinks that must be audited for redaction fixtures.
   * Provider-wire coverage is always required and need not be listed here.
   */
  requiredAuditSurfaceKinds?: readonly Extract<GraphBuilderEvaluationAuditSurfaceKind, 'log' | 'recording'>[];
  /**
   * Provider/log/recording projections that may legitimately have crossed the
   * model boundary. Never include the source project or host secret stores.
   */
  auditedSurfaces?: readonly GraphBuilderEvaluationAuditSurface[];
}>;

export type GraphBuilderEvaluationAdapterInput = Readonly<{
  fixture: Readonly<GraphBuilderEvaluationFixture>;
  resultSlot: GraphBuilderEvaluationResultSlot;
  trial: number;
  materialization: GraphBuilderSyntheticProject;
  signal: AbortSignal;
}>;

/**
 * Implementations adapt one concrete Graph Builder mode to the provider-free
 * evaluation harness. The harness owns fixture materialization, observation
 * identity, canary inventory, normalization/scoring, and trial ordering.
 */
export type GraphBuilderEvaluationAdapter = (
  input: GraphBuilderEvaluationAdapterInput,
) => GraphBuilderEvaluationAdapterResult | Promise<GraphBuilderEvaluationAdapterResult>;

export type RunGraphBuilderDevelopmentEvaluationOptions = Readonly<{
  adapter: GraphBuilderEvaluationAdapter;
  resultSlot: GraphBuilderEvaluationResultSlot;
  fixtureSet?: Readonly<GraphBuilderDevelopmentFixtureSet>;
  policy?: Readonly<GraphBuilderEvaluationPolicy>;
  /**
   * Optional public fixture subset. Selection retains checked-suite order and
   * rejects unknown or duplicate IDs.
   */
  fixtureIds?: readonly string[];
  /**
   * Intended for deterministic local fake-provider runs. When omitted, the
   * frozen policy's deterministic attempt count is authoritative.
   */
  trialsPerFixture?: number;
  signal?: AbortSignal;
}>;

export type GraphBuilderDevelopmentEvaluationRun = Readonly<{
  fixtureSetVersion: string;
  policyVersion: string;
  resultSlot: GraphBuilderEvaluationResultSlot;
  observations: readonly GraphBuilderEvaluationObservation[];
  scores: readonly GraphBuilderEvaluationScore[];
  aggregates: ReturnType<typeof aggregateGraphBuilderEvaluationScores>;
}>;

/**
 * Runs the public development suite through the shared evaluation work-pool.
 * This suite intentionally keeps concurrency at one because its fixtures
 * exercise shared authoring/runtime seams, while retaining the common
 * cancellation and deterministic-result-ordering behavior used by product
 * evaluations. It never creates a provider client: all model/session behavior
 * is supplied by the injected adapter, which makes the same runner usable for
 * fake providers, the two legacy result slots, and Plan B.
 */
export async function runGraphBuilderDevelopmentEvaluation(
  options: RunGraphBuilderDevelopmentEvaluationOptions,
): Promise<GraphBuilderDevelopmentEvaluationRun> {
  const fixtureSet = options.fixtureSet
    ? parseGraphBuilderDevelopmentFixtureSet(options.fixtureSet)
    : checkedGraphBuilderDevelopmentFixtures;
  const policy = options.policy
    ? parseGraphBuilderEvaluationPolicy(options.policy)
    : checkedGraphBuilderEvaluationPolicy;
  const resultSlot = graphBuilderEvaluationResultSlotSchema.parse(options.resultSlot);
  const fixtures = selectFixtures(fixtureSet, options.fixtureIds);
  const trialsPerFixture = options.trialsPerFixture ?? policy.trials.deterministicMockAttemptsPerFixture;
  if (!Number.isSafeInteger(trialsPerFixture) || trialsPerFixture <= 0) {
    throw new Error('Graph Builder evaluation trialsPerFixture must be a positive safe integer.');
  }

  const signal = options.signal ?? new AbortController().signal;
  const work = fixtures.flatMap((fixture) =>
    Array.from({ length: trialsPerFixture }, (_, index) => ({ fixture, trial: index + 1 })),
  );
  const scheduledObservations = await runEvaluationWorkPool({
    work,
    concurrency: 1,
    signal,
    execute: ({ fixture, trial }) => runFixtureTrial({
      adapter: options.adapter,
      fixture,
      resultSlot,
      trial,
      signal,
    }),
  });
  signal.throwIfAborted();
  const observations = scheduledObservations.filter(
    (observation): observation is GraphBuilderEvaluationObservation => observation !== undefined,
  );
  if (observations.length !== work.length) {
    throw new Error('Graph Builder evaluation ended before every fixture trial completed.');
  }

  const scores = observations.map((observation) => {
    const fixture = fixtures.find((candidate) => candidate.id === observation.fixtureId);
    if (!fixture) {
      throw new Error(
        `Graph Builder evaluation produced an observation for unknown fixture "${observation.fixtureId}".`,
      );
    }
    return scoreGraphBuilderEvaluationObservation(fixture, observation, policy);
  });

  return {
    fixtureSetVersion: fixtureSet.fixtureSetVersion,
    policyVersion: policy.policyVersion,
    resultSlot,
    observations,
    scores,
    aggregates: aggregateGraphBuilderEvaluationScores(scores),
  };
}

async function runFixtureTrial({
  adapter,
  fixture,
  resultSlot,
  trial,
  signal,
}: {
  adapter: GraphBuilderEvaluationAdapter;
  fixture: Readonly<GraphBuilderEvaluationFixture>;
  resultSlot: GraphBuilderEvaluationResultSlot;
  trial: number;
  signal: AbortSignal;
}): Promise<GraphBuilderEvaluationObservation> {
  const materialization = materializeGraphBuilderEvaluationFixture(fixture);
  const graphBefore = activeGraph(materialization);
  const fingerprintBefore = canonicalGraphBuilderAuthoringStringify(graphBefore);

  let result: GraphBuilderEvaluationAdapterResult;
  let adapterFailed = false;
  try {
    result = await adapter({
      fixture,
      resultSlot,
      trial,
      materialization,
      signal,
    });
  } catch {
    signal.throwIfAborted();
    adapterFailed = true;
    result = {
      outcome: 'failed',
      diagnostics: [{ code: 'evaluation-adapter-error', severity: 'error' }],
    };
  }

  signal.throwIfAborted();
  const graphAfter = activeGraph(materialization);
  const diagnostics = [...(result.diagnostics ?? [])];
  const canaryAudit = buildCanaryInventory(fixture, result.auditedSurfaces, result.requiredAuditSurfaceKinds);
  if (canaryAudit.incomplete) {
    diagnostics.push({ code: 'redaction-audit-incomplete', severity: 'error' });
  }

  const graph = result.graph === null ? null : cloneDeep(result.graph ?? graphAfter);
  const cancellation =
    result.cancellationRequested === undefined && !fixture.expectation.gates.cancellationRollback
      ? null
      : {
          requested: result.cancellationRequested === true,
          authoritativeFingerprintBefore: fingerprintBefore,
          authoritativeFingerprintAfter: canonicalGraphBuilderAuthoringStringify(graphAfter),
        };

  return parseGraphBuilderEvaluationObservation({
    schemaVersion: GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    resultSlot,
    trial,
    outcome: adapterFailed ? 'failed' : result.outcome,
    graph,
    diagnostics,
    cancellation,
    conflict: result.conflict ?? null,
    canaryFindings: canaryAudit.findings,
    providerAttempts: cloneDeep(result.providerAttempts ?? []),
  });
}

function activeGraph(materialization: GraphBuilderSyntheticProject): NodeGraph {
  const graph = materialization.project.graphs[materialization.activeGraphId];
  if (!graph) {
    throw new Error(
      `Synthetic Graph Builder project "${materialization.fixtureId}" has no active graph "${materialization.activeGraphId}".`,
    );
  }
  return graph;
}

function selectFixtures(
  fixtureSet: Readonly<GraphBuilderDevelopmentFixtureSet>,
  fixtureIds: readonly string[] | undefined,
): readonly Readonly<GraphBuilderEvaluationFixture>[] {
  if (fixtureIds === undefined) {
    return fixtureSet.fixtures;
  }

  const selectedIds = new Set<string>();
  for (const fixtureId of fixtureIds) {
    if (selectedIds.has(fixtureId)) {
      throw new Error(`Graph Builder evaluation fixture "${fixtureId}" was selected more than once.`);
    }
    selectedIds.add(fixtureId);
  }
  const knownIds = new Set(fixtureSet.fixtures.map((fixture) => fixture.id));
  const unknownIds = fixtureIds.filter((fixtureId) => !knownIds.has(fixtureId));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown Graph Builder evaluation fixture(s): ${unknownIds.join(', ')}`);
  }

  return fixtureSet.fixtures.filter((fixture) => selectedIds.has(fixture.id));
}

function buildCanaryInventory(
  fixture: Readonly<GraphBuilderEvaluationFixture>,
  surfaces: readonly GraphBuilderEvaluationAuditSurface[] | undefined,
  additionalRequiredKinds: readonly Extract<GraphBuilderEvaluationAuditSurfaceKind, 'log' | 'recording'>[] | undefined,
): {
  findings: GraphBuilderEvaluationObservation['canaryFindings'];
  incomplete: boolean;
} {
  if (fixture.syntheticCanaries.length === 0) {
    return { findings: [], incomplete: false };
  }
  if (!surfaces || surfaces.length === 0) {
    return {
      findings: fixture.syntheticCanaries.map((canary) => ({
        canaryId: canary.id,
        locations: ['$audit.incomplete'],
      })),
      incomplete: true,
    };
  }

  const labels = new Set<string>();
  try {
    const requiredKinds = new Set<GraphBuilderEvaluationAuditSurfaceKind>([
      'provider-wire',
      ...(additionalRequiredKinds ?? []),
    ]);
    if (
      additionalRequiredKinds != null &&
      (new Set(additionalRequiredKinds).size !== additionalRequiredKinds.length ||
        additionalRequiredKinds.some((kind) => kind !== 'log' && kind !== 'recording'))
    ) {
      throw new Error('Invalid Graph Builder evaluation audit-surface requirements.');
    }
    const observedKinds = new Set<GraphBuilderEvaluationAuditSurfaceKind>();
    const locationsByCanary = new Map(fixture.syntheticCanaries.map((canary) => [canary.id, [] as string[]]));
    for (const surface of surfaces) {
      if (
        !['source-input', 'provider-wire', 'log', 'recording'].includes(surface.kind) ||
        surface.label.length === 0 ||
        surface.label.length > 160 ||
        labels.has(surface.label)
      ) {
        throw new Error('Invalid or duplicate Graph Builder evaluation audit-surface label.');
      }
      labels.add(surface.label);
      observedKinds.add(surface.kind);
      const prefix = `$audit[${JSON.stringify(surface.label)}]`;
      for (const finding of auditGraphBuilderSyntheticCanaries(surface.value, fixture.syntheticCanaries)) {
        locationsByCanary
          .get(finding.canaryId)!
          .push(...finding.locations.map((location) => `${prefix}${location.slice(1)}`));
      }
    }
    const incomplete = [...requiredKinds].some((kind) => !observedKinds.has(kind));
    if (incomplete) {
      for (const locations of locationsByCanary.values()) {
        locations.push('$audit.incomplete');
      }
    }
    return {
      findings: fixture.syntheticCanaries.map((canary) => ({
        canaryId: canary.id,
        locations: locationsByCanary.get(canary.id)!.sort(),
      })),
      incomplete,
    };
  } catch {
    return {
      findings: fixture.syntheticCanaries.map((canary) => ({
        canaryId: canary.id,
        locations: ['$audit.incomplete'],
      })),
      incomplete: true,
    };
  }
}
