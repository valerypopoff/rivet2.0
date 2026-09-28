import { Router, json } from 'express';
import { z } from 'zod';
import { isTrustedExecutorRequest, isTrustedProxyRequest } from '../auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createHttpError } from '../utils/httpError.js';
import { getLocalMetadataServingSelection } from './serving-selection.js';
import { isInsideCatalogRoot } from '../../../studio-server-shared/catalogNativeApi.js';
import { createLocalCatalogNativeApi } from './execution-io.js';
import { createExecutionProjectReferenceLoader } from '../routes/workflows/storage-backend.js';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read-text'), path: z.string().min(1) }).strict(),
  z
    .object({
      action: z.literal('read-directory'),
      path: z.string().min(1),
      options: z
        .object({
          recursive: z.boolean().optional(),
          includeDirectories: z.boolean().optional(),
          relative: z.boolean().optional(),
          filterGlobs: z.array(z.string()).max(100).optional(),
          ignores: z.array(z.string()).max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal('project-reference'), id: z.string().min(1).max(200) }).strict(),
]);
export const localCatalogExecutorIoRouter = Router();
localCatalogExecutorIoRouter.post(
  '/',
  (req, res, next) => {
    const address = req.socket.remoteAddress;
    if (
      !getLocalMetadataServingSelection() ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
      !isTrustedProxyRequest(req) ||
      !isTrustedExecutorRequest(req)
    )
      return next(createHttpError(403, 'Forbidden'));
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  json({ limit: '16kb' }),
  asyncHandler(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) throw createHttpError(400, 'Invalid catalog request');
    const request = parsed.data;
    const selected = getLocalMetadataServingSelection()!;
    if (request.action === 'project-reference') {
      const loader = await createExecutionProjectReferenceLoader(selected.source.workflows);
      const project = await loader.loadProject(selected.source.workflows, { id: request.id as any, title: '' });
      res.json({ result: project });
      return;
    }
    if (!isInsideCatalogRoot(selected.source.workflows, request.path)) throw createHttpError(403, 'Forbidden');
    const native = createLocalCatalogNativeApi();
    res.json({
      result:
        request.action === 'read-text'
          ? await native.readTextFile(request.path)
          : await native.readdir(request.path, undefined, request.options),
    });
  }),
);
