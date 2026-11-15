import { normalizeWorkflowRelativePath } from './workflow-inputs.js';
import { sanitizeWorkflowName } from './fs-helpers.js';
import { Router, type Request, type Response } from 'express';
import { scheduledRunsRouter } from '../../scheduled-runs/router.js';
import { localCatalogExecutorIoRouter } from '../../local-metadata/executor-io-route.js';
import { projectBundleRouter } from './project-bundle-router.js';
import { bundlesRouter } from './bundles-router.js';
import { namespaceRouter } from './namespace-router.js';
import { requireGuardedNamespaceMutations } from './storage-backend.js';
import { usesManagedNamespace, mutateStructuralWithBackend } from './storage-backend.js';
import { requireStructuralMutation, structuralMutationSchema } from './structural-contract.js';
import { listIncomingProjectReferences } from './project-references.js';
import { z } from 'zod';
import { registerWorkflowRecordingHttpRoutes } from './recording-http.js';
import { registerWorkflowPublicationHttpRoutes, registerWorkflowPublishedVersionHttpRoutes } from './publication-http.js';

import { validateBody } from '../../middleware/validate.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { createResponseTimingMiddleware } from '../../utils/responseTiming.js';
import {
  internalLatestWorkflowsRouter,
  internalPublishedWorkflowsRouter,
  latestWebAppsRouter,
  latestWorkflowsRouter,
  publishedWebAppsRouter,
  publishedWorkflowsRouter,
} from './execution.js';
import {
  createWorkflowFolderItemWithBackend,
  createWorkflowProjectItemWithBackend,
  deleteWorkflowFolderItemWithBackend,
  deleteWorkflowProjectItemWithBackend,
  duplicateWorkflowProjectItemWithBackend,
  getWorkflowTree,
  createExecutionSubgraphProjectLoader,
  listManagedReconciliationFindingDetailsWithBackend,
  moveWorkflowItemWithBackend,
  readWorkflowProjectDownloadWithBackend,
  renameWorkflowFolderItemWithBackend,
  renameWorkflowProjectItemWithBackend,
  uploadWorkflowProjectItemWithBackend,
} from './storage-backend.js';
import { localEditorRecordingsRouter } from './local-editor-recordings.js';
import { createWorkflowDownloadContentDisposition } from './workflow-download.js';
import { llmProfileHealthRouter } from './llm-profile-health.js';
import { evaluationRunsRouter } from './evaluation-runs.js';
import {
  getWorkflowTreeSyncState,
  notifyWorkflowTreeChanged,
  openWorkflowTreeEventStream,
} from './workflow-tree-events.js';
import { readExecutionEnvironmentVariables } from '../../environment-variable-settings.js';
import { isTrustedExecutorRequest } from '../../auth.js';
import {
  assembleRegistry,
  getProjectStreamableGraphOutputNodeIdsByGraph,
  resolveBuiltInPlugin,
  type ProjectId,
} from '@valerypopoff/rivet2-node';

export const workflowsRouter = Router();
workflowsRouter.use('/scheduled-runs', scheduledRunsRouter);
workflowsRouter.use('/project-bundles', projectBundleRouter);
workflowsRouter.use('/bundles', bundlesRouter);
workflowsRouter.use('/namespace', namespaceRouter);
workflowsRouter.use('/local-catalog-io', localCatalogExecutorIoRouter);
const timing = createResponseTimingMiddleware();
const jsonBody = createControlPlaneJsonBodyParser();

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

workflowsRouter.use((req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
});

const workflowPathSchema = z
  .unknown()
  .transform((value) => normalizeWorkflowRelativePath(value, { allowProjectFile: true }));
const workflowFolderSchema = z
  .unknown()
  // Omitted destinations mean the root. Zod object fields otherwise reject a
  // missing transformed value before the normalizer can supply that root.
  .prefault('')
  .transform((value) => normalizeWorkflowRelativePath(value, { allowProjectFile: false, allowEmpty: true }));
const workflowNameSchema = z.unknown().transform((value) => sanitizeWorkflowName(value, 'name'));

const moveSchema = z.object({
  itemType: z.enum(['project', 'folder']),
  sourceRelativePath: workflowPathSchema,
  destinationFolderRelativePath: workflowFolderSchema,
});

const createFolderSchema = z.object({
  mutation: structuralMutationSchema.optional(),
  name: workflowNameSchema,
  parentRelativePath: workflowFolderSchema,
});

