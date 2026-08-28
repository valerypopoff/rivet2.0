import fs from 'node:fs/promises';

import type {
  WorkflowRecordingBlobEncoding,
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import type { WorkflowRecordingRunRow } from './recordings-db.js';
import {
  getWorkflowRecordingMetadataPath,
  pathExists,
} from './fs-helpers.js';
import {
  getRecordingArtifactPath,
  readArtifactBytes,
} from './recordings-artifacts.js';

export type StoredWorkflowRecordingMetadataV2 = {
  version: 2;
  id: string;
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  endpointNameAtExecution: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  encoding: WorkflowRecordingBlobEncoding;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
  errorMessage?: string;
};

export type StoredWorkflowRecordingMetadataV3 = Omit<StoredWorkflowRecordingMetadataV2, 'version'> & {
  version: 3;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
};

export type StoredWorkflowRecordingMetadataV1 = {
  version: 1;
  id: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  endpointNameAtExecution: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  recordingPath: string;
  replayProjectPath: string;
  errorMessage?: string;
};

export type NormalizedStoredWorkflowRecording = {
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  run: WorkflowRecordingRunRow;
};

export type NormalizedStoredWorkflowRecordingFields = {
  id: string;
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  endpointNameAtExecution: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  errorMessage?: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

function normalizeOptionalErrorMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeExecutionIdentity(value: unknown): WorkflowRecordingExecutionIdentity | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  if (raw.surface !== 'workflow_endpoint' && raw.surface !== 'web_app_action') {
    return undefined;
  }
  const componentType = raw.componentType;
  const optionalString = (field: string) => isNonEmptyString(raw[field]) ? raw[field].trim() : undefined;

  return {
    surface: raw.surface,
    graphId: optionalString('graphId'),
    graphName: optionalString('graphName'),
    revisionKey: optionalString('revisionKey'),
    uiGraphId: optionalString('uiGraphId'),
    uiGraphName: optionalString('uiGraphName'),
    webAppSlug: optionalString('webAppSlug'),
    componentId: optionalString('componentId'),
    componentType: componentType === 'button' || componentType === 'chat' ? componentType : undefined,
    componentLabel: optionalString('componentLabel'),
  };
}

export function normalizeRunKind(value: unknown): WorkflowRecordingRunKind | null {
  return value === 'published' || value === 'latest' ? value : null;
}

export function normalizeStatus(value: unknown): WorkflowRecordingStatus | null {
  return value === 'succeeded' || value === 'failed' || value === 'suspicious' ? value : null;
}

export function normalizeEncoding(value: unknown): WorkflowRecordingBlobEncoding {
  return value === 'identity' ? 'identity' : 'gzip';
}

export function normalizeStoredWorkflowRecordingFields(
  raw: Record<string, unknown>,
  workflowIdValue: unknown,
): NormalizedStoredWorkflowRecordingFields | null {
  const id = raw.id;
  const workflowId = workflowIdValue;
  const sourceProjectMetadataId = raw.sourceProjectMetadataId;
  const sourceProjectName = raw.sourceProjectName;
  const sourceProjectPath = raw.sourceProjectPath;
  const sourceProjectRelativePath = raw.sourceProjectRelativePath;
  const endpointNameAtExecution = raw.endpointNameAtExecution;
  const createdAt = raw.createdAt;
  const durationMs = normalizeNumber(raw.durationMs);
  const runKind = normalizeRunKind(raw.runKind);
  const status = normalizeStatus(raw.status);

  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(workflowId) ||
    !isNonEmptyString(sourceProjectMetadataId) ||
    !isNonEmptyString(sourceProjectName) ||
    !isNonEmptyString(sourceProjectPath) ||
    !isNonEmptyString(sourceProjectRelativePath) ||
    !isNonEmptyString(endpointNameAtExecution) ||
    !isNonEmptyString(createdAt) ||
    durationMs == null ||
    runKind == null ||
    status == null
  ) {
    return null;
  }

  return {
    id,
    workflowId,
    sourceProjectMetadataId,
    sourceProjectName,
    sourceProjectPath,
    sourceProjectRelativePath,
    endpointNameAtExecution,
    createdAt,
    durationMs,
    runKind,
    status,
    errorMessage: normalizeOptionalErrorMessage(raw.errorMessage),
    executionIdentity: normalizeExecutionIdentity(raw.executionIdentity),
  };
}

