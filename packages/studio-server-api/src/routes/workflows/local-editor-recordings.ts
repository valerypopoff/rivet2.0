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
import { createControlPlaneJsonBodyParser, createJsonBodyParser } from '../../middleware/body-parsers.js';
import { badRequest, createHttpError, conflict, type HttpError } from '../../utils/httpError.js';
import {
  getLLMProfileHealthStore,
  getWorkflowTree,
  loadHostedProject,
  persistWorkflowExecutionRecordingWithBackend,
} from './storage-backend.js';
import { isWorkflowRecordingEnabled } from './recordings-config.js';
import { reportRecordingFailure } from './recording-diagnostics.js';
import { MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES } from './local-editor-recording-limits.js';
import { getRunEvidenceRepository, beginChildEvidence, unavailableRunEvidence } from './run-evidence.js';
import { isRecordingMemoryCapacityError } from './recording-memory.js';
import { isTrustedExecutorRequest } from '../../auth.js';
import { getManagedWorkflowProjectVirtualPath } from './virtual-paths.js';
import { getManagedWorkflowRelativePathFromVirtualPath } from '../../../../studio-server-shared/workflow-types.js';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';
import { WORKFLOW_RECORDING_CREATED_AT_HEADER } from '../../../../studio-server-shared/workflow-recording-time.js';

export const localEditorRecordingsRouter = Router();
const outcomeJsonBody = createControlPlaneJsonBodyParser();
const recordingJsonBody = createJsonBodyParser(() => MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES);
const recordingCreatedAtSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .optional();

function parseRecordingCreatedAt(value: string | undefined): string | undefined {
  const result = recordingCreatedAtSchema.safeParse(value);
  if (!result.success) throw badRequest('Invalid recording creation timestamp.');
  return result.data;
}

localEditorRecordingsRouter.get(
  '/capability',
  asyncHandler(async (_req, res) => {
    // Route presence is the compatibility contract. Recording configuration is
    // reported only after a recorded local run actually completes.
    res.json({ supported: true, ...((await getRunEvidenceRepository()) ? { durability: 'run-evidence-v1' } : {}) });
  }),
);

const evidenceHandleSchema = z.object({ id: z.string().uuid(), token: z.string().uuid() }).strict();
const evidenceRegistrationSchema = z
  .object({
    handle: evidenceHandleSchema,
    projectId: z.string().min(1).max(1024),
    createdAt: z.string().datetime({ offset: true }),
    projectPath: z.string().max(16384),
    graphId: z.string().min(1).max(1024),
    correlationId: z.string().min(16).max(95),
  })
  .strict();