const renameFolderSchema = z.object({
  relativePath: workflowPathSchema,
  newName: workflowNameSchema,
});

const deleteFolderSchema = z.object({
  relativePath: workflowPathSchema,
});

const createProjectSchema = z.object({
  mutation: structuralMutationSchema.optional(),
  folderRelativePath: workflowFolderSchema,
  name: workflowNameSchema,
});

const uploadProjectSchema = z.object({
  mutation: structuralMutationSchema.optional(),
  folderRelativePath: workflowFolderSchema,
  fileName: z.string(),
  contents: z.string(),
});

const renameProjectSchema = z.object({
  relativePath: workflowPathSchema,
  newName: workflowNameSchema,
});

workflowsRouter.use('/llm-profile-health', llmProfileHealthRouter);
workflowsRouter.use('/evaluation-runs', evaluationRunsRouter);

workflowsRouter.use('/local-editor-recordings', localEditorRecordingsRouter);
// The Node executor is a separate process. It asks the API for one immutable
// overlay at run start, so saved UI variables apply immediately without
// exposing them to browser clients or mutating process.env.
workflowsRouter.get(
  '/execution-environment',
  asyncHandler(async (req, res) => {
    if (!isTrustedExecutorRequest(req)) {
      throw createHttpError(403, 'Forbidden');
    }
    res.json({ environment: await readExecutionEnvironmentVariables() });
  }),
);

const pathOnlySchema = z.object({
  relativePath: workflowPathSchema,
});

const duplicateProjectSchema = z.object({
  mutation: structuralMutationSchema.optional(),
  relativePath: workflowPathSchema,
  version: z.enum(['live', 'published']).optional(),
});

const downloadProjectSchema = z.object({
  relativePath: workflowPathSchema,
  version: z.enum(['live', 'published']),
});

const reconciliationFindingQuerySchema = z
  .object({
    domain: z.enum(['evaluations', 'runtime_libraries', 'workflows']).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
    state: z.enum(['open', 'resolved']).optional().default('open'),
  })
  .strict();

workflowsRouter.get('/tree/events', requireAuth, (req, res) => {
  openWorkflowTreeEventStream(req, res);
});

workflowsRouter.get(
  '/tree',
  timing,
  asyncHandler(async (_req, res) => {
    // Capture before reading storage. A concurrent mutation can only make this
    // token older than the returned tree, never falsely label an older snapshot
    // as current; its subsequent event will then schedule another refresh.
    const sync = getWorkflowTreeSyncState();
    res.json({
      ...(await getWorkflowTree()),
      sync,
    });
  }),
);

const subgraphRequestTarget = (req: Request) => ({
  projectId: z.string().trim().min(1).max(256).parse(req.params.projectId) as ProjectId,
  version: z.enum(['latest', 'published']).parse(req.query.version ?? 'latest'),
  callerProjectId: z.string().trim().min(1).max(256).optional().parse(req.query.callerProjectId) as
    | ProjectId
    | undefined,
});
workflowsRouter.get(
  '/subgraph-projects/:projectId/access',
  requireAuth,
  asyncHandler(async (req, res) => {
    await createExecutionSubgraphProjectLoader().validateTarget(subgraphRequestTarget(req));
    res.sendStatus(204);
  }),
);

