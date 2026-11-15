import type { Router, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { deserializeEvaluationProjectData, validateEvaluationDataset } from '@valerypopoff/rivet2-evaluations';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import { validateBody } from '../../middleware/validate.js';
import { getHostedEvaluationCoordinator } from './storage-backend.js';
import {
  HostedEvaluationCapacityError,
  HostedEvaluationRetryConflictError,
  HostedEvaluationRunConflictError,
} from '../../evaluation-runs/hosted-coordinator.js';

function sendHostedEvaluationCapacityError(res: Response, error: HostedEvaluationCapacityError): void {
  res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(429).json({
    error: error.message,
    code: 'evaluation_batch_capacity_exceeded',
    limit: error.limit,
  });
}

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

const hostedRunScopeSchema = z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict();

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

/** Register on the existing Evaluation router, using its shared parser. */
export function registerHostedEvaluationHttpRoutes(evaluationRunsRouter: Router, jsonBody: RequestHandler): void {
  evaluationRunsRouter.get(
    '/hosted/capability',
    asyncHandler(async (_req, res) => {
      const coordinator = await getHostedEvaluationCoordinator();
      res.json(coordinator?.getStatus() ?? { enabled: false, workerEnabled: false, workerConcurrency: 0 });
    }),
  );

  evaluationRunsRouter.post(
    '/hosted',
    jsonBody,
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
    jsonBody,
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
    jsonBody,
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
}
