import { Router } from 'express';
import { z } from 'zod';
import type { ProjectId } from '@valerypopoff/rivet2-node';

import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createResponseTimingMiddleware } from '../utils/responseTiming.js';
import { getWorkspaceRoot } from '../security.js';
import { listHostedProjectPaths, loadHostedProject, saveHostedProject } from './workflows/storage-backend.js';
import { notifyWorkflowTreeChanged } from './workflows/workflow-tree-events.js';

export const projectsRouter = Router();
const timing = createResponseTimingMiddleware();

const loadProjectSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

const saveProjectSchema = z.object({
  path: z.string().min(1, 'path is required'),
  contents: z.string(),
  datasetsContents: z.string().nullable().optional().default(null),
  expectedRevisionId: z.string().nullable().optional().default(null),
  projectId: z.string().min(1).optional(),
  saveIntent: z.enum(['in-place', 'save-as']).optional().default('save-as'),
});

projectsRouter.get(
  '/list',
  asyncHandler(async (_req, res) => {
    res.json({ files: await listHostedProjectPaths() });
  }),
);

projectsRouter.post(
  '/open-dialog',
  asyncHandler(async (_req, res) => {
    res.json({ files: await listHostedProjectPaths() });
  }),
);

projectsRouter.post(
  '/load',
  timing,
  validateBody(loadProjectSchema),
  asyncHandler(async (req, res) => {
    const { path } = req.body as z.infer<typeof loadProjectSchema>;
    res.json(await loadHostedProject(path));
  }),
);

projectsRouter.post(
  '/save',
  timing,
  validateBody(saveProjectSchema),
  asyncHandler(async (req, res) => {
    const { path, contents, datasetsContents, expectedRevisionId, projectId, saveIntent } = req.body as z.infer<
      typeof saveProjectSchema
    >;

    const result = await saveHostedProject({
      projectPath: path,
      contents,
      datasetsContents,
      expectedRevisionId,
      projectId: projectId as ProjectId | undefined,
      saveIntent,
    });
    notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);

projectsRouter.get('/workspace-root', (_req, res) => {
  res.json({ path: getWorkspaceRoot() });
});