workflowsRouter.get(
  '/subgraph-projects/:projectId/preview',
  requireAuth,
  asyncHandler(async (req, res) => {
    const target = subgraphRequestTarget(req);
    const loader = createExecutionSubgraphProjectLoader();
    // Caller-qualified loads validate at the managed loader boundary. Missing
    // callers need an explicit check, not the internal root-snapshot exemption.
    if (!target.callerProjectId) await loader.validateTarget(target);
    const { project, revisionKey } = await loader.loadTarget(target);
    // A built-in provider node can emit partials too. Use the target's own
    // registered node definitions when deriving hints; unavailable external
    // plugins remain conservative (no arrow) without exposing their contents.
    const { registry: previewRegistry } = await assembleRegistry(
      (project.plugins ?? []).filter((spec) => spec.type === 'built-in'),
      async (spec) => resolveBuiltInPlugin(spec.id),
    );
    // The picker needs boundary IDs, types, and editor hints only. Graph Input
    // defaults can contain large or sensitive values; never include them (or
    // executable node configuration, embedded assets, or datasets) in preview.
    res.json({
      revisionKey,
      streamingOutputNodeIdsByGraph: getProjectStreamableGraphOutputNodeIdsByGraph({
        project,
        referencedProjects: {},
        registry: previewRegistry,
      }),
      project: {
        metadata: {
          id: project.metadata.id,
          title: project.metadata.title,
          mainGraphId: project.metadata.mainGraphId,
        },
        graphs: Object.fromEntries(
          Object.entries(project.graphs).map(([id, graph]) => [
            id,
            {
              metadata: { id: graph.metadata?.id, name: graph.metadata?.name },
              nodes: graph.nodes.flatMap((node) => {
                if (node.type !== 'graphInput' && node.type !== 'graphOutput') return [];
                const data = node.data as { id: string; dataType: string; editor?: string };
                return [
                  {
                    id: node.id,
                    type: node.type,
                    data: {
                      id: data.id,
                      dataType: data.dataType,
                      ...(node.type === 'graphInput' && data.editor ? { editor: data.editor } : {}),
                    },
                  },
                ];
              }),
              connections: [],
            },
          ]),
        ),
      },
    });
  }),
);

workflowsRouter.get(
  '/subgraph-projects/:projectId/execution',
  requireAuth,
  asyncHandler(async (req, res) => {
    const target = subgraphRequestTarget(req);
    const loader = createExecutionSubgraphProjectLoader();
    if (!target.callerProjectId) await loader.validateTarget(target);
    const resolved = await loader.loadTarget(target);
    res.json({
      projectContents: resolved.projectContents,
      datasetsContents: resolved.datasetsContents,
      revisionKey: resolved.revisionKey,
      sourceProjectPath: resolved.sourceProjectPath,
    });
  }),
);

// The parent /api mount is authenticated; repeat it here so raw object keys
// cannot become available if this router is ever mounted differently.
workflowsRouter.get(
  '/maintenance/reconciliation/findings',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await listManagedReconciliationFindingDetailsWithBackend(reconciliationFindingQuerySchema.parse(req.query)),
    );
  }),
);

registerWorkflowRecordingHttpRoutes(workflowsRouter, { timing, jsonBody, createRequestAbortSignal });

workflowsRouter.post(
  '/move',
  jsonBody,
  validateBody(moveSchema),
  asyncHandler(async (req, res) => {
    const { itemType, sourceRelativePath, destinationFolderRelativePath } = req.body as z.infer<typeof moveSchema>;
    requireGuardedNamespaceMutations();
    if (itemType === 'project' || itemType === 'folder') {
      const result = await moveWorkflowItemWithBackend(itemType, sourceRelativePath, destinationFolderRelativePath);
      if (itemType === 'folder' || result.movedProjectPaths.length > 0) notifyWorkflowTreeChanged(req);
      res.json(result);
      return;
    }

    throw badRequest('Invalid itemType');
  }),
);

workflowsRouter.post(
  '/folders',
  jsonBody,
  validateBody(createFolderSchema),
  asyncHandler(async (req, res) => {
    const { name, parentRelativePath } = req.body as z.infer<typeof createFolderSchema>;
    const folder = usesManagedNamespace()
      ? await mutateStructuralWithBackend(
          { operation: 'create-folder', input: { name, parentRelativePath } },
          requireStructuralMutation(req.body.mutation, req),
        )
      : await createWorkflowFolderItemWithBackend(name, parentRelativePath);
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ folder });
  }),
);

workflowsRouter.patch(
  '/folders',
  timing,
  jsonBody,
  validateBody(renameFolderSchema),
  asyncHandler(async (req, res) => {
    const { relativePath, newName } = req.body as z.infer<typeof renameFolderSchema>;
    requireGuardedNamespaceMutations();
    const result = await renameWorkflowFolderItemWithBackend(relativePath, newName);
    notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);

workflowsRouter.delete(
  '/folders',
  jsonBody,
  validateBody(deleteFolderSchema),
  asyncHandler(async (req, res) => {
    const { relativePath } = req.body as z.infer<typeof deleteFolderSchema>;
    requireGuardedNamespaceMutations();
    await deleteWorkflowFolderItemWithBackend(relativePath);
    notifyWorkflowTreeChanged(req);
    res.json({ deleted: true });
  }),
);

workflowsRouter.post(
  '/projects',
  jsonBody,
  validateBody(createProjectSchema),
  asyncHandler(async (req, res) => {
    const { folderRelativePath, name } = req.body as z.infer<typeof createProjectSchema>;
    const project = usesManagedNamespace()
      ? await mutateStructuralWithBackend(
          { operation: 'create-project', input: { name, parentRelativePath: folderRelativePath } },
          requireStructuralMutation(req.body.mutation, req),
        )
      : await createWorkflowProjectItemWithBackend(folderRelativePath, name);
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ project });
  }),
);

