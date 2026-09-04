import { Router, type Response } from 'express';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import {
  deserializeEvaluationProjectData,
  fingerprintEvaluationDataset,
  normalizeEvaluationLibrary,
  validateEvaluationDataset,
  type EvaluationDatasetSnapshot,
  type EvaluationRunEvent,
  type EvaluationQualityReasonCode,
  type EvaluationQualityStatus,
  type EvaluationRecordingArtifact,
  type EvaluationLibraryMutation,
  type EvaluationRun,
} from '@valerypopoff/rivet2-evaluations';

import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import { validateBody } from '../../middleware/validate.js';
import { getEvaluationStore, getHostedEvaluationCoordinator } from './storage-backend.js';
import {
  EvaluationLibraryConflictError,
  EvaluationLibraryMutationValidationError,
  EvaluationLibraryResourceConflictError,
} from '../../evaluation-runs/store.js';
import {
  notifyEvaluationLibraryChanged,
  openEvaluationLibraryEventStream,
} from './evaluation-library-events.js';
import {
  HostedEvaluationCapacityError,
  HostedEvaluationRetryConflictError,
  HostedEvaluationRunConflictError,
} from '../../evaluation-runs/hosted-coordinator.js';

export const evaluationRunsRouter = Router();
/** Keeps evaluation replay artifacts below the API's broader 100 MiB JSON limit. */
export const MAX_EVALUATION_RECORDING_BYTES = 24 * 1024 * 1024;

function sendHostedEvaluationCapacityError(res: Response, error: HostedEvaluationCapacityError): void {
  res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(429).json({
    error: error.message,
    code: 'evaluation_batch_capacity_exceeded',
    limit: error.limit,
  });
}

const projectSchema = z.object({ projectId: z.string().min(1) }).strict();
const listSchema = projectSchema.extend({
  suiteId: z.string().min(1).optional(),
});
const evaluationExecutionStatusSchema = z.enum(['queued', 'running', 'completed', 'canceled', 'error']);
const evaluationTrialExecutionStatusSchema = z.enum(['completed', 'error', 'canceled']);
const evaluationQualityStatuses = [
  'passed',
  'failed',
  'scored',
  'not-evaluated',
  'unable-to-evaluate',
] as const satisfies readonly EvaluationQualityStatus[];
type Assert<T extends true> = T;
type EvaluationQualityStatusContractIsExhaustive = Assert<
  [Exclude<EvaluationQualityStatus, (typeof evaluationQualityStatuses)[number]>] extends [never] ? true : false
>;
const evaluationQualityStatusSchema = z.enum(evaluationQualityStatuses);

const evaluationQualityReasonCodes = [
  'in-progress',
  'checks-passed',
  'checks-failed',
  'scores-complete',
  'scores-incomplete',
  'benchmark',
  'no-trial-quality-checks',
  'target-error',
  'required-check-error',
  'required-metric-unavailable',
  'thresholds-passed',
  'thresholds-failed',
  'canceled',
  'no-completed-trials',
] as const satisfies readonly EvaluationQualityReasonCode[];
type EvaluationQualityReasonCodeContractIsExhaustive = Assert<
  [Exclude<EvaluationQualityReasonCode, (typeof evaluationQualityReasonCodes)[number]>] extends [never] ? true : false
>;
const evaluationQualityReasonSchema = z
  .object({
    code: z.enum(evaluationQualityReasonCodes),
    message: z.string(),
  })
  .strict();
const evaluationMetricsSchema = z.object({ durationMs: z.number().finite().nonnegative() }).passthrough();
const evaluationTrialSchema = z
  .object({
    id: z.string().min(1),
    caseId: z.string().min(1),
    caseName: z.string(),
    caseIndex: z.number().int().nonnegative(),
    trialIndex: z.number().int().nonnegative(),
    executionStatus: evaluationTrialExecutionStatusSchema,
    qualityStatus: evaluationQualityStatusSchema,
    qualityReason: evaluationQualityReasonSchema,
    inputs: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.unknown()),
    observations: z.array(z.unknown()),
    targetMetrics: evaluationMetricsSchema,
    evaluatorMetrics: evaluationMetricsSchema,
    totalMetrics: evaluationMetricsSchema,
    error: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ('status' in value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Legacy trial status is not accepted in EvaluationRun v2. Use executionStatus and qualityStatus.',
      });
    }
  });