localEditorRecordingsRouter.post(
  '/runs/begin',
  outcomeJsonBody,
  validateBody(evidenceRegistrationSchema),
  asyncHandler(async (req, res) => {
    const input = evidenceRegistrationSchema.parse(req.body),
      repository = await getRunEvidenceRepository();
    if (!repository) throw conflict('Durable recording registration is not enabled.');
    const { sourceProject, sourcePath } = await loadCurrentHostedProject(input.projectId, input.projectPath);
    const handle = await repository.begin(
      {
        projectId: input.projectId,
        sourceProjectName: sourceProject.metadata.title,
        createdAt: input.createdAt,
        sourceProjectRelativePath: getManagedWorkflowRelativePathFromVirtualPath(sourcePath) ?? sourcePath,
        endpointName: 'Local editor',
        runKind: 'editor',
        executionIdentity: { surface: 'editor_local', graphId: input.graphId, correlationId: input.correlationId },
      },
      input.handle,
    );
    res.status(201).json({ handle });
  }),
);
const evidenceOperationSchema = z
  .object({
    handle: evidenceHandleSchema,
    outcome: z
      .object({
        state: z.enum(['succeeded', 'failed', 'suspicious', 'unknown']),
        durationMs: z.number().finite().nonnegative().optional(),
        cost: z
          .union([
            z
              .object({ status: z.enum(['complete', 'partial']), knownCostUsd: z.number().finite().nonnegative() })
              .strict(),
            z.object({ status: z.literal('unknown'), knownCostUsd: z.null() }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
for (const operation of ['read', 'heartbeat', 'outcome', 'child-incomplete'] as const) {
  localEditorRecordingsRouter.post(
    '/runs/' + operation,
    outcomeJsonBody,
    validateBody(evidenceOperationSchema),
    asyncHandler(async (req, res) => {
      const { handle, outcome } = evidenceOperationSchema.parse(req.body),
        repository = await getRunEvidenceRepository(true);
      if (!repository) throw conflict('Durable recording registration is not enabled.');
      const summary = await repository.read(handle);
      const executorOwned = summary.sourceRunId?.startsWith('editor-node:');
      if (operation === 'heartbeat' && (!executorOwned || isTrustedExecutorRequest(req)))
        await repository.heartbeat(handle);
      if (operation === 'outcome' && outcome && (!executorOwned || isTrustedExecutorRequest(req)))
        await repository.outcome(handle, outcome);
      if (operation === 'child-incomplete') await repository.childIncomplete(handle);
      res.json(await repository.read(handle));
    }),
  );
}
localEditorRecordingsRouter.post(
  '/runs/executor-owner',
  outcomeJsonBody,
  asyncHandler(async (req, res) => {
    if (!isTrustedExecutorRequest(req)) throw createHttpError(403, 'Forbidden');
    const input = z
      .object({
        projectId: z.string().min(1).max(1024),
        graphId: z.string().min(1).max(1024),
        correlationId: z.string().min(16).max(95),
        requestId: z.string().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const repository = await getRunEvidenceRepository(true);
    const handle = await repository?.adoptExecutor?.(
      input.projectId,
      input.graphId,
      input.correlationId,
      input.requestId,
    );
    if (!handle) throw conflict('The recorded executor request has no matching accepted run.');
    await repository!.heartbeat(handle);
    res.json({ handle });
  }),
);

const persistenceAvailabilitySchema = z.enum(['disabled', 'persistence-failed']);
// A list-row summary is derived metadata. Bound it without discarding a valid
// replay, which retains the full diagnostic under the existing upload limit.
const errorSummarySchema = z
  .string()
  .transform((message) => message.slice(0, 16_384))
  .optional();
const executionIdentitySchema = z
  .object({
    correlationId: z.string().min(1).max(200),
    graphId: z.string().min(1).max(1_024).optional(),
    graphName: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

const localEditorRecordingSchema = z
  .object({
    evidenceHandle: evidenceHandleSchema.optional(),
    projectId: z.string().min(1).max(1_024),
    projectPath: z.string().min(1).max(16_384),
    projectContents: z.string().min(1),
    datasetsContents: z.string().optional(),
    recordingSerialized: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'suspicious']),
    durationMs: z.number().finite().nonnegative(),
    errorMessage: errorSummarySchema,
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

const subgraphEditorRecordingSchema = z
  .object({
    rootEvidenceHandle: evidenceHandleSchema.optional(),
    captureId: z.string().min(1).max(200).optional(),
    projectId: z.string().min(1).max(1_024),
    projectContents: z.string().min(1),
    datasetsContents: z.string().optional(),
    recordingSerialized: z.string().min(1),
    graphId: z.string().min(1).max(1_024),
    revisionKey: z.string().max(1_024).optional(),
    correlationId: z.string().min(16).max(96).optional(),
    status: z.enum(['succeeded', 'failed']),
    durationMs: z.number().finite().nonnegative(),
    errorMessage: errorSummarySchema,
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
        message: `Subgraph replay uploads cannot exceed ${MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES} UTF-8 bytes.`,
      });
    }
  });

const recordingOutcomeSchema = z
  .object({
    evidenceHandle: evidenceHandleSchema.optional(),
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
    reportRecordingFailure(error, { correlationId, recordingId, phase: 'notification' });
  });
}

localEditorRecordingsRouter.post(
  '/outcome',
  outcomeJsonBody,
  validateBody(recordingOutcomeSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof recordingOutcomeSchema>;
    if (body.evidenceHandle) {
      const repository = await getRunEvidenceRepository(true);
      const summary = await repository?.read(body.evidenceHandle);
      if (summary?.executionIdentity?.correlationId !== body.correlationId)
        throw conflict('Run evidence correlation differs.');
      await repository!.unavailable(body.evidenceHandle, 'capture_incomplete');
    }
    await reportOutcomeBestEffort(body.correlationId, body.availability);
    res.status(204).end();
  }),
);

localEditorRecordingsRouter.post(
  '/',
  recordingJsonBody,
  validateBody(localEditorRecordingSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof localEditorRecordingSchema>;
    const createdAt = parseRecordingCreatedAt(req.get(WORKFLOW_RECORDING_CREATED_AT_HEADER));

    if (!isWorkflowRecordingEnabled() && !body.evidenceHandle) {
      await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'disabled');
      res.json({ availability: 'disabled' });
      return;
    }

    try {
      const [executedProject, executedAttachedData] = parseProjectSnapshot(
        body.projectContents,
        'The execution snapshot',
      );
      const repository = body.evidenceHandle ? await getRunEvidenceRepository(true) : undefined;
      const evidence = body.evidenceHandle ? await repository?.read(body.evidenceHandle) : undefined;
      if (
        body.evidenceHandle &&
        (!evidence ||
          evidence.projectId !== body.projectId ||
          evidence.executionIdentity?.correlationId !== body.executionIdentity.correlationId ||
          evidence.executionIdentity?.graphId !== body.executionIdentity.graphId)
      )
        throw conflict('Recording does not match its registered run.');
      const { sourceProject, sourcePath } = evidence
        ? {
            sourceProject: executedProject,
            sourcePath: getManagedWorkflowProjectVirtualPath(evidence.sourceProjectRelativePath),
          }
        : await loadCurrentHostedProject(body.projectId, body.projectPath);
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

      if (body.evidenceHandle && !evidence?.sourceRunId?.startsWith('editor-node:'))
        await repository!.outcome(body.evidenceHandle, { state: body.status, durationMs: body.durationMs });

      const recordingId = await persistWorkflowExecutionRecordingWithBackend({
        evidenceHandle: body.evidenceHandle,
        createdAt,
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
      if (isRecordingMemoryCapacityError(error)) await unavailableRunEvidence(body.evidenceHandle, 'capacity');
      if (body.evidenceHandle && (error as Partial<HttpError>)?.code === 'recording_outcome_pending') {
        const repository = await getRunEvidenceRepository(true);
        const evidence = await repository?.read(body.evidenceHandle).catch(() => undefined);
        if (evidence?.handoffReady && evidence.availability === 'pending') {
          res.status(202).json({ availability: 'pending', recordingId: body.evidenceHandle.id });
          return;
        }
      }
      reportRecordingFailure(error, {
        projectId: body.projectId,
        graphId: body.executionIdentity.graphId,
        correlationId: body.executionIdentity.correlationId,
        runKind: 'editor',
        surface: 'editor_local',
        phase: 'persistence',
      });
      await reportOutcomeBestEffort(body.executionIdentity.correlationId, 'persistence-failed');
      throw error;
    }
  }),
);

localEditorRecordingsRouter.post(
  '/subgraph-run',
  recordingJsonBody,
  validateBody(subgraphEditorRecordingSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof subgraphEditorRecordingSchema>;
    const createdAt = parseRecordingCreatedAt(req.get(WORKFLOW_RECORDING_CREATED_AT_HEADER));
    if (!isWorkflowRecordingEnabled() && !body.rootEvidenceHandle) {
      res.json({ availability: 'disabled' });
      return;
    }

    const repository = body.rootEvidenceHandle ? await getRunEvidenceRepository(true) : undefined;
    let evidenceHandle: z.infer<typeof evidenceHandleSchema> | undefined;
    try {
      const { sourceProject, sourcePath } = await loadCurrentHostedProject(body.projectId, '');
      const [executedProject, executedAttachedData] = parseProjectSnapshot(
        body.projectContents,
        'The Subgraph execution snapshot',
      );
      if (executedProject.metadata.id !== sourceProject.metadata.id) {
        throw badRequest('The Subgraph replay does not belong to the selected hosted project.');
      }
      const executedGraph = Object.values(executedProject.graphs).find((graph) => graph.metadata?.id === body.graphId);
      if (!executedGraph) throw badRequest('The Subgraph replay graph is not in the selected project snapshot.');
      let executedDatasets: CombinedDataset[] = [];
      if (body.datasetsContents) {
        try {
          executedDatasets = deserializeDatasets(body.datasetsContents);
        } catch {
          throw badRequest('The Subgraph execution dataset snapshot is invalid.');
        }
      }
      if (body.rootEvidenceHandle) {
        const root = await repository?.read(body.rootEvidenceHandle);
        if (!root || root.executionIdentity?.correlationId !== body.correlationId || !body.captureId)
          throw conflict('The child recording does not match its root run.');
        evidenceHandle = await beginChildEvidence(
          { handle: body.rootEvidenceHandle, repository: repository! },
          {
            projectId: body.projectId,
            sourceProjectName: sourceProject.metadata.title,
            sourceProjectRelativePath: getManagedWorkflowRelativePathFromVirtualPath(sourcePath) ?? sourcePath,
            endpointName: `Subgraph: ${executedGraph.metadata?.name ?? body.graphId}`,
            runKind: 'editor',
            createdAt,
            executionIdentity: {
              surface: 'subgraph_project',
              graphId: body.graphId,
              correlationId: body.correlationId,
            },
          },
          body.captureId,
        );
        await repository!.outcome(evidenceHandle, { state: body.status, durationMs: body.durationMs });
      }
      const recordingId = await persistWorkflowExecutionRecordingWithBackend({
        evidenceHandle,
        createdAt,
        sourceProject,
        sourceProjectPath: sourcePath,
        executedProject,
        executedAttachedData,
        executedDatasets,
        endpointName: `Subgraph: ${executedGraph.metadata?.name ?? body.graphId}`,
        recordingSerialized: body.recordingSerialized,
        runKind: 'editor',
        status: body.status,
        durationMs: body.durationMs,
        errorMessage: body.errorMessage,
        executionIdentity: {
          surface: 'subgraph_project',
          graphId: body.graphId,
          graphName: executedGraph.metadata?.name,
          revisionKey: body.revisionKey,
          correlationId: body.correlationId,
        },
      });
      res
        .status(recordingId ? 201 : 200)
        .json(recordingId ? { availability: 'available', recordingId } : { availability: 'disabled' });
    } catch (error) {
      if (isRecordingMemoryCapacityError(error)) await unavailableRunEvidence(evidenceHandle, 'capacity');
      if (body.rootEvidenceHandle) await repository?.childIncomplete(body.rootEvidenceHandle).catch(() => undefined);
      reportRecordingFailure(error, {
        projectId: body.projectId,
        graphId: body.graphId,
        correlationId: body.correlationId,
        runKind: 'editor',
        surface: 'subgraph_project',
        phase: 'persistence',
      });
      throw error;
    }
  }),
);