export async function normalizeStoredWorkflowRecording(
  bundlePath: string,
  value: unknown,
): Promise<NormalizedStoredWorkflowRecording | null> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (raw.version === 2 || raw.version === 3) {
    const normalized = normalizeStoredWorkflowRecordingFields(raw, raw.workflowId);
    if (!normalized) {
      return null;
    }

    return {
      workflowId: normalized.workflowId,
      sourceProjectMetadataId: normalized.sourceProjectMetadataId,
      sourceProjectName: normalized.sourceProjectName,
      sourceProjectPath: normalized.sourceProjectPath,
      sourceProjectRelativePath: normalized.sourceProjectRelativePath,
      run: {
        id: normalized.id,
        workflowId: normalized.workflowId,
        createdAt: normalized.createdAt,
        runKind: normalized.runKind,
        status: normalized.status,
        durationMs: normalized.durationMs,
        endpointNameAtExecution: normalized.endpointNameAtExecution,
        executionIdentity: normalized.executionIdentity,
        errorMessage: normalized.errorMessage,
        bundlePath,
        encoding: normalizeEncoding(raw.encoding),
        hasReplayDataset: raw.hasReplayDataset === true,
        recordingCompressedBytes: normalizeNumber(raw.recordingCompressedBytes) ?? 0,
        recordingUncompressedBytes: normalizeNumber(raw.recordingUncompressedBytes) ?? 0,
        projectCompressedBytes: normalizeNumber(raw.projectCompressedBytes) ?? 0,
        projectUncompressedBytes: normalizeNumber(raw.projectUncompressedBytes) ?? 0,
        datasetCompressedBytes: normalizeNumber(raw.datasetCompressedBytes) ?? 0,
        datasetUncompressedBytes: normalizeNumber(raw.datasetUncompressedBytes) ?? 0,
      },
    };
  }

  if (raw.version === 1) {
    const normalized = normalizeStoredWorkflowRecordingFields(raw, raw.sourceProjectMetadataId);
    if (!normalized) {
      return null;
    }

    const gzipRecordingPath = getRecordingArtifactPath(bundlePath, 'recording', 'gzip');
    const identityRecordingPath = getRecordingArtifactPath(bundlePath, 'recording', 'identity');
    const encoding: WorkflowRecordingBlobEncoding = await pathExists(gzipRecordingPath) ? 'gzip' : 'identity';
    const recordingPath = await pathExists(getRecordingArtifactPath(bundlePath, 'recording', encoding))
      ? getRecordingArtifactPath(bundlePath, 'recording', encoding)
      : await pathExists(identityRecordingPath)
        ? identityRecordingPath
        : gzipRecordingPath;
    const projectPath = await pathExists(getRecordingArtifactPath(bundlePath, 'replay-project', encoding))
      ? getRecordingArtifactPath(bundlePath, 'replay-project', encoding)
      : getRecordingArtifactPath(bundlePath, 'replay-project', 'identity');
    const datasetPath = await pathExists(getRecordingArtifactPath(bundlePath, 'replay-dataset', encoding))
      ? getRecordingArtifactPath(bundlePath, 'replay-dataset', encoding)
      : getRecordingArtifactPath(bundlePath, 'replay-dataset', 'identity');

    const recordingBytes = await readArtifactBytes(recordingPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }));
    const projectBytes = await readArtifactBytes(projectPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }));
    const datasetExists = await pathExists(datasetPath);
    const datasetBytes = datasetExists
      ? await readArtifactBytes(datasetPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }))
      : { compressedBytes: 0, uncompressedBytes: 0 };

    return {
      workflowId: normalized.workflowId,
      sourceProjectMetadataId: normalized.sourceProjectMetadataId,
      sourceProjectName: normalized.sourceProjectName,
      sourceProjectPath: normalized.sourceProjectPath,
      sourceProjectRelativePath: normalized.sourceProjectRelativePath,
      run: {
        id: normalized.id,
        workflowId: normalized.workflowId,
        createdAt: normalized.createdAt,
        runKind: normalized.runKind,
        status: normalized.status,
        durationMs: normalized.durationMs,
        endpointNameAtExecution: normalized.endpointNameAtExecution,
        executionIdentity: normalized.executionIdentity,
        errorMessage: normalized.errorMessage,
        bundlePath,
        encoding,
        hasReplayDataset: datasetExists,
        recordingCompressedBytes: recordingBytes.compressedBytes,
        recordingUncompressedBytes: recordingBytes.uncompressedBytes,
        projectCompressedBytes: projectBytes.compressedBytes,
        projectUncompressedBytes: projectBytes.uncompressedBytes,
        datasetCompressedBytes: datasetBytes.compressedBytes,
        datasetUncompressedBytes: datasetBytes.uncompressedBytes,
      },
    };
  }

  return null;
}

export async function readStoredWorkflowRecordingMetadata(bundlePath: string): Promise<NormalizedStoredWorkflowRecording | null> {
  try {
    const metadataPath = getWorkflowRecordingMetadataPath(bundlePath);
    const contents = await fs.readFile(metadataPath, 'utf8');
    return await normalizeStoredWorkflowRecording(bundlePath, JSON.parse(contents) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }

    console.warn(`Failed to read workflow recording metadata from ${bundlePath}:`, error);
    return null;
  }
}