const evaluationAggregateSchema = z
  .object({
    trialCount: z.number().int().nonnegative(),
    evaluatedTrialCount: z.number().int().nonnegative(),
    notEvaluatedTrialCount: z.number().int().nonnegative(),
    unableToEvaluateTrialCount: z.number().int().nonnegative(),
    passedTrialCount: z.number().int().nonnegative(),
    failedTrialCount: z.number().int().nonnegative(),
    erroredTrialCount: z.number().int().nonnegative(),
    canceledTrialCount: z.number().int().nonnegative(),
    passRate: z.number().finite(),
    averageLatencyMs: z.number().finite().nonnegative(),
    p95LatencyMs: z.number().finite().nonnegative(),
    targetErrorRate: z.number().finite(),
    evaluatorErrorRate: z.number().finite(),
    toolFailureRate: z.number().finite(),
    metrics: z.record(z.string(), z.number().finite()),
  })
  .passthrough();
const evaluationThresholdResultSchema = z
  .object({
    id: z.string().min(1),
    metric: z.string().min(1),
    operator: z.enum(['at-least', 'at-most', 'max-regression']),
    status: z.enum(['passed', 'failed', 'unavailable']),
    expectedValue: z.number().finite(),
    actualValue: z.number().finite().optional(),
    baselineValue: z.number().finite().optional(),
    regression: z.number().finite().optional(),
    message: z.string(),
  })
  .strict();

export const evaluationRunSchema = z
  .object({
    version: z.literal(2),
    id: z.string().min(1),
    projectId: z.string().min(1),
    suiteId: z.string().min(1),
    suiteName: z.string(),
    revision: z.number().int().nonnegative().optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    purpose: z.enum(['evaluation', 'execution-benchmark']),
    executionStatus: evaluationExecutionStatusSchema,
    qualityStatus: evaluationQualityStatusSchema,
    qualityReason: evaluationQualityReasonSchema,
    accountingStatus: z.enum(['complete', 'partial']),
    provenance: z.object({
      projectFingerprint: z.string(),
      suiteFingerprint: z.string(),
      datasetFingerprint: z.string(),
      targetFingerprint: z.string(),
      evaluatorFingerprints: z.record(z.string(), z.string()),
      executionMode: z.string(),
      accountingComplete: z.boolean(),
    }),
    aggregate: evaluationAggregateSchema.optional(),
    thresholdResults: z.array(evaluationThresholdResultSchema),
    trials: z.array(evaluationTrialSchema),
    warnings: z.array(z.string()),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ('verdict' in value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'Legacy verdict is not accepted in EvaluationRun v2. Use qualityStatus and qualityReason.',
      });
    }
  });
const putSchema = z.object({ projectId: z.string().min(1), run: evaluationRunSchema }).strict();
const deleteSchema = z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict();
const renameRunSchema = projectSchema.extend({ name: z.string().optional() }).strict();
const recordingReferenceSchema = z
  .object({
    id: z.string().min(1),
    retention: z.enum(['temporary', 'failure', 'baseline', 'retained']),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.retention === 'temporary' && reference.expiresAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Temporary evaluation recordings require an expiry timestamp.',
      });
    }
    if (reference.retention !== 'temporary' && reference.expiresAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Durable evaluation recordings cannot have an expiry timestamp.',
      });
    }
  });
export const evaluationRecordingSchema = z
  .object({
    projectId: z.string().min(1),
    runId: z.string().min(1),
    trialId: z.string().min(1),
    reference: recordingReferenceSchema,
    serialized: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (Buffer.byteLength(artifact.serialized, 'utf8') > MAX_EVALUATION_RECORDING_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_EVALUATION_RECORDING_BYTES,
        inclusive: true,
        origin: 'string',
        path: ['serialized'],
        message: `Evaluation recordings cannot exceed ${MAX_EVALUATION_RECORDING_BYTES} UTF-8 bytes.`,
      });
    }
  });
const recordingScopeSchema = z.object({ projectId: z.string().min(1), recordingId: z.string().min(1) }).strict();
const updateRecordingSchema = recordingScopeSchema
  .extend({
    retention: z.enum(['temporary', 'failure', 'baseline', 'retained']),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.retention === 'temporary' && reference.expiresAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Temporary evaluation recordings require an expiry timestamp.',
      });
    }
    if (reference.retention !== 'temporary' && reference.expiresAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Durable evaluation recordings cannot have an expiry timestamp.',
      });
    }
  });
