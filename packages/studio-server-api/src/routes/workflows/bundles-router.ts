import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { routeMaintenanceOwner } from '../../ha-maintenance-routing.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict, createHttpError } from '../../utils/httpError.js';
import { getExplicitBundleService } from './storage-backend.js';
import { notifyWorkflowTreeChanged } from './workflow-tree-events.js';
import { requireStructuralMutation, structuralMutationSchema } from './structural-contract.js';

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
const receipt = z.object({ operationId: id, expiresAt: z.string().datetime() }).strict();
const duplicateInput = z.union([
  z
    .object({
      automatic: z.literal(true),
      receipt: receipt.optional(),
      relativePath: location.min(1),
      mutation: structuralMutationSchema.optional(),
    })
    .strict(),
  z
    .object({
      version,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      name,
      parentRelativePath: location,
      relativePath: location.min(1),
      mutation: structuralMutationSchema.optional(),
    })
    .strict(),
]);
bundlesRouter.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const mutation = requireStructuralMutation(req.body?.mutation, req);
    const confirmation = z
      .object({ name, relativePath: location.min(1), mutation: structuralMutationSchema.optional() })
      .strict()
      .parse(req.body);
    const result = await (
      await getExplicitBundleService()
    ).delete(id.parse(req.params.id), { name: confirmation.name, relativePath: confirmation.relativePath }, mutation);
    notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);
bundlesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const mutation = requireStructuralMutation(req.body?.mutation, req);
    const input = z
      .object({ name, parentRelativePath: location, mutation: structuralMutationSchema.optional() })
      .strict()
      .parse(req.body);
    const folder = await (await getExplicitBundleService()).create(input.name, input.parentRelativePath, mutation);
    notifyWorkflowTreeChanged(req);
    res.status(201).json({ folder });
  }),
);
bundlesRouter.post(
  '/kind',
  asyncHandler(async (req, res) => {
    const mutation = requireStructuralMutation(req.body?.mutation, req);
    const input = z
      .object({
        relativePath: location.min(1),
        enabled: z.boolean(),
        namespaceId: id,
        mutation: structuralMutationSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const folder = await (
      await getExplicitBundleService()
    ).setKind(input.relativePath, input.enabled, input.namespaceId, mutation);
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
    const mutation = requireStructuralMutation(req.body?.mutation, req);
    const input = duplicateInput.parse(req.body);
    const result = await (await getExplicitBundleService()).duplicate(id.parse(req.params.id), { ...input, mutation });
    notifyWorkflowTreeChanged(req);
    res.status(201).json(result);
  }),
);
bundlesRouter.post(
  '/:id/duplicate/recover',
  asyncHandler(async (req, res) => {
    res.json(
      await (
        await getExplicitBundleService()
      ).recoverDuplicate(id.parse(req.params.id), duplicateInput.parse(req.body)),
    );
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
      error instanceof z.ZodError
        ? badRequest(error.issues[0]?.message ?? 'Invalid bundle request.')
        : code === '23514'
          ? conflict('Bundles cannot contain other bundles.')
          : code === '23505'
            ? conflict('The destination already exists. Choose another name.')
            : error,
    );
  },
);
