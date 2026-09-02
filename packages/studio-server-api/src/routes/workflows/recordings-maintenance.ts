import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkflowRecordingRunRow } from './recordings-db.js';
import {
  deleteEmptyWorkflowRecordingWorkflows,
  deleteWorkflowRecordingRunRow,
  getWorkflowRecordingTotalCompressedBytes,
  listWorkflowRecordingRunsOlderThan,
  listWorkflowRecordingRunsOldestFirst,
  replaceWorkflowRecordingIndex,
  type WorkflowRecordingWorkflowRow,
} from './recordings-db.js';
import { getWorkflowRecordingConfig } from './recordings-config.js';
import {
  getWorkflowProjectRecordingsRoot,
  pathExists,
} from './fs-helpers.js';
import { readStoredWorkflowRecordingMetadata } from './recordings-metadata.js';
import { getFilesystemLLMProfileHealthHeldRecordingIds } from '../../llm-profile-health/filesystem-store.js';

function getEndpointRetentionKey(run: WorkflowRecordingRunRow): string {
  return `${run.workflowId}\0${run.endpointNameAtExecution.trim().toLowerCase()}`;
}

function getCompressedBundleSize(run: Pick<
  WorkflowRecordingRunRow,
  'recordingCompressedBytes' | 'projectCompressedBytes' | 'datasetCompressedBytes'
>): number {
  return run.recordingCompressedBytes + run.projectCompressedBytes + run.datasetCompressedBytes;
}

function formatCleanupTarget(row: WorkflowRecordingRunRow): string {
  return `${row.id} (${row.bundlePath})`;
}

export async function rebuildWorkflowRecordingIndex(
  recordingsRoot: string,
  options: { expectedRevision?: number } = {},
): Promise<boolean> {
  const workflows = new Map<string, WorkflowRecordingWorkflowRow>();
  const runs: WorkflowRecordingRunRow[] = [];

  if (await pathExists(recordingsRoot)) {
    const workflowDirectories = await fs.readdir(recordingsRoot, { withFileTypes: true });
    for (const workflowDirectory of workflowDirectories) {
      if (!workflowDirectory.isDirectory() || workflowDirectory.name.startsWith('.')) {
        continue;
      }

      const workflowRecordingRoot = path.join(recordingsRoot, workflowDirectory.name);
      const bundleDirectories = await fs.readdir(workflowRecordingRoot, { withFileTypes: true });

      for (const bundleDirectory of bundleDirectories) {
        if (!bundleDirectory.isDirectory() || bundleDirectory.name.startsWith('.')) {
          continue;
        }

        const bundlePath = path.join(workflowRecordingRoot, bundleDirectory.name);
        const metadata = await readStoredWorkflowRecordingMetadata(bundlePath);
        if (!metadata) {
          continue;
        }

        const existingWorkflow = workflows.get(metadata.workflowId);
        if (!existingWorkflow || metadata.run.createdAt >= existingWorkflow.updatedAt) {
          workflows.set(metadata.workflowId, {
            workflowId: metadata.workflowId,
            sourceProjectMetadataId: metadata.sourceProjectMetadataId,
            sourceProjectPath: metadata.sourceProjectPath,
            sourceProjectRelativePath: metadata.sourceProjectRelativePath,
            sourceProjectName: metadata.sourceProjectName,
            updatedAt: metadata.run.createdAt,
          });
        }
        runs.push(metadata.run);
      }
    }
  }

  return replaceWorkflowRecordingIndex([...workflows.values()], runs, options);
}

export async function deleteRecordingRun(row: WorkflowRecordingRunRow): Promise<void> {
  if (row.bundlePath && await pathExists(row.bundlePath)) {
    await fs.rm(row.bundlePath, { recursive: true, force: true });
  }

  await deleteWorkflowRecordingRunRow(row.id);
}

export async function removeEmptyWorkflowProjectRecordingsRoot(recordingsRoot: string, workflowId: string): Promise<void> {
  const workflowRecordingsRoot = getWorkflowProjectRecordingsRoot(recordingsRoot, workflowId);
  if (!await pathExists(workflowRecordingsRoot)) {
    return;
  }

  const remainingEntries = await fs.readdir(workflowRecordingsRoot, { withFileTypes: true });
  const hasVisibleBundles = remainingEntries.some((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (!hasVisibleBundles) {
    await fs.rm(workflowRecordingsRoot, { recursive: true, force: true });
  }
}

export async function cleanupWorkflowRecordingStorage(): Promise<void> {
  const config = getWorkflowRecordingConfig();
  let heldRecordingIds: ReadonlySet<string>;
  try {
    heldRecordingIds = await getFilesystemLLMProfileHealthHeldRecordingIds();
  } catch (error) {
    // Losing the diagnostic replay is worse than deferring one cleanup pass.
    // Do not delete recordings until the active suspension holds are readable.
    console.error('[workflow-recordings] Skipped retention cleanup because LLM Profile suspension holds could not be read.', error);
    return;
  }
  const rowsToDelete = new Map<string, WorkflowRecordingRunRow>();
  const oldestRows = config.maxRunsPerEndpoint > 0 || config.maxTotalBytes > 0
    ? await listWorkflowRecordingRunsOldestFirst()
    : [];

  if (config.retentionDays > 0) {
    const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    for (const row of await listWorkflowRecordingRunsOlderThan(cutoff)) {
      if (!heldRecordingIds.has(row.id)) rowsToDelete.set(row.id, row);
    }
  }

  if (config.maxRunsPerEndpoint > 0) {
    const rowsByEndpoint = new Map<string, WorkflowRecordingRunRow[]>();

    for (const row of oldestRows) {
      if (heldRecordingIds.has(row.id) || rowsToDelete.has(row.id)) {
        continue;
      }

      const endpointKey = getEndpointRetentionKey(row);
      const existingRows = rowsByEndpoint.get(endpointKey);
      if (existingRows) {
        existingRows.push(row);
      } else {
        rowsByEndpoint.set(endpointKey, [row]);
      }
    }

    for (const endpointRows of rowsByEndpoint.values()) {
      const excessCount = endpointRows.length - config.maxRunsPerEndpoint;
      if (excessCount <= 0) {
        continue;
      }

      for (const row of endpointRows.slice(0, excessCount)) {
        rowsToDelete.set(row.id, row);
      }
    }
  }

  if (config.maxTotalBytes > 0) {
    let totalBytes = await getWorkflowRecordingTotalCompressedBytes();
    for (const row of oldestRows) {
      if (heldRecordingIds.has(row.id)) totalBytes -= getCompressedBundleSize(row);
    }
    if (totalBytes > config.maxTotalBytes) {
      for (const row of rowsToDelete.values()) {
        totalBytes -= getCompressedBundleSize(row);
      }

      if (totalBytes > config.maxTotalBytes) {
        for (const row of oldestRows) {
          if (heldRecordingIds.has(row.id) || rowsToDelete.has(row.id)) {
            continue;
          }

          rowsToDelete.set(row.id, row);
          totalBytes -= getCompressedBundleSize(row);
          if (totalBytes <= config.maxTotalBytes) {
            break;
          }
        }
      }
    }
  }

  for (const row of rowsToDelete.values()) {
    try {
      await deleteRecordingRun(row);
    } catch (error) {
      console.error(
        `[workflow-recordings] Failed to delete recording during cleanup: ${formatCleanupTarget(row)}`,
        error,
      );
    }
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}