const baselineSchema = z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict();
const datasetSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    fingerprint: z.string().min(1),
    dataset: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();
const datasetSnapshotScopeSchema = z.object({ projectId: z.string().min(1), fingerprint: z.string().min(1) }).strict();
export const hostedSubmissionSchema = z
  .object({
    projectContents: z.string().min(1),
    projectPath: z.string().min(1),
    datasetsContents: z.string().min(1).optional(),
    evaluationData: z.unknown(),
    dataset: z.unknown(),
    suiteId: z.string().min(1),
    purpose: z.enum(['evaluation', 'execution-benchmark']),
    contextValues: z.record(z.string(), z.unknown()).optional(),
    runId: z.string().min(1).optional(),
  })
  .strict();
const hostedRunScopeSchema = projectSchema.extend({ runId: z.string().min(1) }).strict();
const hostedRetrySchema = hostedRunScopeSchema
  .extend({ jobIds: z.array(z.string().min(1).max(1_024)).min(1).max(100_000) })
  .strict();

async function getConfiguredHostedCoordinator() {
  const coordinator = await getHostedEvaluationCoordinator();
  if (!coordinator) throw conflict('Hosted Evaluations require managed workflow storage.');
  return coordinator;
}

async function requireHostedSubmissionCoordinator() {
  const coordinator = await getConfiguredHostedCoordinator();
  if (!coordinator.getStatus().enabled) {
    throw conflict('Hosted Evaluations are not enabled for this Studio Server.');
  }
  return coordinator;
}

const evaluationLibrarySchema = z
  .object({
    version: z.literal(1),
    data: z
      .object({
        version: z.literal(1),
        suites: z.array(z.unknown()),
        baselines: z.array(z.unknown()),
      })
      .passthrough(),
    datasets: z.array(z.unknown()),
    migratedLegacyProjectIds: z.array(z.string()),
  })
  .passthrough();
const replaceLibrarySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    library: evaluationLibrarySchema,
  })
  .strict();
const libraryMutationChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('put-suite'),
      id: z.string().min(1),
      expectedVersion: z.string().min(1).nullable(),
      suite: z.unknown(),
      baselines: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({ kind: z.literal('delete-suite'), id: z.string().min(1), expectedVersion: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal('put-dataset'),
      id: z.string().min(1),
      expectedVersion: z.string().min(1).nullable(),
      dataset: z.unknown(),
    })
    .strict(),
  z
    .object({ kind: z.literal('delete-dataset'), id: z.string().min(1), expectedVersion: z.string().min(1) })
    .strict(),
]);
const libraryMutationSchema = z.object({ changes: z.array(libraryMutationChangeSchema).min(1).max(256) }).strict();
const importLibrarySchema = z.object({ library: evaluationLibrarySchema }).strict();
const runEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run-started'),
      revision: z.number().int().nonnegative(),
      run: evaluationRunSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('trial-settled'),
      revision: z.number().int().nonnegative(),
      runId: z.string().min(1),
      projectId: z.string().min(1),
      suiteId: z.string().min(1),
      requestedTrialCount: z.number().int().positive(),
      settledTrialCount: z.number().int().positive(),
      trial: evaluationTrialSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('run-finalized'),
      revision: z.number().int().nonnegative(),
      run: evaluationRunSchema,
    })
    .strict(),
]);

function normalizeLibraryMutation(input: z.infer<typeof libraryMutationSchema>): EvaluationLibraryMutation {
  return {
    changes: input.changes.map((change) => {
      if (change.kind === 'put-suite') {
        const data = deserializeEvaluationProjectData({
          version: 1,
          suites: [change.suite],
          baselines: change.baselines,
        });
        const suite = data.suites[0];
        if (!suite || suite.id !== change.id || data.baselines.some((baseline) => baseline.suiteId !== change.id)) {
          throw badRequest('Evaluation suite mutation payload does not match its resource ID.');
        }
        return { ...change, suite, baselines: data.baselines };
      }
      if (change.kind === 'put-dataset') {
        const dataset = validateEvaluationDataset(change.dataset);
        if (dataset.id !== change.id) {
          throw badRequest('Evaluation dataset mutation payload does not match its resource ID.');
        }
        return { ...change, dataset };
      }
      return change;
    }),
  };
}

