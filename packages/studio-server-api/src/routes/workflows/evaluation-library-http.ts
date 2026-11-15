import type { Router, RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deserializeEvaluationProjectData,
  normalizeEvaluationLibrary,
  validateEvaluationDataset,
  type EvaluationLibraryMutation,
} from '@valerypopoff/rivet2-evaluations';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import { validateBody } from '../../middleware/validate.js';
import { getEvaluationStore } from './storage-backend.js';
import {
  EvaluationLibraryConflictError,
  EvaluationLibraryMutationValidationError,
  EvaluationLibraryResourceConflictError,
} from '../../evaluation-runs/store.js';
import { notifyEvaluationLibraryChanged, openEvaluationLibraryEventStream } from './evaluation-library-events.js';

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
  z.object({ kind: z.literal('delete-suite'), id: z.string().min(1), expectedVersion: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('put-dataset'),
      id: z.string().min(1),
      expectedVersion: z.string().min(1).nullable(),
      dataset: z.unknown(),
    })
    .strict(),
  z.object({ kind: z.literal('delete-dataset'), id: z.string().min(1), expectedVersion: z.string().min(1) }).strict(),
]);

const libraryMutationSchema = z.object({ changes: z.array(libraryMutationChangeSchema).min(1).max(256) }).strict();

const importLibrarySchema = z.object({ library: evaluationLibrarySchema }).strict();

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

/** Register on the existing Evaluation router, using its shared parser. */
export function registerEvaluationLibraryHttpRoutes(evaluationRunsRouter: Router, jsonBody: RequestHandler): void {
  evaluationRunsRouter.get(
    '/library/events',
    asyncHandler(async (req, res) => {
      const store = await getEvaluationStore();
      await openEvaluationLibraryEventStream(req, res, async () => (await store.getLibrarySyncSnapshot()).revision);
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
    jsonBody,
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
    jsonBody,
    validateBody(libraryMutationSchema),
    asyncHandler(async (req, res) => {
      const store = await getEvaluationStore();
      const before = await store.getLibrarySyncSnapshot();
      try {
        const snapshot = await store.mutateLibrary(
          normalizeLibraryMutation(req.body as z.infer<typeof libraryMutationSchema>),
        );
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
    jsonBody,
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
}
