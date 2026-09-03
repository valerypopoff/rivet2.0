import { Buffer } from 'node:buffer';
import { Router } from 'express';
import { z } from 'zod';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  type AttachedData,
  type CombinedDataset,
  type Project,
} from '@valerypopoff/rivet2-node';

import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import {
  getLLMProfileHealthStore,
  getWorkflowTree,
  loadHostedProject,
  persistWorkflowExecutionRecordingWithBackend,
} from './storage-backend.js';
import { isWorkflowRecordingEnabled } from './recordings-config.js';
import { MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES } from './local-editor-recording-limits.js';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';

export const localEditorRecordingsRouter = Router();

localEditorRecordingsRouter.get('/capability', (_req, res) => {
  // Route presence is the compatibility contract. Recording configuration is
  // reported only after a health-correlated local run actually completes.
  res.json({ supported: true });
});

const persistenceAvailabilitySchema = z.enum(['disabled', 'persistence-failed']);
const executionIdentitySchema = z
  .object({
    correlationId: z.string().min(1).max(200),
    graphId: z.string().min(1).max(1_024).optional(),
    graphName: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

const localEditorRecordingSchema = z
  .object({
    projectId: z.string().min(1).max(1_024),
    projectPath: z.string().min(1).max(16_384),
    projectContents: z.string().min(1),
    datasetsContents: z.string().optional(),
    recordingSerialized: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'suspicious']),
    durationMs: z.number().finite().nonnegative(),
    errorMessage: z.string().max(16_384).optional(),
    executionIdentity: executionIdentitySchema,
  })
  .strict()
  .superRefine((input, context) => {
    const totalBytes = [input.projectContents, input.datasetsContents, input.recordingSerialized].reduce(
      (total, value) => total + (value == null ? 0 : Buffer.byteLength(value, 'utf8')),
      0,
    );
    if (totalBytes > MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES,
        inclusive: true,
        origin: 'string',
        message: `Local editor replay uploads cannot exceed ${MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES} UTF-8 bytes.`,
      });
    }
  });

const recordingOutcomeSchema = z
  .object({
    correlationId: z.string().min(1).max(200),
    availability: persistenceAvailabilitySchema,
  })
  .strict();

function parseProjectSnapshot(contents: string, label: string): [Project, AttachedData] {
  try {
    return loadProjectAndAttachedDataFromString(contents);
  } catch {
    throw badRequest(`${label} is not a valid Rivet project.`);
  }
}

function findProjectByMetadataId(
  projects: readonly WorkflowProjectItem[],
  folders: readonly WorkflowFolderItem[],
  projectId: string,
): WorkflowProjectItem | undefined {
  for (const project of projects) {
    // Managed storage uses the metadata id as the item id. Filesystem storage
    // uses its relative path for the item id and supplies projectMetadataId.
    if (project.projectMetadataId === projectId || project.id === projectId) {
      return project;
    }
  }

  for (const folder of folders) {
    const nested = findProjectByMetadataId(folder.projects, folder.folders, projectId);
    if (nested) return nested;
  }

  return undefined;
}

function normalizeRequestedProjectPath(requestedPath: string): string {
  return requestedPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

function findProjectByRelativePath(
  projects: readonly WorkflowProjectItem[],
  folders: readonly WorkflowFolderItem[],
  requestedPath: string,
): WorkflowProjectItem | undefined {
  const normalizedRequestedPath = normalizeRequestedProjectPath(requestedPath);

  for (const project of projects) {
    if (project.relativePath === normalizedRequestedPath) {
      return project;
    }
  }

  for (const folder of folders) {
    const nested = findProjectByRelativePath(folder.projects, folder.folders, normalizedRequestedPath);
    if (nested) return nested;
  }

  return undefined;
}

async function loadCurrentHostedProject(
  projectId: string,
  requestedPath: string,
): Promise<{
  sourceProject: Project;
  sourcePath: string;
}> {
  // An open editor tab can retain the previous path briefly while a tree move
  // or rename is reconciled. The metadata id is stable across both operations,
  // so resolve it through the authoritative current tree before loading. A
  // relative project path is only a compatibility fallback for old editor
  // clients; it is still resolved through that tree and never read directly
  // from the request.
  const tree = await getWorkflowTree();
  const currentProject =
    findProjectByMetadataId(tree.projects, tree.folders, projectId) ??
    findProjectByRelativePath(tree.projects, tree.folders, requestedPath);
  if (!currentProject) {
    throw badRequest('The local replay project is no longer available on Studio Server.');
  }

  const sourcePath = currentProject.absolutePath;
  const source = await loadHostedProject(sourcePath);
  const [sourceProject] = parseProjectSnapshot(source.contents, 'The saved project');

  if (sourceProject.metadata.id !== projectId) {
    throw badRequest('The local replay does not belong to the saved hosted project.');
  }

  return { sourceProject, sourcePath };
}

async function reportOutcome(
  correlationId: string,
  availability: z.infer<typeof persistenceAvailabilitySchema> | 'available',
  recordingId?: string,
): Promise<void> {
  await (
    await getLLMProfileHealthStore()
  ).recordRecordingOutcome({
    correlationId,
    availability,
    recordingId,
  });
}

async function reportOutcomeBestEffort(
  correlationId: string,
  availability: z.infer<typeof persistenceAvailabilitySchema> | 'available',
  recordingId?: string,
): Promise<void> {
  await reportOutcome(correlationId, availability, recordingId).catch((error) => {
    console.error('[llm-profile-health] Failed to resolve local replay evidence:', error);
  });
}

localEditorRecordingsRouter.post(
  '/outcome',
  validateBody(recordingOutcomeSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof recordingOutcomeSchema>;
    await reportOutcomeBestEffort(body.correlationId, body.availability);
    res.status(204).end();
  }),
);

localEditorRecordingsRouter.post(
  '/',
  validateBody(localEditorRecordingSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof localEditorRecordingSchema>;

    if (!isWorkflowRecordingEnabled()) {
      await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'disabled');
      res.json({ availability: 'disabled' });
      return;
    }

    try {
      const { sourceProject, sourcePath } = await loadCurrentHostedProject(body.projectId, body.projectPath);
      const [executedProject, executedAttachedData] = parseProjectSnapshot(
        body.projectContents,
        'The execution snapshot',
      );

      if (executedProject.metadata.id !== body.projectId) {
        throw badRequest('The local replay does not belong to the saved hosted project.');
      }

      let executedDatasets: CombinedDataset[] = [];
      if (body.datasetsContents != null) {
        try {
          executedDatasets = deserializeDatasets(body.datasetsContents);
        } catch {
          throw badRequest('The execution dataset snapshot is invalid.');
        }
      }

      const recordingId = await persistWorkflowExecutionRecordingWithBackend({
        sourceProject,
        sourceProjectPath: sourcePath,
        executedProject,
        executedAttachedData,
        executedDatasets,
        endpointName: 'Local editor',
        recordingSerialized: body.recordingSerialized,
        runKind: 'editor',
        status: body.status,
        durationMs: body.durationMs,
        errorMessage: body.errorMessage,
        executionIdentity: {
          surface: 'editor_local',
          graphId: body.executionIdentity.graphId,
          graphName: body.executionIdentity.graphName,
          correlationId: body.executionIdentity.correlationId,
        },
      });

      if (recordingId == null) {
        await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'disabled');
        res.json({ availability: 'disabled' });
        return;
      }

      await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'available', recordingId);
      res.status(201).json({ availability: 'available', recordingId });
    } catch (error) {
      await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'persistence-failed');
      throw error;
    }
  }),
);
