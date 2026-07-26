import { z } from 'zod';

export const GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION = 1 as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const nodeTypeSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim() === value, 'Node type must not have surrounding whitespace');
const boundedTextSchema = z.string().min(1).max(20_000);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const graphBuilderEvaluationResultSlotSchema = z.enum(['as-shipped-legacy', 'hardened-legacy', 'plan-b']);
export type GraphBuilderEvaluationResultSlot = z.infer<typeof graphBuilderEvaluationResultSlotSchema>;

export const graphBuilderEvaluationCohortSchema = z.enum([
  'supported-core-authoring',
  'supported-contextual-authoring',
  'supported-host-safety',
  'phase-8-expected-unsupported',
]);
export type GraphBuilderEvaluationCohort = z.infer<typeof graphBuilderEvaluationCohortSchema>;

export const graphBuilderSyntheticProjectFixtureIdSchema = z.enum([
  'empty-active-graph',
  'connected-text',
  'connected-text-with-unrelated-branch',
  'conditional-port-candidate',
  'loop-with-directed-cycle',
  'async-branch-with-output-nearby',
  'data-bus-with-nearby-space',
  'synthetic-portable-plugin-installed',
  'referenced-graph-alias',
  'linked-prefab-instance',
  'project-with-helper-graph',
  'graph-text-prompt-injection',
  'synthetic-secret-canaries',
  'multi-graph-caller',
  'multi-graph-project',
]);
export type GraphBuilderSyntheticProjectFixtureId = z.infer<typeof graphBuilderSyntheticProjectFixtureIdSchema>;

export const graphBuilderEvaluationOutcomeSchema = z.enum([
  'success',
  'clarified',
  'unsupported',
  'canceled',
  'conflicted',
  'failed',
]);
export type GraphBuilderEvaluationOutcome = z.infer<typeof graphBuilderEvaluationOutcomeSchema>;

const nodeSelectorSchema = z.strictObject({
  type: nodeTypeSchema,
  title: z.string().min(1).max(500).optional(),
  isConditional: z.boolean().optional(),
  isSplitRun: z.boolean().optional(),
});
export type GraphBuilderEvaluationNodeSelector = z.infer<typeof nodeSelectorSchema>;

const nodeRuleSchema = z
  .strictObject({
    selector: nodeSelectorSchema,
    minimum: z.number().int().min(0).default(1),
    maximum: z.number().int().min(0).nullable().default(null),
  })
  .refine((value) => value.maximum === null || value.maximum >= value.minimum, {
    message: 'Node-rule maximum must be greater than or equal to its minimum',
    path: ['maximum'],
  });
export type GraphBuilderEvaluationNodeRule = z.infer<typeof nodeRuleSchema>;

const connectionEndpointRuleSchema = z.strictObject({
  node: nodeSelectorSchema,
  port: z.string().min(1).max(500),
});

const connectionRuleSchema = z.strictObject({
  from: connectionEndpointRuleSchema,
  to: connectionEndpointRuleSchema,
  minimum: z.number().int().min(1).default(1),
});
export type GraphBuilderEvaluationConnectionRule = z.infer<typeof connectionRuleSchema>;

export const graphBuilderEvaluationExpectationSchema = z.strictObject({
  acceptableOutcomes: z.array(graphBuilderEvaluationOutcomeSchema).min(1),
  nodes: z.strictObject({
    rules: z.array(nodeRuleSchema),
    exactTotal: z.number().int().min(0).nullable(),
  }),
  connections: z.strictObject({
    rules: z.array(connectionRuleSchema),
    exactTotal: z.number().int().min(0).nullable(),
  }),
  diagnostics: z.strictObject({
    requiredCodes: z.array(nodeTypeSchema),
    forbiddenCodes: z.array(nodeTypeSchema),
  }),
  gates: z.strictObject({
    cancellationRollback: z.boolean(),
    conflictProtection: z.boolean(),
    redaction: z.boolean(),
  }),
});
export type GraphBuilderEvaluationExpectation = z.infer<typeof graphBuilderEvaluationExpectationSchema>;

const syntheticCanarySchema = z.strictObject({
  id: identifierSchema,
  source: z.enum(['configured-credential', 'classified-setting', 'opaque-plugin-field']),
  value: z.string().min(24).max(500).startsWith('RIVET_SYNTHETIC_CANARY_'),
});
export type GraphBuilderSyntheticCanary = z.infer<typeof syntheticCanarySchema>;

