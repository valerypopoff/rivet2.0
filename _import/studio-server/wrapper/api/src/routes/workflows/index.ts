import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { createResponseTimingMiddleware } from '../../utils/responseTiming.js';
import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRunStatisticsQuery,
} from '../../../../shared/workflow-recording-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../shared/workflow-types.js';
import {
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import {
  internalPublishedWorkflowsRouter,
  latestWebAppsRouter,
  latestWorkflowsRouter,
  publishedWebAppsRouter,
  publishedWorkflowsRouter,
} from './execution.js';
import { normalizeWorkflowRecordingInputFilter } from './recording-input-filter.js';
import {
  createWorkflowFolderItemWithBackend,
  createWorkflowProjectItemWithBackend,
  deleteWorkflowFolderItemWithBackend,
  deleteWorkflowProjectItemWithBackend,
  deleteWorkflowRecordingWithBackend,
  duplicateWorkflowProjectItemWithBackend,
  getWorkflowTree,
  getWorkflowRunStatisticsWithBackend,
  listWorkflowProjectWebAppsWithBackend,
  listWorkflowRecordingRunsPageWithBackend,
  listWorkflowRecordingWorkflowsWithBackend,
  listWorkflowRunStatisticsCatalogWithBackend,
  moveWorkflowItemWithBackend,
  publishWorkflowProjectWebAppsWithBackend,
  publishWorkflowProjectItemWithBackend,
  listWorkflowPublishedVersionsWithBackend,
  readWorkflowProjectDownloadWithBackend,
  readWorkflowPublishedVersionDownloadWithBackend,
  readWorkflowPublishedVersionPreviewWithBackend,
  restoreWorkflowPublishedVersionWithBackend,
  readWorkflowRecordingArtifactWithBackend,
  renameWorkflowFolderItemWithBackend,
  renameWorkflowProjectItemWithBackend,
  setWorkflowPublishedVersionCommentWithBackend,
  setWorkflowPublishedVersionStarWithBackend,
  unpublishWorkflowProjectWebAppWithBackend,
  unpublishWorkflowProjectItemWithBackend,
  updateWorkflowProjectWebAppAccessWithBackend,
  uploadWorkflowProjectItemWithBackend,
} from './storage-backend.js';
import { createWorkflowDownloadContentDisposition } from './workflow-download.js';
import { getStatisticsQueryPeriod } from './recording-statistics.js';
import { llmProfileHealthRouter } from './llm-profile-health.js';
import { evaluationRunsRouter } from './evaluation-runs.js';
import { readExecutionEnvironmentVariables } from '../../environment-variable-settings.js';
import { isTrustedExecutorRequest } from '../../auth.js';

export const workflowsRouter = Router();
const timing = createResponseTimingMiddleware();

function createRequestAbortSignal(req: Request, res: Response): { signal: AbortSignal; cleanup: () => void } {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  req.on('aborted', abort);
  res.on('close', abort);

  return {
    signal: abortController.signal,
    cleanup: () => {
      req.off('aborted', abort);
      res.off('close', abort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

workflowsRouter.use((req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
});

const moveSchema = z.object({
  itemType: z.enum(['project', 'folder']),
  sourceRelativePath: z.unknown(),
  destinationFolderRelativePath: z.unknown().optional(),
});

const createFolderSchema = z.object({
  name: z.unknown(),
  parentRelativePath: z.unknown().optional(),
});

const renameFolderSchema = z.object({
  relativePath: z.unknown(),
  newName: z.unknown(),
});

const deleteFolderSchema = z.object({
  relativePath: z.unknown(),
});

const createProjectSchema = z.object({
  folderRelativePath: z.unknown().optional(),
  name: z.unknown(),
});

const uploadProjectSchema = z.object({
  folderRelativePath: z.unknown().optional(),
  fileName: z.unknown(),
  contents: z.unknown(),
});

const renameProjectSchema = z.object({
  relativePath: z.unknown(),
  newName: z.unknown(),
});

const publishProjectSchema = z.object({
  relativePath: z.unknown(),
  settings: z.unknown().optional(),
});

workflowsRouter.use('/llm-profile-health', llmProfileHealthRouter);
workflowsRouter.use('/evaluation-runs', evaluationRunsRouter);

// The Node executor is a separate process. It asks the API for one immutable
// overlay at run start, so saved UI variables apply immediately without
// exposing them to browser clients or mutating process.env.
workflowsRouter.get('/execution-environment', asyncHandler(async (req, res) => {
  if (!isTrustedExecutorRequest(req)) {
    throw createHttpError(403, 'Forbidden');
  }
  res.json({ environment: await readExecutionEnvironmentVariables() });
}));

const publishProjectWebAppsSchema = z.object({
  relativePath: z.unknown(),
  publications: z.array(z.object({
    uiGraphId: z.string(),
    slug: z.string(),
    allowedEmails: z.array(z.string()).optional(),
  })),
});

const updateProjectWebAppAccessSchema = z.object({
  relativePath: z.unknown(),
  accessUpdates: z.array(z.object({
    uiGraphId: z.string(),
    allowedEmails: z.array(z.string()),
  })),
});

const unpublishProjectWebAppSchema = z.object({
  relativePath: z.unknown(),
  uiGraphId: z.unknown(),
});

const pathOnlySchema = z.object({
  relativePath: z.unknown(),
});

const duplicateProjectSchema = z.object({
  relativePath: z.unknown(),
  version: z.enum(['live', 'published']).optional(),
});

const downloadProjectSchema = z.object({
  relativePath: z.unknown(),
  version: z.enum(['live', 'published']),
});

const publishedVersionsQuerySchema = z.object({
  relativePath: z.unknown(),
});

const publishedVersionDownloadSchema = z.object({
  relativePath: z.unknown(),
  versionId: z.unknown(),
});

const publishedVersionStarSchema = z.object({
  relativePath: z.unknown(),
  versionId: z.unknown(),
  isStarred: z.boolean(),
});

const publishedVersionCommentSchema = z.object({
  relativePath: z.unknown(),
  versionId: z.unknown(),
  comment: z.string().max(WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH),
});

const recordingsRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['all', 'failed']).optional().default('all'),
  inputPath: z.string().optional(),
  inputOperator: z.enum(WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS).optional(),
  inputValue: z.string().optional(),
  inputCursor: z.coerce.number().int().min(0).optional().default(0),
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

const runStatisticsQuerySchema = z.object({
  target: runStatisticsTargetSchema,
  period: runStatisticsPeriodSchema,
  runKind: z.enum(['published', 'latest', 'both']),
  includeFailed: z.boolean().default(false),
  includeWarnings: z.boolean().default(false),
  aggregation: z.enum(['auto', 'day', 'week']).optional().default('auto'),
});

workflowsRouter.get('/tree', timing, asyncHandler(async (_req, res) => {
  res.json(await getWorkflowTree());
}));

workflowsRouter.get('/recordings', asyncHandler(async (_req, res) => {
  res.json(await listWorkflowRecordingWorkflowsWithBackend());
}));

workflowsRouter.get('/recordings/workflows', asyncHandler(async (_req, res) => {
  res.json(await listWorkflowRecordingWorkflowsWithBackend());
}));

workflowsRouter.get('/run-statistics/targets', asyncHandler(async (req, res) => {
  const query = runStatisticsCatalogQuerySchema.parse(req.query);
  res.json(await listWorkflowRunStatisticsCatalogWithBackend(query.surface));
}));

workflowsRouter.post('/run-statistics/query', validateBody(runStatisticsQuerySchema), asyncHandler(async (req, res) => {
  const body = req.body as WorkflowRunStatisticsQuery;
  let period;
  try {
    period = getStatisticsQueryPeriod(body.period);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Invalid statistics period');
  }
  res.json(await getWorkflowRunStatisticsWithBackend({ ...body, period }));
}));

workflowsRouter.get('/recordings/workflows/:workflowId/runs', asyncHandler(async (req, res) => {
  const parsedQuery = recordingsRunsQuerySchema.parse(req.query);
  const requestAbort = createRequestAbortSignal(req, res);
  let inputFilter: ReturnType<typeof normalizeWorkflowRecordingInputFilter> = null;
  try {
    inputFilter = normalizeWorkflowRecordingInputFilter({
      path: parsedQuery.inputPath,
      operator: parsedQuery.inputOperator,
      value: parsedQuery.inputValue,
    });
  } catch (error) {
    requestAbort.cleanup();
    throw badRequest(error instanceof Error ? error.message : 'Invalid recording input filter');
  }

  try {
    const runsPage = await listWorkflowRecordingRunsPageWithBackend(
      String(req.params.workflowId ?? ''),
      parsedQuery.page,
      parsedQuery.pageSize,
      parsedQuery.status,
      inputFilter,
      parsedQuery.inputCursor,
      requestAbort.signal,
    );
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
}));

workflowsRouter.get('/recordings/:recordingId/recording', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'recording',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-project', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'replay-project',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-dataset', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'replay-dataset',
  ));
}));

workflowsRouter.delete('/recordings/:recordingId', asyncHandler(async (req, res) => {
  await deleteWorkflowRecordingWithBackend(String(req.params.recordingId ?? ''));
  res.json({ deleted: true });
}));

workflowsRouter.post('/move', validateBody(moveSchema), asyncHandler(async (req, res) => {
  const { itemType, sourceRelativePath, destinationFolderRelativePath } = req.body as z.infer<typeof moveSchema>;
  if (itemType === 'project' || itemType === 'folder') {
    res.json(await moveWorkflowItemWithBackend(itemType, sourceRelativePath, destinationFolderRelativePath));
    return;
  }

  throw badRequest('Invalid itemType');
}));

workflowsRouter.post('/folders', validateBody(createFolderSchema), asyncHandler(async (req, res) => {
  const { name, parentRelativePath } = req.body as z.infer<typeof createFolderSchema>;
  const folder = await createWorkflowFolderItemWithBackend(name, parentRelativePath);
  res.status(201).json({ folder });
}));

workflowsRouter.patch('/folders', timing, validateBody(renameFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameFolderSchema>;
  res.json(await renameWorkflowFolderItemWithBackend(relativePath, newName));
}));

