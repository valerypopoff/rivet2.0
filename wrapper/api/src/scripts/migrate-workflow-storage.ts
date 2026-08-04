import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';

import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import type { WorkflowFolderItem, WorkflowProjectItem } from '../../../shared/workflow-types.js';
import type { WorkflowRecordingWorkflowSummary } from '../../../shared/workflow-recording-types.js';
import { listWorkflowFolders } from '../routes/workflows/workflow-query.js';
import {
  getPublishedWorkflowSnapshotDatasetPath,
  getPublishedWorkflowSnapshotPath,
  listProjectPathsRecursive,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
} from '../routes/workflows/fs-helpers.js';
import { readStoredWorkflowProjectSettings, resolvePublishedWorkflowProjectPath } from '../routes/workflows/publication.js';
import {
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  readWorkflowRecordingArtifact,
} from '../routes/workflows/recordings.js';
import { getManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import {
  collectFolderPaths,
  deriveSourceWorkflowStatus,
  flattenProjects,
  flattenProjectsFromRecordingSummary,
  type SourceWorkflowSnapshot,
  type VerificationSummary,
  verifyMigrationState,
} from './migrate-workflow-storage-lib.js';

type SourceWorkflow = {
  workflowId: string;
  relativePath: string;
  name: string;
  fileName: string;
  updatedAt: string;
  contents: string;
  datasetsContents: string | null;
  endpointName: string;
  publishedEndpointName: string;
  lastPublishedAt: string | null;
  publishedContents: string | null;
  publishedDatasetsContents: string | null;
  publishedWebApps: SourcePublishedWebApp[];
};

type SourcePublishedWebApp = {
  uiGraphId: string;
  slug: string;
  publishedAt: string;
  contents: string;
  datasetsContents: string | null;
};

function loadNearestEnvFile(startDir: string): void {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const fileName of ['.env', '.env.dev']) {
      const candidate = path.join(currentDir, fileName);
      if (existsSync(candidate)) {
        loadDotEnv({ path: candidate });
        return;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }

    currentDir = parentDir;
  }
}

loadNearestEnvFile(process.cwd());

function normalizeRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, '/');
}

function getSourceRoot(): string {
  const cliSourceRoot = process.argv.find((arg) => arg.startsWith('--source-root='))?.slice('--source-root='.length);
  const envSourceRoot = process.env.RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT?.trim();
  const sourceRoot = cliSourceRoot?.trim() || envSourceRoot || process.env.RIVET_WORKFLOWS_ROOT?.trim();
  if (!sourceRoot) {
    throw new Error('Missing source workflows root. Set RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT or RIVET_WORKFLOWS_ROOT.');
  }

  return path.resolve(sourceRoot);
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  return await pathExists(filePath) ? await fs.readFile(filePath, 'utf8') : null;
}

async function readSourcePublishedWebApps(
  root: string,
  settings: Awaited<ReturnType<typeof readStoredWorkflowProjectSettings>>,
): Promise<SourcePublishedWebApp[]> {
  const webApps: SourcePublishedWebApp[] = [];

  for (const webApp of settings.publishedWebApps) {
    const snapshotPath = getPublishedWorkflowSnapshotPath(root, webApp.publishedSnapshotId);
    if (!await pathExists(snapshotPath)) {
      continue;
    }

    webApps.push({
      uiGraphId: webApp.uiGraphId,
      slug: webApp.slug,
      publishedAt: webApp.publishedAt,
      contents: await fs.readFile(snapshotPath, 'utf8'),
      datasetsContents: await readOptionalUtf8(getPublishedWorkflowSnapshotDatasetPath(root, webApp.publishedSnapshotId)),
    });
  }

  return webApps;
}