export const graphBuilderEvaluationFixtureSchema = z
  .strictObject({
    id: identifierSchema,
    cohort: graphBuilderEvaluationCohortSchema,
    capability: identifierSchema,
    request: boundedTextSchema,
    syntheticProjectFixtureId: graphBuilderSyntheticProjectFixtureIdSchema,
    expectation: graphBuilderEvaluationExpectationSchema,
    syntheticCanaries: z.array(syntheticCanarySchema).default([]),
  })
  .superRefine((fixture, context) => {
    const canaryIds = new Set<string>();
    for (const [index, canary] of fixture.syntheticCanaries.entries()) {
      if (canaryIds.has(canary.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate synthetic canary ID "${canary.id}"`,
          path: ['syntheticCanaries', index, 'id'],
        });
      }
      canaryIds.add(canary.id);
    }

    if (fixture.expectation.gates.redaction !== fixture.syntheticCanaries.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Redaction-gate fixtures must declare synthetic canaries, and only those fixtures may declare them',
        path: ['expectation', 'gates', 'redaction'],
      });
    }

    if (
      fixture.cohort === 'phase-8-expected-unsupported' &&
      (fixture.expectation.acceptableOutcomes.length !== 1 ||
        fixture.expectation.acceptableOutcomes[0] !== 'unsupported')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Phase-8 fixtures must require a truthful unsupported outcome',
        path: ['expectation', 'acceptableOutcomes'],
      });
    }
  });
export type GraphBuilderEvaluationFixture = z.infer<typeof graphBuilderEvaluationFixtureSchema>;

export const graphBuilderDevelopmentFixtureSetSchema = z
  .strictObject({
    schemaVersion: z.literal(GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION),
    fixtureSetVersion: identifierSchema,
    fixtures: z.array(graphBuilderEvaluationFixtureSchema).min(1),
  })
  .superRefine((fixtureSet, context) => {
    const fixtureIds = new Set<string>();
    for (const [index, fixture] of fixtureSet.fixtures.entries()) {
      if (fixtureIds.has(fixture.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate evaluation fixture ID "${fixture.id}"`,
          path: ['fixtures', index, 'id'],
        });
      }
      fixtureIds.add(fixture.id);
    }

    for (const cohort of graphBuilderEvaluationCohortSchema.options) {
      if (!fixtureSet.fixtures.some((fixture) => fixture.cohort === cohort)) {
        context.addIssue({
          code: 'custom',
          message: `Evaluation fixture set does not cover cohort "${cohort}"`,
          path: ['fixtures'],
        });
      }
    }
  });
export type GraphBuilderDevelopmentFixtureSet = z.infer<typeof graphBuilderDevelopmentFixtureSetSchema>;

const cohortThresholdSchema = z.strictObject({
  minimumStructuralScore: z.number().min(0).max(1),
  minimumSafetyGateRate: z.number().min(0).max(1),
  minimumSuccessfulFixtureRate: z.number().min(0).max(1),
  maximumRegressionFromHardenedLegacy: z.number().min(0).max(1),
});

export const graphBuilderEvaluationPolicySchema = z.strictObject({
  schemaVersion: z.literal(GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION),
  policyVersion: identifierSchema,
  frozenOn: z.string().date(),
  resultSlots: z.tuple([z.literal('as-shipped-legacy'), z.literal('hardened-legacy'), z.literal('plan-b')]),
  weights: z
    .strictObject({
      nodes: z.number().min(0).max(1),
      connections: z.number().min(0).max(1),
      diagnostics: z.number().min(0).max(1),
      outcome: z.number().min(0).max(1),
    })
    .refine(
      (weights) =>
        Math.abs(weights.nodes + weights.connections + weights.diagnostics + weights.outcome - 1) < Number.EPSILON * 16,
      'Evaluation weights must sum to exactly 1',
    ),
  cohortThresholds: z.record(graphBuilderEvaluationCohortSchema, cohortThresholdSchema),
  trials: z.strictObject({
    deterministicMockAttemptsPerFixture: z.number().int().min(1),
    nondeterministicProviderAttemptsPerFixture: z.number().int().min(2),
    minimumHumanRatingsPerFixture: z.number().int().min(2),
  }),
  comparison: z.strictObject({
    tieTolerance: z.number().min(0).max(0.1),
    abstainWhenAccountingCoverageBelow: z.number().min(0).max(1),
    requireAllHardSafetyGates: z.literal(true),
  }),
  rolloutStopConditions: z.array(identifierSchema).min(1),
});
export type GraphBuilderEvaluationPolicy = z.infer<typeof graphBuilderEvaluationPolicySchema>;