workflowsRouter.delete('/folders', validateBody(deleteFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof deleteFolderSchema>;
  await deleteWorkflowFolderItemWithBackend(relativePath);
  res.json({ deleted: true });
}));

workflowsRouter.post('/projects', validateBody(createProjectSchema), asyncHandler(async (req, res) => {
  const { folderRelativePath, name } = req.body as z.infer<typeof createProjectSchema>;
  const project = await createWorkflowProjectItemWithBackend(folderRelativePath, name);
  res.status(201).json({ project });
}));

workflowsRouter.patch('/projects', validateBody(renameProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameProjectSchema>;
  res.json(await renameWorkflowProjectItemWithBackend(relativePath, newName));
}));

workflowsRouter.post('/projects/duplicate', validateBody(duplicateProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, version } = req.body as z.infer<typeof duplicateProjectSchema>;
  res.status(201).json({ project: await duplicateWorkflowProjectItemWithBackend(relativePath, version ?? 'live') });
}));

workflowsRouter.post('/projects/upload', validateBody(uploadProjectSchema), asyncHandler(async (req, res) => {
  const { folderRelativePath, fileName, contents } = req.body as z.infer<typeof uploadProjectSchema>;
  res.status(201).json({ project: await uploadWorkflowProjectItemWithBackend(folderRelativePath, fileName, contents) });
}));