evaluationRunsRouter.get(
  '/hosted/capability',
  asyncHandler(async (_req, res) => {
    const coordinator = await getHostedEvaluationCoordinator();
    res.json(coordinator?.getStatus() ?? { enabled: false, workerEnabled: false, workerConcurrency: 0 });
  }),
);

evaluationRunsRouter.post(
  '/hosted',
  validateBody(hostedSubmissionSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof hostedSubmissionSchema>;
    const coordinator = await requireHostedSubmissionCoordinator();
    const evaluationData = deserializeEvaluationProjectData(input.evaluationData);
    const dataset = validateEvaluationDataset(input.dataset);
    try {
      const run = await coordinator.submit({
        ...input,
        evaluationData,
        dataset,
        contextValues: input.contextValues as
          | Record<string, import('@valerypopoff/rivet2-evaluations').PortableJson>
          | undefined,
      });
      res.status(202).json(run);
    } catch (error) {
      if (error instanceof HostedEvaluationRunConflictError) throw conflict(error.message);
      if (!(error instanceof HostedEvaluationCapacityError)) throw error;
      sendHostedEvaluationCapacityError(res, error);
    }
  }),
);

evaluationRunsRouter.get(
  '/:runId/hosted-state',
  asyncHandler(async (req, res) => {
    const parsed = hostedRunScopeSchema.safeParse({ projectId: req.query.projectId, runId: req.params.runId });
    if (!parsed.success) throw badRequest('projectId query parameter is required.');
    const coordinator = await getConfiguredHostedCoordinator();
    const state = await coordinator.getRunState({
      projectId: parsed.data.projectId as ProjectId,
      runId: parsed.data.runId,
    });
    if (!state) {
      res.status(404).json({ error: 'Hosted Evaluation run not found.' });
      return;
    }
    res.json(state);
  }),
);

evaluationRunsRouter.post(
  '/:runId/cancel-hosted',
  validateBody(hostedRunScopeSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof hostedRunScopeSchema>;
    if (String(req.params.runId ?? '') !== input.runId)
      throw badRequest('The evaluation run ID must match the request path.');
    const run = await (
      await getConfiguredHostedCoordinator()
    ).requestCancel({ projectId: input.projectId as ProjectId, runId: input.runId });
    if (!run) {
      res.status(404).json({ error: 'Hosted Evaluation run not found.' });
      return;
    }
    res.json(run);
  }),
);

evaluationRunsRouter.post(
  '/:runId/retry-interrupted',
  validateBody(hostedRetrySchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof hostedRetrySchema>;
    if (String(req.params.runId ?? '') !== input.runId)
      throw badRequest('The evaluation run ID must match the request path.');
    try {
      const run = await (
        await requireHostedSubmissionCoordinator()
      ).retryInterrupted({
        projectId: input.projectId as ProjectId,
        runId: input.runId,
        jobIds: input.jobIds,
      });
      if (!run) {
        res.status(404).json({ error: 'Hosted Evaluation run not found.' });
        return;
      }
      res.json(run);
    } catch (error) {
      if (error instanceof HostedEvaluationRetryConflictError) throw conflict(error.message);
      if (!(error instanceof HostedEvaluationCapacityError)) throw error;
      sendHostedEvaluationCapacityError(res, error);
    }
  }),
);
evaluationRunsRouter.get(
  '/library/events',
  asyncHandler(async (req, res) => {
    const snapshot = await (await getEvaluationStore()).getLibrarySyncSnapshot();
    openEvaluationLibraryEventStream(req, res, snapshot.revision);
  }),
);

evaluationRunsRouter.get(
  '/library',
  asyncHandler(async (_req, res) => {
    res.json(await (await getEvaluationStore()).getLibrarySyncSnapshot());
  }),
);