async function collectSourceWorkflows(root: string): Promise<SourceWorkflow[]> {
  const projectPaths = await listProjectPathsRecursive(root);
  const workflows: SourceWorkflow[] = [];

  for (const projectPath of projectPaths) {
    const relativePath = normalizeRelativePath(root, projectPath);
    const fileName = path.basename(projectPath);
    const name = path.basename(projectPath, PROJECT_EXTENSION);
    const stats = await fs.stat(projectPath);
    const project = await loadProjectFromFile(projectPath);
    const settings = await readStoredWorkflowProjectSettings(projectPath, name);
    const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, settings);

    workflows.push({
      workflowId: project.metadata.id ?? relativePath,
      relativePath,
      name,
      fileName,
      updatedAt: stats.mtime.toISOString(),
      contents: await fs.readFile(projectPath, 'utf8'),
      datasetsContents: await readOptionalUtf8(getWorkflowDatasetPath(projectPath)),
      endpointName: settings.endpointName,
      publishedEndpointName: settings.publishedEndpointName,
      lastPublishedAt: settings.lastPublishedAt,
      publishedContents: publishedProjectPath ? await fs.readFile(publishedProjectPath, 'utf8') : null,
      publishedDatasetsContents: publishedProjectPath
        ? await readOptionalUtf8(getWorkflowDatasetPath(publishedProjectPath))
        : null,
      publishedWebApps: await readSourcePublishedWebApps(root, settings),
    });
  }

  workflows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return workflows;
}

async function importSourceWorkflows(root: string, backend: ManagedWorkflowBackend): Promise<Map<string, WorkflowProjectItem>> {
  const sourceWorkflows = await collectSourceWorkflows(root);
  const importedProjects = new Map<string, WorkflowProjectItem>();

  for (const workflow of sourceWorkflows) {
    const importedProject = await backend.importWorkflow({
      workflowId: workflow.workflowId,
      relativePath: workflow.relativePath,
      name: workflow.name,
      fileName: workflow.fileName,
      updatedAt: workflow.updatedAt,
      contents: workflow.contents,
      datasetsContents: workflow.datasetsContents,
      endpointName: workflow.endpointName,
      publishedEndpointName: workflow.publishedEndpointName,
      lastPublishedAt: workflow.lastPublishedAt,
      publishedContents: workflow.publishedContents,
      publishedDatasetsContents: workflow.publishedDatasetsContents,
      publishedWebApps: workflow.publishedWebApps,
    });

    importedProjects.set(workflow.relativePath, importedProject);
    console.log(`[workflow-storage:migrate] Imported workflow ${workflow.relativePath}`);
  }

  return importedProjects;
}

async function importSourceRecordings(root: string, backend: ManagedWorkflowBackend, importedProjects: Map<string, WorkflowProjectItem>): Promise<void> {
  await initializeWorkflowRecordingStorage(root);
  const sourceRecordingWorkflows = await listWorkflowRecordingWorkflows(root);

  for (const sourceWorkflow of sourceRecordingWorkflows.workflows) {
    const relativePath = sourceWorkflow.project.relativePath;
    const importedProject = importedProjects.get(relativePath);
    if (!importedProject) {
      console.warn(`[workflow-storage:migrate] Skipping recordings for ${relativePath} because the workflow was not imported.`);
      continue;
    }

    let page = 1;
    const pageSize = 100;
    while (true) {
      const runsPage = await listWorkflowRecordingRunsPage(root, sourceWorkflow.workflowId, page, pageSize, 'all');
      for (const run of runsPage.runs) {
        const recordingContents = await readWorkflowRecordingArtifact(root, run.id, 'recording');
        const replayProjectContents = await readWorkflowRecordingArtifact(root, run.id, 'replay-project');
        const replayDatasetContents = run.hasReplayDataset
          ? await readWorkflowRecordingArtifact(root, run.id, 'replay-dataset')
          : null;

        await backend.importWorkflowRecording({
          recordingId: run.id,
          workflowId: importedProject.id,
          sourceProjectRelativePath: relativePath,
          sourceProjectName: sourceWorkflow.project.name,
          createdAt: run.createdAt,
          runKind: run.runKind,
          status: run.status,
          durationMs: run.durationMs,
          endpointName: run.endpointNameAtExecution,
          errorMessage: run.errorMessage,
          executionIdentity: run.executionIdentity,
          recordingContents,
          replayProjectContents,
          replayDatasetContents,
        });
      }

      if (page * pageSize >= runsPage.totalRuns) {
        break;
      }

      page += 1;
    }

    if (sourceWorkflow.totalRuns > 0) {
      console.log(`[workflow-storage:migrate] Imported ${sourceWorkflow.totalRuns} recordings for ${relativePath}`);
    }
  }
}