workflowsRouter.post('/projects/download', validateBody(downloadProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, version } = req.body as z.infer<typeof downloadProjectSchema>;
  const download = await readWorkflowProjectDownloadWithBackend(relativePath, version);
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
  res.status(200).send(download.contents);
}));

workflowsRouter.get('/projects/published-versions', asyncHandler(async (req, res) => {
  const { relativePath } = publishedVersionsQuerySchema.parse(req.query);
  res.json(await listWorkflowPublishedVersionsWithBackend(relativePath));
}));

workflowsRouter.post('/projects/published-versions/download', validateBody(publishedVersionDownloadSchema), asyncHandler(async (req, res) => {
  const { relativePath, versionId } = req.body as z.infer<typeof publishedVersionDownloadSchema>;
  const download = await readWorkflowPublishedVersionDownloadWithBackend(relativePath, versionId);
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
  res.status(200).send(download.contents);
}));

workflowsRouter.post('/projects/published-versions/preview', validateBody(publishedVersionDownloadSchema), asyncHandler(async (req, res) => {
  const { relativePath, versionId } = req.body as z.infer<typeof publishedVersionDownloadSchema>;
  res.json(await readWorkflowPublishedVersionPreviewWithBackend(relativePath, versionId));
}));

workflowsRouter.patch('/projects/published-versions/star', validateBody(publishedVersionStarSchema), asyncHandler(async (req, res) => {
  const { relativePath, versionId, isStarred } = req.body as z.infer<typeof publishedVersionStarSchema>;
  res.json({ version: await setWorkflowPublishedVersionStarWithBackend(relativePath, versionId, isStarred) });
}));