evaluationRunsRouter.put(
  '/library',
  validateBody(replaceLibrarySchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof replaceLibrarySchema>;
    const store = await getEvaluationStore();
    try {
      const snapshot = await store.replaceLibrary({
        expectedRevision: input.expectedRevision,
        library: normalizeEvaluationLibrary(input.library),
      });
      if (snapshot.revision !== input.expectedRevision) notifyEvaluationLibraryChanged(req, snapshot.revision);
      res.json(await store.getLibrarySyncSnapshot());
    } catch (error) {
      if (error instanceof EvaluationLibraryConflictError) {
        throw conflict(error.message);
      }
      throw error;
    }
  }),
);

evaluationRunsRouter.post(
  '/library/mutations',
  validateBody(libraryMutationSchema),
  asyncHandler(async (req, res) => {
    const store = await getEvaluationStore();
    const before = await store.getLibrarySyncSnapshot();
    try {
      const snapshot = await store.mutateLibrary(normalizeLibraryMutation(req.body as z.infer<typeof libraryMutationSchema>));
      if (snapshot.revision !== before.revision) notifyEvaluationLibraryChanged(req, snapshot.revision);
      res.json(snapshot);
    } catch (error) {
      if (error instanceof EvaluationLibraryResourceConflictError) {
        res.status(409).json({
          error: error.message,
          code: 'evaluation_library_resource_conflict',
          conflicts: error.conflicts,
          snapshot: await store.getLibrarySyncSnapshot(),
        });
        return;
      }
      if (error instanceof EvaluationLibraryMutationValidationError) throw badRequest(error.message);
      throw error;
    }
  }),
);

evaluationRunsRouter.post(
  '/library/import',
  validateBody(importLibrarySchema),
  asyncHandler(async (req, res) => {
    const store = await getEvaluationStore();
    const before = await store.getLibrarySnapshot();
    const { library: rawLibrary } = req.body as z.infer<typeof importLibrarySchema>;
    const library = normalizeEvaluationLibrary(rawLibrary);
    const sourceFingerprint = createHash('sha256').update(JSON.stringify(library)).digest('hex');
    const snapshot = await store.importLegacyLibrary({ sourceFingerprint, library });
    if (snapshot.revision !== before.revision) notifyEvaluationLibraryChanged(req, snapshot.revision);
    res.json(await store.getLibrarySyncSnapshot());
  }),
);

evaluationRunsRouter.put(
  '/events/:runId',
  validateBody(runEventSchema),
  asyncHandler(async (req, res) => {
    const event = req.body as EvaluationRunEvent;
    const eventRunId = event.type === 'trial-settled' ? event.runId : event.run.id;
    if (String(req.params.runId ?? '') !== eventRunId) {
      throw badRequest('The evaluation event run ID must match the request path.');
    }
    await (await getEvaluationStore()).applyRunEvent(event);
    res.status(204).end();
  }),
);
evaluationRunsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('projectId query parameter is required.');
    const store = await getEvaluationStore();
    res.json(
      await store.list({
        ...parsed.data,
        projectId: parsed.data.projectId as ProjectId,
      }),
    );
  }),
);

evaluationRunsRouter.put(
  '/datasets/:fingerprint',
  validateBody(datasetSnapshotSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof datasetSnapshotSchema>;
    if (String(req.params.fingerprint ?? '') !== input.fingerprint) {
      throw badRequest('The evaluation dataset fingerprint must match the request path.');
    }
    const dataset = validateEvaluationDataset(input.dataset);
    if (dataset.projectId !== input.projectId) {
      throw badRequest('The evaluation dataset snapshot must match the request project.');
    }
    if (fingerprintEvaluationDataset(dataset) !== input.fingerprint) {
      throw badRequest('The evaluation dataset snapshot fingerprint does not match its fields and cases.');
    }
    await (
      await getEvaluationStore()
    ).putDatasetSnapshot({
      projectId: input.projectId as ProjectId,
      fingerprint: input.fingerprint,
      dataset,
      createdAt: input.createdAt,
    } satisfies EvaluationDatasetSnapshot);
    res.status(204).end();
  }),
);

evaluationRunsRouter.get(
  '/datasets/:fingerprint',
  asyncHandler(async (req, res) => {
    const parsed = datasetSnapshotScopeSchema.safeParse({
      projectId: req.query.projectId,
      fingerprint: req.params.fingerprint,
    });
    if (!parsed.success) throw badRequest('projectId query parameter is required.');
    const snapshot = await (
      await getEvaluationStore()
    ).getDatasetSnapshot({
      projectId: parsed.data.projectId as ProjectId,
      fingerprint: parsed.data.fingerprint,
    });
    if (!snapshot) {
      res.status(404).json({ error: 'Evaluation dataset snapshot not found.' });
      return;
    }
    res.json(snapshot);
  }),
);