export const graphBuilderHiddenHoldoutContractSchema = z.strictObject({
  schemaVersion: z.literal(GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION),
  contractVersion: identifierSchema,
  suiteVersion: identifierSchema,
  protectedManifestSha256: sha256Schema.nullable(),
  status: z.enum(['placeholder', 'bound']),
  inputsIncluded: z.literal(false),
  aggregateResultsOnly: z.literal(true),
  ownership: z.literal('external-protected-release-evaluation'),
});
export type GraphBuilderHiddenHoldoutContract = z.infer<typeof graphBuilderHiddenHoldoutContractSchema>;

export const graphBuilderEvaluationAssetManifestSchema = z.strictObject({
  schemaVersion: z.literal(GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION),
  manifestVersion: identifierSchema,
  fixtureCount: z.number().int().min(1),
  assets: z
    .array(
      z.strictObject({
        kind: z.enum(['policy', 'development-fixtures', 'hidden-holdout-contract']),
        path: z.string().min(1).max(500),
        sha256: sha256Schema,
      }),
    )
    .length(3),
});
export type GraphBuilderEvaluationAssetManifest = z.infer<typeof graphBuilderEvaluationAssetManifestSchema>;

export const graphBuilderProviderUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    missing: z.array(z.enum(['input-tokens', 'output-tokens', 'total-tokens', 'pricing'])),
  })
  .superRefine((usage, context) => {
    const values = [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.costUsd];
    const missing = [
      usage.inputTokens === null ? 'input-tokens' : undefined,
      usage.outputTokens === null ? 'output-tokens' : undefined,
      usage.totalTokens === null ? 'total-tokens' : undefined,
      usage.costUsd === null ? 'pricing' : undefined,
    ].filter((value): value is NonNullable<typeof value> => value !== undefined);
    const expectedCompleteness = values.every((value) => value === null)
      ? 'unknown'
      : values.every((value) => value !== null)
        ? 'complete'
        : 'partial';

    if (usage.completeness !== expectedCompleteness) {
      context.addIssue({
        code: 'custom',
        message: `Usage completeness must be "${expectedCompleteness}" for the supplied measurements`,
        path: ['completeness'],
      });
    }
    if (usage.missing.length !== missing.length || usage.missing.some((value, index) => value !== missing[index])) {
      context.addIssue({
        code: 'custom',
        message: `Usage missing fields must be exactly [${missing.join(', ')}] in canonical order`,
        path: ['missing'],
      });
    }
    if (
      usage.inputTokens !== null &&
      usage.outputTokens !== null &&
      usage.totalTokens !== null &&
      usage.inputTokens + usage.outputTokens !== usage.totalTokens
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Total tokens must equal input tokens plus output tokens',
        path: ['totalTokens'],
      });
    }
  });
export type GraphBuilderProviderUsage = z.infer<typeof graphBuilderProviderUsageSchema>;

export const graphBuilderProviderAttemptSchema = z.strictObject({
  attemptId: identifierSchema,
  parentAttemptId: identifierSchema.nullable(),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(500),
  providerVersion: z.string().min(1).max(500).nullable(),
  outcome: z.enum(['success', 'provider-error', 'canceled']),
  requestShapeSha256: sha256Schema,
  durationMs: z.number().finite().nonnegative(),
  usage: graphBuilderProviderUsageSchema,
});
export type GraphBuilderProviderAttempt = z.infer<typeof graphBuilderProviderAttemptSchema>;

const diagnosticObservationSchema = z.strictObject({
  code: nodeTypeSchema,
  severity: z.enum(['info', 'warning', 'error']),
});

const cancellationObservationSchema = z.strictObject({
  requested: z.boolean(),
  authoritativeFingerprintBefore: z.string().min(1),
  authoritativeFingerprintAfter: z.string().min(1),
});

const conflictObservationSchema = z.strictObject({
  baseChanged: z.boolean(),
  commitRejected: z.boolean(),
});

const canaryFindingSchema = z.strictObject({
  canaryId: identifierSchema,
  locations: z.array(z.string().min(1).max(2_000)),
});