workflowsRouter.patch('/projects/published-versions/comment', validateBody(publishedVersionCommentSchema), asyncHandler(async (req, res) => {
  const { relativePath, versionId, comment } = req.body as z.infer<typeof publishedVersionCommentSchema>;
  res.json({ version: await setWorkflowPublishedVersionCommentWithBackend(relativePath, versionId, comment) });
}));

workflowsRouter.post('/projects/published-versions/restore', validateBody(publishedVersionDownloadSchema), asyncHandler(async (req, res) => {
  const { relativePath, versionId } = req.body as z.infer<typeof publishedVersionDownloadSchema>;
  res.json(await restoreWorkflowPublishedVersionWithBackend(relativePath, versionId));
}));

workflowsRouter.get('/projects/web-apps', asyncHandler(async (req, res) => {
  const { relativePath } = publishedVersionsQuerySchema.parse(req.query);
  res.json(await listWorkflowProjectWebAppsWithBackend(relativePath));
}));

workflowsRouter.post('/projects/web-apps/publish', validateBody(publishProjectWebAppsSchema), asyncHandler(async (req, res) => {
  const { relativePath, publications } = req.body as z.infer<typeof publishProjectWebAppsSchema>;
  res.json({ project: await publishWorkflowProjectWebAppsWithBackend(relativePath, publications) });
}));

workflowsRouter.patch('/projects/web-apps/access', validateBody(updateProjectWebAppAccessSchema), asyncHandler(async (req, res) => {
  const { relativePath, accessUpdates } = req.body as z.infer<typeof updateProjectWebAppAccessSchema>;
  res.json({ project: await updateWorkflowProjectWebAppAccessWithBackend(relativePath, accessUpdates) });
}));

workflowsRouter.post('/projects/web-apps/unpublish', validateBody(unpublishProjectWebAppSchema), asyncHandler(async (req, res) => {
  const { relativePath, uiGraphId } = req.body as z.infer<typeof unpublishProjectWebAppSchema>;
  res.json({ project: await unpublishWorkflowProjectWebAppWithBackend(relativePath, uiGraphId) });
}));

workflowsRouter.post('/projects/publish', validateBody(publishProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, settings } = req.body as z.infer<typeof publishProjectSchema>;
  res.json({ project: await publishWorkflowProjectItemWithBackend(relativePath, settings) });
}));

workflowsRouter.post('/projects/unpublish', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  res.json({ project: await unpublishWorkflowProjectItemWithBackend(relativePath) });
}));

workflowsRouter.delete('/projects', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  const projectId = await deleteWorkflowProjectItemWithBackend(relativePath);
  res.json({ deleted: true, projectId });
}));

export {
  internalPublishedWorkflowsRouter,
  latestWebAppsRouter,
  latestWorkflowsRouter,
  publishedWebAppsRouter,
  publishedWorkflowsRouter,
};
export type {
  LatestWorkflowMatch,
  PublishedWorkflowMatch,
  StoredWorkflowProjectSettings,
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types.js';