evaluationRunsRouter.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const parsed = projectSchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('projectId query parameter is required.');
    const run = await (
      await getEvaluationStore()
    ).get({
      projectId: parsed.data.projectId as ProjectId,
      runId: String(req.params.runId ?? ''),
    });
    if (!run) {
      res.status(404).json({ error: 'Evaluation run not found.' });
      return;
    }
    res.json(run);
  }),
);

evaluationRunsRouter.put(
  '/:runId',
  validateBody(putSchema),
  asyncHandler(async (req, res) => {
    const { projectId, run } = req.body as z.infer<typeof putSchema>;
    if (String(req.params.runId ?? '') !== run.id || projectId !== run.projectId) {
      throw badRequest('The evaluation run ID and project ID must match the request scope.');
    }
    await (await getEvaluationStore()).put(run as EvaluationRun);
    res.status(204).end();
  }),
);

evaluationRunsRouter.patch(
  '/:runId',
  validateBody(renameRunSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof renameRunSchema>;
    const run = await (
      await getEvaluationStore()
    ).updateRunName({
      projectId: input.projectId as ProjectId,
      runId: String(req.params.runId ?? ''),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    if (!run) {
      res.status(404).json({ error: 'Evaluation run not found.' });
      return;
    }
    res.json(run);
  }),
);

evaluationRunsRouter.delete(
  '/:runId',
  validateBody(deleteSchema),
  asyncHandler(async (req, res) => {
    const { projectId, runId } = req.body as z.infer<typeof deleteSchema>;
    if (String(req.params.runId ?? '') !== runId)
      throw badRequest('The evaluation run ID must match the request path.');
    const hostedCoordinator = await getHostedEvaluationCoordinator();
    if (hostedCoordinator) {
      await hostedCoordinator.deleteRun({ projectId: projectId as ProjectId, runId });
      res.status(204).end();
      return;
    }
    await (await getEvaluationStore()).delete({ projectId: projectId as ProjectId, runId });
    res.status(204).end();
  }),
);

evaluationRunsRouter.put(
  '/recordings/:recordingId',
  validateBody(evaluationRecordingSchema),
  asyncHandler(async (req, res) => {
    const artifact = req.body as EvaluationRecordingArtifact;
    if (String(req.params.recordingId ?? '') !== artifact.reference.id)
      throw badRequest('The evaluation recording ID must match the request path.');
    await (await getEvaluationStore()).putRecording({ ...artifact, projectId: artifact.projectId as ProjectId });
    res.status(204).end();
  }),
);

evaluationRunsRouter.get(
  '/recordings/:recordingId',
  asyncHandler(async (req, res) => {
    const parsed = recordingScopeSchema.safeParse({
      projectId: req.query.projectId,
      recordingId: req.params.recordingId,
    });
    if (!parsed.success) throw badRequest('projectId query parameter is required.');
    const recording = await (
      await getEvaluationStore()
    ).getRecording({
      projectId: parsed.data.projectId as ProjectId,
      recordingId: parsed.data.recordingId,
    });
    if (!recording) {
      res.status(404).json({ error: 'Evaluation recording not found.' });
      return;
    }
    res.json(recording);
  }),
);

evaluationRunsRouter.patch(
  '/recordings/:recordingId',
  validateBody(updateRecordingSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof updateRecordingSchema>;
    if (String(req.params.recordingId ?? '') !== input.recordingId)
      throw badRequest('The evaluation recording ID must match the request path.');
    const updated = await (
      await getEvaluationStore()
    ).updateRecordingRetention({
      ...input,
      projectId: input.projectId as ProjectId,
    });
    res.json({ updated });
  }),
);

evaluationRunsRouter.post(
  '/:runId/promote-baseline',
  validateBody(baselineSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof baselineSchema>;
    if (String(req.params.runId ?? '') !== input.runId)
      throw badRequest('The evaluation run ID must match the request path.');
    await (
      await getEvaluationStore()
    ).promoteBaseline({
      projectId: input.projectId as ProjectId,
      runId: input.runId,
    });
    res.status(204).end();
  }),
);