async function verifyMigration(root: string, backend: ManagedWorkflowBackend): Promise<VerificationSummary> {
  const [sourceFolders, sourceWorkflows, sourceRecordingWorkflows, targetTree, targetRecordingWorkflows] = await Promise.all([
    listWorkflowFolders(root),
    collectSourceWorkflows(root),
    listWorkflowRecordingWorkflows(root),
    backend.getTree(),
    backend.listWorkflowRecordingWorkflows(),
  ]);

  const sourceFolderPaths = collectFolderPaths(sourceFolders);
  const targetFolderPaths = collectFolderPaths(targetTree.folders);
  const sourceProjectState = sourceWorkflows.map((workflow) => ({
    relativePath: workflow.relativePath,
    endpointName: workflow.endpointName,
    lastPublishedAt: workflow.lastPublishedAt,
    status: deriveSourceWorkflowStatus(workflow satisfies SourceWorkflowSnapshot),
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const targetProjectState = flattenProjects(targetTree.projects, targetTree.folders)
    .map((project) => ({
      relativePath: project.relativePath,
      endpointName: project.settings.endpointName,
      lastPublishedAt: project.settings.lastPublishedAt,
      status: project.settings.status,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const targetFolderPathSet = new Set(targetFolderPaths);
  for (const sourceFolderPath of sourceFolderPaths) {
    if (!targetFolderPathSet.has(sourceFolderPath)) {
      throw new Error(`Managed workflow folder is missing: ${sourceFolderPath}`);
    }
  }

  const sourceRecordingState = flattenProjectsFromRecordingSummary(sourceRecordingWorkflows.workflows);
  const targetRecordingState = flattenProjectsFromRecordingSummary(targetRecordingWorkflows.workflows);

  return verifyMigrationState({
    sourceFolderPaths,
    targetFolderPaths,
    sourceProjectState,
    targetProjectState,
    sourceRecordingState,
    targetRecordingState,
  });
}

async function main() {
  const mode = process.argv[2] === 'verify' ? 'verify' : 'migrate';
  const sourceRoot = getSourceRoot();
  const backend = new ManagedWorkflowBackend(getManagedWorkflowStorageConfig());

  try {
    console.log(`[workflow-storage:${mode}] Initializing managed backend...`);
    await backend.initialize();
    console.log(`[workflow-storage:${mode}] Managed backend ready.`);

    if (mode === 'migrate') {
      console.log(`[workflow-storage:${mode}] Importing workflows from ${sourceRoot}...`);
      const importedProjects = await importSourceWorkflows(sourceRoot, backend);
      console.log(`[workflow-storage:${mode}] Importing recordings...`);
      await importSourceRecordings(sourceRoot, backend, importedProjects);
      await backend.cleanupWorkflowRecordings();
    }

    console.log(`[workflow-storage:${mode}] Verifying managed state...`);
    const summary = await verifyMigration(sourceRoot, backend);
    console.log(`[workflow-storage:${mode}] Verified ${summary.targetProjectCount} workflows, ${summary.targetFolderCount} folders, and ${summary.targetRecordingWorkflowCount} recording workflow summaries.`);
  } finally {
    await backend.dispose();
  }
}

main().catch((error) => {
  console.error('[workflow-storage] Migration failed:', error);
  process.exit(1);
});
