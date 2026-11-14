import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../studio-server-shared/workflow-types.js';
import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { normalizeWorkflowRelativePath } from './workflow-inputs.js';
import { notifyWorkflowTreeChanged } from './workflow-tree-events.js';
import { createWorkflowDownloadContentDisposition } from './workflow-download.js';
import {
  executeWorkflowPublicationCommandWithBackend,
  listWorkflowProjectWebAppsWithBackend,
  listWorkflowPublishedVersionsWithBackend,
  readWorkflowPublishedVersionDownloadWithBackend,
  readWorkflowPublishedVersionPreviewWithBackend,
  setWorkflowPublishedVersionCommentWithBackend,
  setWorkflowPublishedVersionStarWithBackend,
} from './storage-backend.js';

const workflowPathSchema = z
  .unknown()
  .transform((value) => normalizeWorkflowRelativePath(value, { allowProjectFile: true }));

const publicationPreconditionsSchema = z
  .object({
    expectedProjectId: z.string().trim().min(1),
    expectedPublicationVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedDraftRevisionId: z.string().trim().min(1).optional(),
  })
  .strict();

const draftPublicationPreconditionsSchema = publicationPreconditionsSchema.extend({
  expectedDraftRevisionId: z.string().trim().min(1),
});

const publishProjectSchema = z
  .object({
    relativePath: workflowPathSchema,
    preconditions: draftPublicationPreconditionsSchema,
    settings: z
      .object({
        endpointName: z.string(),
        // Accept the old duplicate field only when it agrees with the one
        // authoritative revision token; it is not forwarded to storage.
        expectedRevisionId: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .superRefine((value, context) => {
    if (
      value.settings.expectedRevisionId !== undefined &&
      value.settings.expectedRevisionId !== value.preconditions.expectedDraftRevisionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['settings', 'expectedRevisionId'],
        message: 'Draft revision tokens must match',
      });
    }
  });

const endpointAccessSchema = z.object({
  relativePath: workflowPathSchema,
  preconditions: publicationPreconditionsSchema,
  access: z.enum(['public', 'internal']),
});

const publishProjectWebAppsSchema = z.object({
  relativePath: workflowPathSchema,
  preconditions: draftPublicationPreconditionsSchema,
  publications: z.array(
    z.object({
      uiGraphId: z.string(),
      slug: z.string(),
      allowedEmails: z.array(z.string()).optional(),
    }),
  ),
});

const updateProjectWebAppAccessSchema = z.object({
  relativePath: workflowPathSchema,
  preconditions: publicationPreconditionsSchema,
  accessUpdates: z.array(
    z.object({
      uiGraphId: z.string(),
      allowedEmails: z.array(z.string()),
    }),
  ),
});

const unpublishProjectWebAppSchema = z.object({
  relativePath: workflowPathSchema,
  uiGraphId: z.string(),
  preconditions: publicationPreconditionsSchema,
});

const pathOnlySchema = z.object({
  relativePath: workflowPathSchema,
});

const publicationPathSchema = pathOnlySchema.extend({ preconditions: publicationPreconditionsSchema });

const publishedVersionsQuerySchema = z.object({
  relativePath: workflowPathSchema,
});

const publishedVersionDownloadSchema = z.object({
  relativePath: workflowPathSchema,
  versionId: z.string(),
});

const publishedVersionRestoreSchema = publishedVersionDownloadSchema.extend({
  preconditions: draftPublicationPreconditionsSchema,
});

const publishedVersionStarSchema = z.object({
  relativePath: workflowPathSchema,
  versionId: z.string(),
  isStarred: z.boolean(),
});

const publishedVersionCommentSchema = z.object({
  relativePath: workflowPathSchema,
  versionId: z.string(),
  comment: z.string().max(WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH),
});

export function registerWorkflowPublishedVersionHttpRoutes(workflowsRouter: Router, jsonBody: RequestHandler): void {
  workflowsRouter.get(
    '/projects/published-versions',
    asyncHandler(async (req, res) => {
      const { relativePath } = publishedVersionsQuerySchema.parse(req.query);
      res.json(await listWorkflowPublishedVersionsWithBackend(relativePath));
    }),
  );

  workflowsRouter.post(
    '/projects/published-versions/download',
    jsonBody,
    validateBody(publishedVersionDownloadSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, versionId } = req.body as z.infer<typeof publishedVersionDownloadSchema>;
      const download = await readWorkflowPublishedVersionDownloadWithBackend(relativePath, versionId);
      res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
      res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
      res.status(200).send(download.contents);
    }),
  );

  workflowsRouter.post(
    '/projects/published-versions/preview',
    jsonBody,
    validateBody(publishedVersionDownloadSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, versionId } = req.body as z.infer<typeof publishedVersionDownloadSchema>;
      res.json(await readWorkflowPublishedVersionPreviewWithBackend(relativePath, versionId));
    }),
  );

  workflowsRouter.patch(
    '/projects/published-versions/star',
    jsonBody,
    validateBody(publishedVersionStarSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, versionId, isStarred } = req.body as z.infer<typeof publishedVersionStarSchema>;
      res.json({ version: await setWorkflowPublishedVersionStarWithBackend(relativePath, versionId, isStarred) });
    }),
  );

  workflowsRouter.patch(
    '/projects/published-versions/comment',
    jsonBody,
    validateBody(publishedVersionCommentSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, versionId, comment } = req.body as z.infer<typeof publishedVersionCommentSchema>;
      res.json({ version: await setWorkflowPublishedVersionCommentWithBackend(relativePath, versionId, comment) });
    }),
  );

  workflowsRouter.post(
    '/projects/published-versions/restore',
    jsonBody,
    validateBody(publishedVersionRestoreSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, versionId, preconditions } = req.body as z.infer<typeof publishedVersionRestoreSchema>;
      const result = await executeWorkflowPublicationCommandWithBackend({
        kind: 'restore-version',
        relativePath,
        versionId,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json(result);
    }),
  );
}

