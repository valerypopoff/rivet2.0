import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createHttpError } from '../../utils/httpError.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { requireAuth } from '../../middleware/auth.js';
import { projectBundleJobs } from './project-bundle-jobs.js';
import { createSavedBundleSource } from './project-bundle.js';

export const projectBundleRouter = Router();
projectBundleRouter.use(requireAuth, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
const input = z
  .object({
    relativePath: z.string().min(1).max(4096),
    version: z.enum(['live', 'published']),
    requestId: z.string().uuid().optional(),
  })
  .strict();
const jobId = z.string().uuid();
projectBundleRouter.post(
  '/',
  createControlPlaneJsonBodyParser(),
  asyncHandler(async (req, res) => {
    if (req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Cross-site bundle preparation is not allowed.');
    const { relativePath, version, requestId } = input.parse(req.body);
    res
      .status(202)
      .json(
        await projectBundleJobs.start(
          createSavedBundleSource(relativePath, version),
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