export const graphBuilderEvaluationObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(GRAPH_BUILDER_EVALUATION_SCHEMA_VERSION),
    fixtureId: identifierSchema,
    resultSlot: graphBuilderEvaluationResultSlotSchema,
    trial: z.number().int().min(1),
    outcome: graphBuilderEvaluationOutcomeSchema,
    graph: z.unknown().nullable(),
    diagnostics: z.array(diagnosticObservationSchema),
    cancellation: cancellationObservationSchema.nullable(),
    conflict: conflictObservationSchema.nullable(),
    canaryFindings: z.array(canaryFindingSchema),
    providerAttempts: z.array(graphBuilderProviderAttemptSchema),
  })
  .superRefine((observation, context) => {
    const attemptIds = new Set<string>();
    for (const [index, attempt] of observation.providerAttempts.entries()) {
      if (attemptIds.has(attempt.attemptId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate physical provider attempt ID "${attempt.attemptId}"`,
          path: ['providerAttempts', index, 'attemptId'],
        });
      }
      attemptIds.add(attempt.attemptId);
    }
    for (const [index, attempt] of observation.providerAttempts.entries()) {
      if (attempt.parentAttemptId !== null && !attemptIds.has(attempt.parentAttemptId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown parent provider attempt "${attempt.parentAttemptId}"`,
          path: ['providerAttempts', index, 'parentAttemptId'],
        });
      }
    }
    const parentByAttemptId = new Map(
      observation.providerAttempts.map((attempt) => [attempt.attemptId, attempt.parentAttemptId] as const),
    );
    for (const [index, attempt] of observation.providerAttempts.entries()) {
      const ancestors = new Set<string>();
      let currentAttemptId: string | null = attempt.attemptId;
      while (currentAttemptId !== null) {
        if (ancestors.has(currentAttemptId)) {
          context.addIssue({
            code: 'custom',
            message: `Provider attempt ancestry contains a cycle at "${currentAttemptId}"`,
            path: ['providerAttempts', index, 'parentAttemptId'],
          });
          break;
        }
        ancestors.add(currentAttemptId);
        currentAttemptId = parentByAttemptId.get(currentAttemptId) ?? null;
      }
    }
  });
export type GraphBuilderEvaluationObservation = z.infer<typeof graphBuilderEvaluationObservationSchema>;

export type GraphBuilderProviderAccountingSummary = Readonly<{
  attemptCount: number;
  completeAttemptCount: number;
  accountingCoverage: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
}>;

export function parseGraphBuilderEvaluationPolicy(value: unknown): Readonly<GraphBuilderEvaluationPolicy> {
  return deepFreeze(graphBuilderEvaluationPolicySchema.parse(value));
}

export function parseGraphBuilderDevelopmentFixtureSet(value: unknown): Readonly<GraphBuilderDevelopmentFixtureSet> {
  return deepFreeze(graphBuilderDevelopmentFixtureSetSchema.parse(value));
}

export function parseGraphBuilderHiddenHoldoutContract(value: unknown): Readonly<GraphBuilderHiddenHoldoutContract> {
  return deepFreeze(graphBuilderHiddenHoldoutContractSchema.parse(value));
}

export function parseGraphBuilderEvaluationAssetManifest(
  value: unknown,
): Readonly<GraphBuilderEvaluationAssetManifest> {
  return deepFreeze(graphBuilderEvaluationAssetManifestSchema.parse(value));
}

export function parseGraphBuilderEvaluationObservation(value: unknown): GraphBuilderEvaluationObservation {
  return graphBuilderEvaluationObservationSchema.parse(value);
}

export function summarizeGraphBuilderProviderAttempts(
  attempts: readonly GraphBuilderProviderAttempt[],
): GraphBuilderProviderAccountingSummary {
  if (attempts.length === 0) {
    return {
      attemptCount: 0,
      completeAttemptCount: 0,
      accountingCoverage: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      completeness: 'unknown',
    };
  }

  const parsedAttempts = attempts.map((attempt) => graphBuilderProviderAttemptSchema.parse(attempt));
  const completeAttemptCount = parsedAttempts.filter((attempt) => attempt.usage.completeness === 'complete').length;
  const allUnknown = parsedAttempts.every((attempt) => attempt.usage.completeness === 'unknown');

  const sumIfComplete = (select: (usage: GraphBuilderProviderUsage) => number | null): number | null => {
    const values = parsedAttempts.map((attempt) => select(attempt.usage));
    return values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };

  return {
    attemptCount: parsedAttempts.length,
    completeAttemptCount,
    accountingCoverage: completeAttemptCount / parsedAttempts.length,
    inputTokens: sumIfComplete((usage) => usage.inputTokens),
    outputTokens: sumIfComplete((usage) => usage.outputTokens),
    totalTokens: sumIfComplete((usage) => usage.totalTokens),
    costUsd: sumIfComplete((usage) => usage.costUsd),
    completeness: completeAttemptCount === parsedAttempts.length ? 'complete' : allUnknown ? 'unknown' : 'partial',
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