workflowsRouter.patch(
  '/projects',
  jsonBody,
  validateBody(renameProjectSchema),
  asyncHandler(async (req, res) => {
    const { relativePath, newName } = req.body as z.infer<typeof renameProjectSchema>;
    requireGuardedNamespaceMutations();
    const result = await renameWorkflowProjectItemWithBackend(relativePath, newName);
    if (result.movedProjectPaths.length > 0) notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);

workflowsRouter.post(
  '/projects/duplicate',
  jsonBody,
  validateBody(duplicateProjectSchema),
  asyncHandler(async (req, res) => {
    const { relativePath, version } = req.body as z.infer<typeof duplicateProjectSchema>;
    const project = usesManagedNamespace()
      ? await mutateStructuralWithBackend(
          { operation: 'copy-project', input: { relativePath, version: version ?? 'live' } },
          requireStructuralMutation(req.body.mutation, req),
        )
      : await duplicateWorkflowProjectItemWithBackend(relativePath, version ?? 'live');
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ project });
  }),
);

workflowsRouter.post(
  '/projects/upload',
  jsonBody,
  validateBody(uploadProjectSchema),
  asyncHandler(async (req, res) => {
    const { folderRelativePath, fileName, contents } = req.body as z.infer<typeof uploadProjectSchema>;
    const project = usesManagedNamespace()
      ? await mutateStructuralWithBackend(
          { operation: 'upload-project', input: { parentRelativePath: folderRelativePath, fileName, contents } },
          requireStructuralMutation(req.body.mutation, req),
        )
      : await uploadWorkflowProjectItemWithBackend(folderRelativePath, fileName, contents);
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ project });
  }),
);

workflowsRouter.post(
  '/projects/download',
  jsonBody,
  validateBody(downloadProjectSchema),
  asyncHandler(async (req, res) => {
    const { relativePath, version } = req.body as z.infer<typeof downloadProjectSchema>;
    const download = await readWorkflowProjectDownloadWithBackend(relativePath, version);
    res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
    res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
    res.status(200).send(download.contents);
  }),
);

registerWorkflowPublishedVersionHttpRoutes(workflowsRouter, jsonBody);

workflowsRouter.get(
  '/projects/references',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { relativePath, projectId } = z
      .object({ relativePath: z.string().min(1), projectId: z.string().min(1).optional() })
      .parse(req.query);
    const { signal, cleanup } = createRequestAbortSignal(req, res);
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await listIncomingProjectReferences(relativePath, projectId, signal));
    } finally {
      cleanup();
    }
  }),
);

const graphReferenceReviewSchema = z.object({
  projectId: z.string().min(1).max(256),
  relativePath: z.string().min(1).optional(),
  graphIds: z.array(z.string().min(1).max(256)).min(1).max(500),
});

// Graph folders can contain enough IDs to exceed a proxy's request-line limit.
// Keep the existing project-level GET contract; share the same read-only scan.
workflowsRouter.post(
  '/projects/references',
  requireAuth,
  jsonBody,
  validateBody(graphReferenceReviewSchema),
  asyncHandler(async (req, res) => {
    const { projectId, relativePath, graphIds } = req.body as z.infer<typeof graphReferenceReviewSchema>;
    const { signal, cleanup } = createRequestAbortSignal(req, res);
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await listIncomingProjectReferences(relativePath, projectId, signal, graphIds));
    } finally {
      cleanup();
    }
  }),
);

registerWorkflowPublicationHttpRoutes(workflowsRouter, jsonBody);

workflowsRouter.delete(
  '/projects',
  jsonBody,
  validateBody(pathOnlySchema),
  asyncHandler(async (req, res) => {
    const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
    requireGuardedNamespaceMutations();
    const projectId = await deleteWorkflowProjectItemWithBackend(relativePath);
    notifyWorkflowTreeChanged(req);
    res.json({ deleted: true, projectId });
  }),
);

export {
  internalLatestWorkflowsRouter,
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
