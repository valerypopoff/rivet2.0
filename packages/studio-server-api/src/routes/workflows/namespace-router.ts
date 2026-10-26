import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { createControlPlaneJsonBodyParser } from '../../middleware/body-parsers.js';
import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createHttpError } from '../../utils/httpError.js';
import { mutateWorkflowNamespaceWithBackend, recoverWorkflowNamespaceWithBackend } from './storage-backend.js';
import { notifyWorkflowTreeChanged } from './workflow-tree-events.js';
import { recoverStructuralWithBackend } from './storage-backend.js';

const path = z.string().min(1).max(4096);
const itemType = z.enum(['project', 'folder']);
const source = { itemType, relativePath: path };
export const namespaceMutationSchema = z
  .object({
    operationId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move'), ...source, destinationRelativePath: z.string().max(4096) }).strict(),
      z.object({ kind: z.literal('rename'), ...source, name: z.string().min(1).max(255) }).strict(),
      z.object({ kind: z.literal('delete'), ...source }).strict(),
    ]),
    expectedSource: z
      .object({ id: z.string().min(1).max(256), revisionId: z.string().min(1).nullable().optional() })
      .strict(),
    expectedDestinationId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const namespaceRouter = Router();
namespaceRouter.use(
  requireAuth,
  (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.get('X-Rivet-Namespace-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
      throw createHttpError(403, 'Namespace changes require explicit UI intent.');
    next();
  },
  createControlPlaneJsonBodyParser(),
);
const receiptLookupSchema = z
  .object({ operationId: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
namespaceRouter.post(
  '/receipt',
  validateBody(receiptLookupSchema),
  asyncHandler(async (req, res) => {
    res.json(await recoverStructuralWithBackend(req.body.operationId, req.body.requestHash));
  }),
);
namespaceRouter.post(
  '/mutate',
  validateBody(namespaceMutationSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof namespaceMutationSchema>;
    const result = await mutateWorkflowNamespaceWithBackend(input);
    notifyWorkflowTreeChanged(req);
    res.json(result);
  }),
);
// Recovery is observational. It never starts, retries or completes a write.
namespaceRouter.post(
  '/recover',
  validateBody(namespaceMutationSchema),
  asyncHandler(async (req, res) => {
    res.json(await recoverWorkflowNamespaceWithBackend(req.body as z.infer<typeof namespaceMutationSchema>));
  }),
);
