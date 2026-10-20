import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { routeMaintenanceOwner } from '../../ha-maintenance-routing.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { conflict, createHttpError } from '../../utils/httpError.js';
import { getExplicitBundleService } from './storage-backend.js';
import { notifyWorkflowTreeChanged } from './workflow-tree-events.js';

export const bundlesRouter = Router();
bundlesRouter.use(
  requireAuth,
  routeMaintenanceOwner,
  (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.get('X-Rivet-Bundle-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Bundle changes require explicit UI intent.');
    next();
  },
  createControlPlaneJsonBodyParser(),
);
const location = z.string().max(4096);
const name = z.string().min(1).max(255);
const version = z.enum(['latest', 'published']);
const id = z.string().uuid();
bundlesRouter.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const confirmation = z
      .object({ name, relativePath: location.min(1) })
      .strict()
      .parse(req.body);
    const result = await (await getExplicitBundleService()).delete(id.parse(req.params.id), confirmation);
    notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);
bundlesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z.object({ name, parentRelativePath: location }).strict().parse(req.body);
    const folder = await (await getExplicitBundleService()).create(input.name, input.parentRelativePath);
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ folder });
  }),
);
bundlesRouter.post(
  '/kind',
  asyncHandler(async (req, res) => {
    const input = z
      .object({ relativePath: location.min(1), enabled: z.boolean() })
      .strict()
      .parse(req.body);
    const folder = await (await getExplicitBundleService()).setKind(input.relativePath, input.enabled);
    notifyWorkflowTreeChanged(req);
    res.json({ folder });
  }),
);
bundlesRouter.post(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const input = z.object({ version }).strict().parse(req.body);
    res.json(await (await getExplicitBundleService()).preview(id.parse(req.params.id), input.version));
  }),
);
bundlesRouter.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const input = z
      .union([
        z.object({ automatic: z.literal(true) }).strict(),
        z
          .object({ version, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), name, parentRelativePath: location })
          .strict(),
      ])
      .parse(req.body);
    const result = await (await getExplicitBundleService()).duplicate(id.parse(req.params.id), input);
    notifyWorkflowTreeChanged(req);
    res.status(201).json(result);
  }),
);
bundlesRouter.use(
  (
    error: unknown,
    _req: import('express').Request,
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    const code = (error as { code?: string })?.code;
    next(
      code === '23514'
        ? conflict('Bundles cannot contain other bundles.')
        : code === '23505'
          ? conflict('The destination already exists. Choose another name.')
          : error,
    );
  },
);
