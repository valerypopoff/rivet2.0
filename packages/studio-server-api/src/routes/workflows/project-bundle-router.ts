import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createHttpError } from '../../utils/httpError.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { requireAuth } from '../../middleware/auth.js';
import { projectBundleJobs } from './project-bundle-jobs.js';
import { createSavedBundleSource, createExplicitBundleSource } from './project-bundle.js';
import { mutateStructuralWithBackend } from './storage-backend.js';
import { requireStructuralMutation, structuralMutationSchema } from './structural-contract.js';
import { normalizeWorkflowRelativePath } from './workflow-inputs.js';
import { notifyWorkflowTreeChanged } from './workflow-tree-events.js';
import { PROJECT_BUNDLE_UPLOAD_MAX_FILES } from '../../../../studio-server-shared/project-bundle-types.js';
import { routeMaintenanceOwner } from '../../ha-maintenance-routing.js';

export const projectBundleRouter = Router();
projectBundleRouter.use(requireAuth, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
projectBundleRouter.use(routeMaintenanceOwner);
const input = z
  .object({
    relativePath: z.string().min(1).max(4096),
    version: z.enum(['live', 'published']),
    versionPolicy: z.enum(['latest', 'published']).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
const jobId = z.string().uuid();
projectBundleRouter.post(
  '/container',
  (req, _res, next) => {
    if (req.get('X-Rivet-Bundle-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Bundle download must be requested from the server UI.');
    next();
  },
  createControlPlaneJsonBodyParser(),
  asyncHandler(async (req, res) => {
    const input = z
      .object({ bundleId: z.string().uuid(), version: z.enum(['latest', 'published']), requestId: z.string().uuid() })
      .strict()
      .parse(req.body);
    res
      .status(202)
      .json(
        await projectBundleJobs.start(
          createExplicitBundleSource(input.bundleId, input.version),
          input.version,
          input.requestId,
        ),
      );
  }),
);
projectBundleRouter.post(
  '/import',
  (req, _res, next) => {
    if (req.get('X-Rivet-Bundle-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Bundle upload must be requested from the server UI.');
    next();
  },
  createControlPlaneJsonBodyParser(),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        folderRelativePath: z.string().max(4096),
        mutation: structuralMutationSchema.optional(),
        files: z
          .array(z.object({ path: z.string().min(1).max(4096), contents: z.string() }).strict())
          .min(1)
          .max(PROJECT_BUNDLE_UPLOAD_MAX_FILES),
      })
      .strict()
      .parse(req.body);
    const parent = normalizeWorkflowRelativePath(input.folderRelativePath, {
      allowProjectFile: false,
      allowEmpty: true,
    });
    const result = await mutateStructuralWithBackend(
      { operation: 'import-bundle', input: { parentRelativePath: parent, files: input.files } },
      requireStructuralMutation(input.mutation, req),
    );
    notifyWorkflowTreeChanged(req);
    res.status(201).json(result);
  }),
);
projectBundleRouter.post(
  '/',
  createControlPlaneJsonBodyParser(),
  asyncHandler(async (req, res) => {
    if (req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Cross-site bundle preparation is not allowed.');
    const { relativePath, version, versionPolicy, requestId } = input.parse(req.body);
    res
      .status(202)
      .json(
        await projectBundleJobs.start(
          createSavedBundleSource(relativePath, version, versionPolicy),
          version === 'live' ? 'latest' : 'published',
          requestId,
        ),
      );
  }),
);
projectBundleRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await projectBundleJobs.status(jobId.parse(req.params.id)));
  }),
);
projectBundleRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const id = jobId.parse(req.params.id);
    const download = await projectBundleJobs.download(id);
    res.once('close', download.release);
    res.once('finish', download.release);
    res.set('ETag', `"${download.status.archiveHash}"`);
    res.set('X-Rivet-Bundle-SHA256', download.status.archiveHash!);
    res.type('application/zip');
    await new Promise<void>((resolve, reject) =>
      res.download(
        download.archive,
        `rivet-project-bundle-${id}.zip`,
        {
          acceptRanges: true,
          cacheControl: false,
          lastModified: false,
        },
        (error) => {
          download.release();
          if (error && res.headersSent) {
            res.destroy();
            resolve();
          } else if (error) reject(error);
          else resolve();
        },
      ),
    );
  }),
);
projectBundleRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.get('X-Rivet-Bundle-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Bundle disposal must be requested from the server UI.');
    await projectBundleJobs.cancel(jobId.parse(req.params.id));
    res.sendStatus(204);
  }),
);
