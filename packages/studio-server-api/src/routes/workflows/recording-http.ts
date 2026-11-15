import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRunStatisticsQuery,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import { prepareWorkflowRecordingInputExtractor } from './recording-input-extractor.js';
import { normalizeWorkflowRecordingInputFilter, parseWorkflowRecordingInputAfter } from './recording-input-filter.js';
import { getStatisticsQueryPeriod } from './recording-statistics.js';
import {
  deleteWorkflowRecordingWithBackend,
  getWorkflowRunStatisticsWithBackend,
  listWorkflowRecordingRunsPageWithBackend,
  listWorkflowRecordingWorkflowsWithBackend,
  listWorkflowRunStatisticsCatalogWithBackend,
  readWorkflowRecordingArtifactWithBackend,
  getWorkflowRecordingSummaryWithBackend,
} from './storage-backend.js';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const recordingsRunsQuerySchema = z.object({
  includeEvidence: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['all', 'failed']).optional().default('all'),
  inputPath: z.string().optional(),
  inputOperator: z.enum(WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS).optional(),
  inputValue: z.string().optional(),
  inputCursor: z.coerce.number().int().min(0).optional().default(0),
  inputAfter: z.string().min(1).max(512).optional(),
  includeSubgraphRuns: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  groupByRoot: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const runStatisticsTargetSchema = z.union([
  z.object({ surface: z.literal('endpoint'), workflowId: z.string().min(1) }),
  z.object({
    surface: z.literal('web_app'),
    workflowId: z.string().min(1),
    uiGraphId: z.string().min(1),
    componentId: z.string().min(1),
  }),
  z.object({
    surface: z.literal('web_app'),
    workflowId: z.string().min(1),
    legacyEndpointName: z.string().min(1),
  }),
]);

const runStatisticsPeriodSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const runStatisticsCatalogQuerySchema = z.object({
  surface: z.enum(['endpoint', 'web_app']),
});

const runStatisticsAggregationSchema = z.enum(['auto', 'day', 'week']);

const runStatisticsQuerySchema = z.object({
  target: runStatisticsTargetSchema,
  period: runStatisticsPeriodSchema,
  runKind: z.enum(['published', 'latest', 'both']),
  includeFailed: z.boolean().default(false),
  includeWarnings: z.boolean().default(false),
  aggregation: runStatisticsAggregationSchema.optional().default('auto'),
  costAggregation: runStatisticsAggregationSchema.optional(),
});

export function registerWorkflowRecordingHttpRoutes(
  workflowsRouter: Router,
  shared: {
    timing: RequestHandler;
    jsonBody: RequestHandler;
    createRequestAbortSignal(req: Request, res: Response): { signal: AbortSignal; cleanup(): void };
  },
): void {
  const { timing, jsonBody, createRequestAbortSignal } = shared;

  workflowsRouter.get(
    ['/recordings', '/recordings/workflows'],
    timing,
    asyncHandler(async (req, res) => {
      const startedAt = performance.now();
      const catalog = await listWorkflowRecordingWorkflowsWithBackend(req.query.includeEvidence === 'true');
      res.setHeader('Server-Timing', `recording_catalog;dur=${(performance.now() - startedAt).toFixed(2)}`);
      prepareWorkflowRecordingInputExtractor();
      res.json(catalog);
    }),
  );

  workflowsRouter.get(
    '/run-statistics/targets',
    asyncHandler(async (req, res) => {
      const query = runStatisticsCatalogQuerySchema.parse(req.query);
      res.json(await listWorkflowRunStatisticsCatalogWithBackend(query.surface));
    }),
  );

  workflowsRouter.post(
    '/run-statistics/query',
    jsonBody,
    validateBody(runStatisticsQuerySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as WorkflowRunStatisticsQuery;
      let period;
      try {
        period = getStatisticsQueryPeriod(body.period);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid statistics period');
      }
      res.json(await getWorkflowRunStatisticsWithBackend({ ...body, period }));
    }),
  );

  workflowsRouter.get(
    ['/recordings/runs', '/recordings/workflows/:workflowId/runs'],
    asyncHandler(async (req, res) => {
      const parsedQuery = recordingsRunsQuerySchema.parse(req.query);
      const requestAbort = createRequestAbortSignal(req, res);
      let inputFilter: ReturnType<typeof normalizeWorkflowRecordingInputFilter> = null;
      try {
        inputFilter = normalizeWorkflowRecordingInputFilter({
          path: parsedQuery.inputPath,
          operator: parsedQuery.inputOperator,
          value: parsedQuery.inputValue,
        });
        if (parsedQuery.inputAfter) {
          if (!inputFilter) {
            throw new Error('A recording input search continuation requires an input filter.');
          }
          parseWorkflowRecordingInputAfter(parsedQuery.inputAfter, {
            workflowId: String(req.params.workflowId ?? ''),
            statusFilter: parsedQuery.status,
            filter: inputFilter,
            includeSubgraphRuns: parsedQuery.includeSubgraphRuns,
          });
        }
      } catch (error) {
        requestAbort.cleanup();
        throw badRequest(error instanceof Error ? error.message : 'Invalid recording input filter');
      }

      try {
        const runsPage = await listWorkflowRecordingRunsPageWithBackend({
          includeEvidence: parsedQuery.includeEvidence,
          workflowId: String(req.params.workflowId ?? ''),
          page: parsedQuery.page,
          pageSize: parsedQuery.pageSize,
          statusFilter: parsedQuery.status,
          inputFilter,
          inputCursor: parsedQuery.inputCursor,
          signal: requestAbort.signal,
          inputAfter: parsedQuery.inputAfter,
          includeSubgraphRuns: parsedQuery.includeSubgraphRuns,
          runScope: inputFilter ? 'roots' : parsedQuery.groupByRoot ? 'families' : 'all',
        });
        if (!requestAbort.signal.aborted && !res.destroyed) {
          res.json(runsPage);
        }
      } catch (error) {
        if (!requestAbort.signal.aborted || !isAbortError(error)) {
          throw error;
        }
      } finally {
        requestAbort.cleanup();
      }
    }),
  );

  // A separate metadata-only browse path: children are execution context, not
  // input-search matches. Pagination bounds responses even for large families.
  workflowsRouter.get(
    '/recordings/:recordingId/sub-runs',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { page, pageSize, context } = recordingsRunsQuerySchema
        .pick({ page: true, pageSize: true })
        .extend({ context: z.enum(['all', 'project']).optional() })
        .parse(req.query);
      const recordingId = z.string().min(1).max(256).parse(req.params.recordingId);
      res.json(
        await listWorkflowRecordingRunsPageWithBackend({
          workflowId: recordingId,
          includeEvidence: req.query.includeEvidence === 'true',
          page,
          pageSize,
          runScope:
            context === 'all' ? 'family-children' : context === 'project' ? 'project-family-children' : 'children',
        }),
      );
    }),
  );

  workflowsRouter.get(
    '/recordings/:recordingId/recording',
    asyncHandler(async (req, res) => {
      res
        .type('text/plain; charset=utf-8')
        .send(await readWorkflowRecordingArtifactWithBackend(String(req.params.recordingId ?? ''), 'recording'));
    }),
  );

  workflowsRouter.get(
    '/recordings/:recordingId/replay-project',
    asyncHandler(async (req, res) => {
      res
        .type('text/plain; charset=utf-8')
        .send(await readWorkflowRecordingArtifactWithBackend(String(req.params.recordingId ?? ''), 'replay-project'));
    }),
  );

  workflowsRouter.get(
    '/recordings/:recordingId/replay-dataset',
    asyncHandler(async (req, res) => {
      res
        .type('text/plain; charset=utf-8')
        .send(await readWorkflowRecordingArtifactWithBackend(String(req.params.recordingId ?? ''), 'replay-dataset'));
    }),
  );

  workflowsRouter.get(
    '/recordings/:recordingId/summary',
    asyncHandler(async (req, res) => {
      res.json(await getWorkflowRecordingSummaryWithBackend(String(req.params.recordingId ?? '')));
    }),
  );

  workflowsRouter.delete(
    '/recordings/:recordingId',
    asyncHandler(async (req, res) => {
      await deleteWorkflowRecordingWithBackend(String(req.params.recordingId ?? ''));
      res.json({ deleted: true });
    }),
  );
}
