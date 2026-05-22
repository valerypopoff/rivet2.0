import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadProjectFromFile,
  serializeDatasets,
  serializeProject,
  type AttachedData,
  type CombinedDataset,
  type Project,
} from '@valerypopoff/rivet2-node';

import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from '../../../../shared/workflow-recording-types.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  countWorkflowRecordingRuns,
  deleteEmptyWorkflowRecordingWorkflows,
  deleteWorkflowRecordingWorkflowRow,
  getWorkflowRecordingRunRow,
  getWorkflowRecordingStorageState,
  getWorkflowRecordingWorkflowRowsBySourceProjectPath,
  listWorkflowRecordingRunRowsByWorkflowId,
  listWorkflowRecordingRunRowsForWorkflow,
  listWorkflowRecordingWorkflowStatsRows,
  resetWorkflowRecordingDatabaseForTests,
  setWorkflowRecordingStorageState,
  upsertWorkflowRecordingRun,
  upsertWorkflowRecordingWorkflow,
  type WorkflowRecordingRunRow,
} from './recordings-db.js';
import { createWorkflowRecordingStore } from './recordings-store.js';
import { getWorkflowRecordingConfig, isWorkflowRecordingEnabled } from './recordings-config.js';
import {
  ensureWorkflowRecordingsRoot,
  getWorkflowRecordingBundlePath,
  getWorkflowRecordingMetadataPath,
  getWorkflowRecordingsRoot,
  listProjectPathsRecursive,
  pathExists,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import {
  getRecordingArtifactPath,
  readArtifactText,
  serializeArtifact,
  type WorkflowRecordingArtifactKind,
} from './recordings-artifacts.js';
import {
  cleanupWorkflowRecordingStorage,
  deleteRecordingRun,
  rebuildWorkflowRecordingIndex,
  removeEmptyWorkflowProjectRecordingsRoot,
} from './recordings-maintenance.js';
import { type StoredWorkflowRecordingMetadataV2 } from './recordings-metadata.js';
import { getWorkflowProject } from './workflow-query.js';
import { filterRowsBySerializedRecordingInputPage } from './recording-input-filter.js';

type PersistWorkflowExecutionRecordingOptions = {
  workflowsRoot: string;
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  errorMessage?: string;
};

type WorkflowRecordingStorageCounts = {
  workflowCount: number;
  runCount: number;
};

type WorkflowRecordingDiskCounts = WorkflowRecordingStorageCounts & {
  completedBundleSignature: string;
};

type WorkflowRecordingMetadataState = {
  bundleKey: string;
  mtimeMs: number;
  size: number;
};

const workflowRecordingStore = createWorkflowRecordingStore({
  rebuildIndex: rebuildWorkflowRecordingIndex,
  cleanupStorage: cleanupWorkflowRecordingStorage,
  setSchemaVersion: (version) => setWorkflowRecordingStorageState('schema-version', version),
  resetDatabaseForTests: resetWorkflowRecordingDatabaseForTests,
});

let unresolvedWorkflowRecordingDriftSignature: string | null = null;

export function enqueueWorkflowExecutionRecordingPersistence(task: () => Promise<void>): boolean {
  return workflowRecordingStore.enqueuePersistence(task);
}

function toWorkflowRecordingRunSummary(row: WorkflowRecordingRunRow): WorkflowRecordingRunSummary {
  return {
    id: row.id,
    workflowId: row.workflowId,
    createdAt: row.createdAt,
    runKind: row.runKind,
    status: row.status,
    durationMs: row.durationMs,
    endpointNameAtExecution: row.endpointNameAtExecution,
    errorMessage: row.errorMessage,
    hasReplayDataset: row.hasReplayDataset,
    recordingCompressedBytes: row.recordingCompressedBytes,
    recordingUncompressedBytes: row.recordingUncompressedBytes,
    projectCompressedBytes: row.projectCompressedBytes,
    projectUncompressedBytes: row.projectUncompressedBytes,
    datasetCompressedBytes: row.datasetCompressedBytes,
    datasetUncompressedBytes: row.datasetUncompressedBytes,
  };
}

async function ensureWorkflowRecordingStorage(root?: string): Promise<string> {
  const recordingsRoot = getWorkflowRecordingsRoot(root);
  await workflowRecordingStore.ensureStorage(recordingsRoot);
  return recordingsRoot;
}

function getWorkflowRecordingDriftSignature(
  recordingsRoot: string,
  diskCounts: WorkflowRecordingDiskCounts,
  indexedCounts: WorkflowRecordingStorageCounts,
): string {
  return [
    recordingsRoot,
    diskCounts.workflowCount,
    diskCounts.runCount,
    diskCounts.completedBundleSignature,
    indexedCounts.workflowCount,
    indexedCounts.runCount,
  ].join(':');
}

async function countIndexedWorkflowRecordings(): Promise<WorkflowRecordingStorageCounts> {
  const indexedWorkflows = await listWorkflowRecordingWorkflowStatsRows();
  return {
    workflowCount: indexedWorkflows.length,
    runCount: indexedWorkflows.reduce((total, workflow) => total + workflow.totalRuns, 0),
  };
}

async function getRecordingMetadataState(
  metadataPath: string,
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.stat(metadataPath);
    return stat.isFile()
      ? {
          mtimeMs: Math.round(stat.mtimeMs),
          size: stat.size,
        }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function countRecordingBundlesOnDisk(recordingsRoot: string): Promise<WorkflowRecordingDiskCounts> {
  if (!await pathExists(recordingsRoot)) {
    return { workflowCount: 0, runCount: 0, completedBundleSignature: '' };
  }

  const workflowDirectories = (await fs.readdir(recordingsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const workflowStates = await Promise.all(
    workflowDirectories.map(async (workflowDirectory) => {
      const workflowRoot = path.join(recordingsRoot, workflowDirectory.name);
      const bundleDirectories = (await fs.readdir(workflowRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name));
      const completedBundleStates = await Promise.all(
        bundleDirectories.map(async (entry) => {
          const metadataState = await getRecordingMetadataState(
            getWorkflowRecordingMetadataPath(path.join(workflowRoot, entry.name)),
          );

          return metadataState
            ? {
                ...metadataState,
                bundleKey: `${workflowDirectory.name}/${entry.name}`,
              }
            : null;
        }),
      );
      const completedBundles = completedBundleStates.filter(
        (state): state is WorkflowRecordingMetadataState => state != null,
      );
      return {
        runCount: completedBundles.length,
        completedBundleSignatures: completedBundles.map((state) => [
          state.bundleKey,
          state.mtimeMs,
          state.size,
        ].join(':')),
      };
    }),
  );
  const completedBundleSignature = createHash('sha256')
    .update(workflowStates.flatMap((state) => state.completedBundleSignatures).join('|'))
    .digest('hex');

  return {
    workflowCount: workflowStates.filter((state) => state.runCount > 0).length,
    runCount: workflowStates.reduce((total, state) => total + state.runCount, 0),
    completedBundleSignature,
  };
}

async function repairWorkflowRecordingIndexIfDrifted(recordingsRoot: string): Promise<void> {
  const indexedCounts = await countIndexedWorkflowRecordings();
  const diskCounts = await countRecordingBundlesOnDisk(recordingsRoot);

  if (
    indexedCounts.workflowCount === diskCounts.workflowCount &&
    indexedCounts.runCount === diskCounts.runCount
  ) {
    unresolvedWorkflowRecordingDriftSignature = null;
    return;
  }

  const driftSignature = getWorkflowRecordingDriftSignature(recordingsRoot, diskCounts, indexedCounts);
  if (unresolvedWorkflowRecordingDriftSignature === driftSignature) {
    return;
  }

  await rebuildWorkflowRecordingIndex(recordingsRoot);
  const repairedIndexedCounts = await countIndexedWorkflowRecordings();

  if (
    repairedIndexedCounts.workflowCount === diskCounts.workflowCount &&
    repairedIndexedCounts.runCount === diskCounts.runCount
  ) {
    unresolvedWorkflowRecordingDriftSignature = null;
    return;
  }

  unresolvedWorkflowRecordingDriftSignature = getWorkflowRecordingDriftSignature(
    recordingsRoot,
    diskCounts,
    repairedIndexedCounts,
  );
  console.warn(
    '[workflow-recordings] Recording index repair did not converge; ' +
      'suppressing repeated repair until the on-disk completed-bundle signature or indexed counts change.',
    { recordingsRoot, diskCounts, indexedCounts: repairedIndexedCounts },
  );
}

export async function initializeWorkflowRecordingStorage(root?: string): Promise<void> {
  const recordingsRoot = await ensureWorkflowRecordingsRoot(root);
  await workflowRecordingStore.ensureStorage(recordingsRoot);
}

export async function listWorkflowRecordingWorkflows(root: string): Promise<WorkflowRecordingWorkflowListResponse> {
  const recordingsRoot = await ensureWorkflowRecordingStorage(root);
  await repairWorkflowRecordingIndexIfDrifted(recordingsRoot);

  const recordingWorkflows = await listWorkflowRecordingWorkflowStatsRows();
  const recordingWorkflowByPath = new Map(recordingWorkflows.map((workflow) => [workflow.sourceProjectPath, workflow]));
  const recordingWorkflowById = new Map(recordingWorkflows.map((workflow) => [workflow.workflowId, workflow]));

  const projectPaths = await listProjectPathsRecursive(root);
  const workflows: WorkflowRecordingWorkflowSummary[] = [];

  for (const projectPath of projectPaths) {
    const project = await getWorkflowProject(root, projectPath);
    const workflowByPath = recordingWorkflowByPath.get(projectPath);
    let workflowId = workflowByPath?.workflowId ?? '';

    if (!workflowId) {
      try {
        workflowId = (await loadProjectFromFile(projectPath)).metadata.id ?? '';
      } catch (error) {
        console.warn(`Failed to load workflow project metadata for recordings: ${projectPath}`, error);
      }
    }

    const recordingWorkflow = (workflowId ? recordingWorkflowById.get(workflowId) : undefined) ?? workflowByPath;
    const shouldIncludeProject = Boolean(recordingWorkflow) ||
      (project.settings.status !== 'unpublished' && Boolean(project.settings.endpointName));

    if (!shouldIncludeProject) {
      continue;
    }

    workflows.push({
      workflowId: workflowId || recordingWorkflow?.workflowId || project.absolutePath,
      project,
      latestRunAt: recordingWorkflow?.latestRunAt,
      totalRuns: recordingWorkflow?.totalRuns ?? 0,
      failedRuns: recordingWorkflow?.failedRuns ?? 0,
      suspiciousRuns: recordingWorkflow?.suspiciousRuns ?? 0,
    });
  }

  workflows.sort((left, right) => {
    const latestLeft = left.latestRunAt ?? '';
    const latestRight = right.latestRunAt ?? '';
    if (latestLeft && latestRight && latestLeft !== latestRight) {
      return latestRight.localeCompare(latestLeft);
    }

    if (latestLeft && !latestRight) {
      return -1;
    }

    if (!latestLeft && latestRight) {
      return 1;
    }

    return left.project.name.localeCompare(right.project.name);
  });

  return { workflows };
}

export async function listWorkflowRecordingRunsPage(
  root: string,
  workflowId: string,
  page: number,
  pageSize: number,
  statusFilter: WorkflowRecordingFilterStatus,
  inputFilter: WorkflowRecordingInputFilter | null = null,
  inputCursor = 0,
  signal?: AbortSignal,
): Promise<WorkflowRecordingRunsPageResponse> {
  const recordingsRoot = await ensureWorkflowRecordingStorage(root);
  await repairWorkflowRecordingIndexIfDrifted(recordingsRoot);

  const normalizedPage = Math.max(1, Math.floor(page));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  if (inputFilter) {
    const filteredPage = await listWorkflowRecordingRowsMatchingInputFilter(
      workflowId,
      statusFilter,
      inputFilter,
      inputCursor,
      normalizedPageSize,
      signal,
    );

    return {
      workflowId,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalRuns: filteredPage.totalRuns,
      totalRunsExact: filteredPage.totalRunsExact,
      hasMore: filteredPage.hasMore,
      nextInputCursor: filteredPage.nextInputCursor,
      statusFilter,
      inputFilter,
      runs: filteredPage.rows.map(toWorkflowRecordingRunSummary),
    };
  }

  const totalRuns = await countWorkflowRecordingRuns(workflowId, statusFilter);
  const rows = await listWorkflowRecordingRunRowsByWorkflowId(workflowId, {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    statusFilter,
  });

  return {
    workflowId,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalRuns,
    totalRunsExact: true,
    hasMore: normalizedPage * normalizedPageSize < totalRuns,
    statusFilter,
    inputFilter,
    runs: rows.map(toWorkflowRecordingRunSummary),
  };
}

async function listWorkflowRecordingRowsMatchingInputFilter(
  workflowId: string,
  statusFilter: WorkflowRecordingFilterStatus,
  inputFilter: WorkflowRecordingInputFilter,
  inputCursor: number,
  pageSize: number,
  signal?: AbortSignal,
) {
  const rows = (await listWorkflowRecordingRunRowsForWorkflow(workflowId))
    .filter((row) => statusFilter === 'all' || row.status === 'failed' || row.status === 'suspicious');
  return filterRowsBySerializedRecordingInputPage(rows, inputFilter, async (row) => {
    const recordingPath = getRecordingArtifactPath(row.bundlePath, 'recording', row.encoding);
    if (!await pathExists(recordingPath)) {
      return null;
    }

    return readArtifactText(recordingPath, row.encoding);
  }, {
    cursor: inputCursor,
    pageSize,
    signal,
  });
}

export async function readWorkflowRecordingArtifact(
  root: string,
  recordingId: string,
  artifact: WorkflowRecordingArtifactKind,
): Promise<string> {
  const recordingsRoot = await ensureWorkflowRecordingStorage(root);
  await repairWorkflowRecordingIndexIfDrifted(recordingsRoot);

  const row = await getWorkflowRecordingRunRow(recordingId);
  if (!row) {
    throw createHttpError(404, 'Recording not found');
  }

  if (artifact === 'replay-dataset' && !row.hasReplayDataset) {
    throw createHttpError(404, 'Replay dataset not found');
  }

  const filePath = getRecordingArtifactPath(row.bundlePath, artifact, row.encoding);
  if (!await pathExists(filePath)) {
    throw createHttpError(404, 'Recording artifact not found');
  }

  return readArtifactText(filePath, row.encoding);
}

export async function deleteWorkflowRecording(root: string, recordingId: string): Promise<void> {
  const recordingsRoot = await ensureWorkflowRecordingStorage(root);
  await repairWorkflowRecordingIndexIfDrifted(recordingsRoot);

  const row = await getWorkflowRecordingRunRow(recordingId);
  if (!row) {
    throw createHttpError(404, 'Recording not found');
  }

  await deleteRecordingRun(row);

  const remainingRuns = await listWorkflowRecordingRunRowsForWorkflow(row.workflowId);
  if (remainingRuns.length === 0) {
    await deleteWorkflowRecordingWorkflowRow(row.workflowId);
    await removeEmptyWorkflowProjectRecordingsRoot(recordingsRoot, row.workflowId);
    return;
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}

export async function persistWorkflowExecutionRecording(
  options: PersistWorkflowExecutionRecordingOptions,
): Promise<void> {
  if (!isWorkflowRecordingEnabled()) {
    return;
  }

  const workflowId = options.sourceProject.metadata.id;
  if (!workflowId) {
    return;
  }

  const recordingsRoot = getWorkflowRecordingsRoot(options.workflowsRoot);
  await workflowRecordingStore.ensureStorage(recordingsRoot);

  const config = getWorkflowRecordingConfig();
  const recordingId = `${Date.now()}-${randomUUID()}`;
  const bundlePath = getWorkflowRecordingBundlePath(recordingsRoot, workflowId, recordingId);
  const sourceProjectName = path.basename(options.sourceProjectPath, PROJECT_EXTENSION);
  const sourceProjectRelativePath = path.relative(options.workflowsRoot, options.sourceProjectPath).replace(/\\/g, '/');
  const createdAt = new Date().toISOString();
  const replayProject: Project = {
    ...options.executedProject,
    metadata: {
      ...options.executedProject.metadata,
      id: randomUUID() as Project['metadata']['id'],
    },
  };

  try {
    await fs.mkdir(bundlePath, { recursive: true });

    const serializedReplayProject = serializeProject(replayProject, options.executedAttachedData);
    if (typeof serializedReplayProject !== 'string') {
      throw new Error('Serialized replay project is not a string');
    }

    const recordingArtifact = await serializeArtifact(
      options.recordingSerialized,
      config.compression,
      config.gzipLevel,
    );
    const replayProjectArtifact = await serializeArtifact(
      serializedReplayProject,
      config.compression,
      config.gzipLevel,
    );

    const recordingPath = getRecordingArtifactPath(bundlePath, 'recording', config.compression);
    const replayProjectPath = getRecordingArtifactPath(bundlePath, 'replay-project', config.compression);

    await fs.writeFile(recordingPath, recordingArtifact.buffer);
    await fs.writeFile(replayProjectPath, replayProjectArtifact.buffer);

    let datasetArtifact:
      | { buffer: Buffer; compressedBytes: number; uncompressedBytes: number }
      | undefined;
    let hasReplayDataset = false;

    if (options.executedDatasets.length > 0) {
      datasetArtifact = await serializeArtifact(
        serializeDatasets(options.executedDatasets),
        config.compression,
        config.gzipLevel,
      );
      await fs.writeFile(getRecordingArtifactPath(bundlePath, 'replay-dataset', config.compression), datasetArtifact.buffer);
      hasReplayDataset = true;
    }

    const metadata: StoredWorkflowRecordingMetadataV2 = {
      version: 2,
      id: recordingId,
      workflowId,
      sourceProjectMetadataId: workflowId,
      sourceProjectName,
      sourceProjectPath: options.sourceProjectPath,
      sourceProjectRelativePath,
      endpointNameAtExecution: options.endpointName,
      createdAt,
      runKind: options.runKind,
      status: options.status,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      encoding: config.compression,
      hasReplayDataset,
      recordingCompressedBytes: recordingArtifact.compressedBytes,
      recordingUncompressedBytes: recordingArtifact.uncompressedBytes,
      projectCompressedBytes: replayProjectArtifact.compressedBytes,
      projectUncompressedBytes: replayProjectArtifact.uncompressedBytes,
      datasetCompressedBytes: datasetArtifact?.compressedBytes ?? 0,
      datasetUncompressedBytes: datasetArtifact?.uncompressedBytes ?? 0,
      errorMessage: options.errorMessage,
    };

    await fs.writeFile(
      getWorkflowRecordingMetadataPath(bundlePath),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );

    await upsertWorkflowRecordingWorkflow({
      workflowId,
      sourceProjectMetadataId: workflowId,
      sourceProjectPath: options.sourceProjectPath,
      sourceProjectRelativePath,
      sourceProjectName,
      updatedAt: createdAt,
    });
    await upsertWorkflowRecordingRun({
      id: recordingId,
      workflowId,
      createdAt,
      runKind: options.runKind,
      status: options.status,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      endpointNameAtExecution: options.endpointName,
      errorMessage: options.errorMessage,
      bundlePath,
      encoding: config.compression,
      hasReplayDataset,
      recordingCompressedBytes: recordingArtifact.compressedBytes,
      recordingUncompressedBytes: recordingArtifact.uncompressedBytes,
      projectCompressedBytes: replayProjectArtifact.compressedBytes,
      projectUncompressedBytes: replayProjectArtifact.uncompressedBytes,
      datasetCompressedBytes: datasetArtifact?.compressedBytes ?? 0,
      datasetUncompressedBytes: datasetArtifact?.uncompressedBytes ?? 0,
    });

    workflowRecordingStore.scheduleCleanup();
  } catch (error) {
    await fs.rm(bundlePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function deleteWorkflowRecordingsBySourceProjectPath(root: string, projectPath: string): Promise<void> {
  const recordingsRoot = await ensureWorkflowRecordingStorage(root);

  const relativePath = path.relative(root, projectPath).replace(/\\/g, '/');
  const workflows = await getWorkflowRecordingWorkflowRowsBySourceProjectPath(projectPath, relativePath);

  for (const workflow of workflows) {
    const runs = await listWorkflowRecordingRunRowsForWorkflow(workflow.workflowId);
    for (const run of runs) {
      await deleteRecordingRun(run);
    }

    await deleteWorkflowRecordingWorkflowRow(workflow.workflowId);

    await removeEmptyWorkflowProjectRecordingsRoot(recordingsRoot, workflow.workflowId);
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}

export async function deleteWorkflowRecordingsByWorkflowId(
  root: string,
  workflowId: string | null | undefined,
): Promise<void> {
  if (!workflowId) {
    return;
  }

  const recordingsRoot = await ensureWorkflowRecordingStorage(root);

  const runs = await listWorkflowRecordingRunRowsForWorkflow(workflowId);
  for (const run of runs) {
    await deleteRecordingRun(run);
  }

  await deleteWorkflowRecordingWorkflowRow(workflowId);

  await removeEmptyWorkflowProjectRecordingsRoot(recordingsRoot, workflowId);
}

export async function resetWorkflowRecordingStorageForTests(): Promise<void> {
  unresolvedWorkflowRecordingDriftSignature = null;
  await workflowRecordingStore.resetForTests();
}

export async function getWorkflowRecordingStorageSchemaVersion(): Promise<string | null> {
  return getWorkflowRecordingStorageState('schema-version');
}