export function registerWorkflowPublicationHttpRoutes(workflowsRouter: Router, jsonBody: RequestHandler): void {
  workflowsRouter.get(
    '/projects/web-apps',
    asyncHandler(async (req, res) => {
      const { relativePath } = publishedVersionsQuerySchema.parse(req.query);
      res.json(await listWorkflowProjectWebAppsWithBackend(relativePath));
    }),
  );

  workflowsRouter.post(
    '/projects/web-apps/publish',
    jsonBody,
    validateBody(publishProjectWebAppsSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, publications, preconditions } = req.body as z.infer<typeof publishProjectWebAppsSchema>;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'publish-web-apps',
        relativePath,
        publications,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );

  workflowsRouter.patch(
    '/projects/web-apps/access',
    jsonBody,
    validateBody(updateProjectWebAppAccessSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, accessUpdates, preconditions } = req.body as z.infer<
        typeof updateProjectWebAppAccessSchema
      >;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'set-web-app-access',
        relativePath,
        accessUpdates,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );

  workflowsRouter.post(
    '/projects/web-apps/unpublish',
    jsonBody,
    validateBody(unpublishProjectWebAppSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, uiGraphId, preconditions } = req.body as z.infer<typeof unpublishProjectWebAppSchema>;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'unpublish-web-app',
        relativePath,
        uiGraphId,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );

  workflowsRouter.post(
    '/projects/publish',
    jsonBody,
    validateBody(publishProjectSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, settings, preconditions } = req.body as z.infer<typeof publishProjectSchema>;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'publish-endpoint',
        relativePath,
        endpointName: settings.endpointName,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );

  workflowsRouter.post(
    '/projects/unpublish',
    jsonBody,
    validateBody(publicationPathSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, preconditions } = req.body as z.infer<typeof publicationPathSchema>;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'unpublish-endpoint',
        relativePath,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );

  workflowsRouter.post(
    '/projects/endpoint-access',
    jsonBody,
    validateBody(endpointAccessSchema),
    asyncHandler(async (req, res) => {
      const { relativePath, access, preconditions } = req.body as z.infer<typeof endpointAccessSchema>;
      const project = await executeWorkflowPublicationCommandWithBackend({
        kind: 'set-endpoint-access',
        relativePath,
        access,
        preconditions,
      });
      notifyWorkflowTreeChanged(req);
      res.json({ project });
    }),
  );
}
