import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { Pool } from 'pg';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

import type { WorkflowRecordingWorkflowSummary } from '../../../studio-server-shared/workflow-recording-types.js';
import { listWorkflowFolders } from '../routes/workflows/workflow-query.js';
import { getWorkflowRecordingMetadataPath } from '../routes/workflows/fs-helpers.js';
import {
  enableWorkflowRecordingMigrationCopyMode,
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  readWorkflowRecordingArtifact,
} from '../routes/workflows/recordings.js';
import { listWorkflowRecordingWorkflowStatsRows } from '../routes/workflows/recordings-db.js';
import { readStoredWorkflowRecordingMetadata } from '../routes/workflows/recordings-metadata.js';
import {
  getRecordingArtifactPath,
  readArtifactBytes,
  readArtifactText,
} from '../routes/workflows/recordings-artifacts.js';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { createManagedWorkflowS3ClientConfig } from '../routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowMigrationSnapshot } from '../routes/workflows/managed/types.js';
import { initializeFilesystemProjectTransactions } from '../routes/workflows/filesystem-project-transactions.js';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';
import type { VmMigrationVerificationReport } from '../vm-migration-service.js';
import { collectSourceAppSettings, migrateAppSettings } from './migrate-app-settings.js';
import { migrateOperationalSqlite } from './migrate-operational-sqlite.js';
import { migrateRuntimeLibraries } from './migrate-runtime-libraries.js';
import { createPrecopyAwareMigrationBlobStore, precopyMigrationTexts } from './migration-precopy.js';
import { fingerprintVmMigrationSourceParts, readVmMigrationSourceParts } from './vm-migration-source-manifest.js';
import { recordMigrationProgress } from './migration-progress.js';
import { collectSourceWorkflows, type SourceWorkflow } from '../local-metadata/filesystem-workflow-source.js';
import { SqliteMigrationSource } from './sqlite-migration-source.js';
import {
  acquireVmMigrationImporterLock,
  assertVmMigrationSourceManifest,
  beginVmMigrationTarget,
  bindVmMigrationSourceManifest,
  hasVmMigrationTargetGate,
  invalidateVmMigrationTargetGate,
  migrationSourceIdentity,
  migrationTargetIdentity,
  verifyVmMigrationTargetGate,
} from '../vm-migration-target-gate.js';
import {
  collectFolderPaths,
  flattenProjects,
  flattenProjectsFromRecordingSummary,
  fingerprintWorkflowMigrationState,
  readWorkflowMigrationTargetConfig,
  type VerificationSummary,
  verifyMigrationState,
} from './migrate-workflow-storage-lib.js';

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

function getSourceRoot(): string {
  const cliSourceRoot = process.argv.find((arg) => arg.startsWith('--source-root='))?.slice('--source-root='.length);
  const envSourceRoot = process.env.RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT?.trim();
  const sourceRoot = cliSourceRoot?.trim() || envSourceRoot;
  if (!sourceRoot) {
    throw new Error('Missing source workflows root. Set RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT.');
  }

  return path.resolve(sourceRoot);
}

function* workflowTexts(workflows: SourceWorkflow[]): Iterable<string> {
  for (const workflow of workflows) {
    yield workflow.contents;
    if (workflow.datasetsContents !== null) yield workflow.datasetsContents;
    if (workflow.publishedContents !== null) yield workflow.publishedContents;
    if (workflow.publishedDatasetsContents !== null) yield workflow.publishedDatasetsContents;
    for (const version of workflow.publishedVersions) {
      yield version.contents;
      if (version.datasetsContents !== null) yield version.datasetsContents;
    }
    for (const app of workflow.publishedWebApps) {
      yield app.contents;
      if (app.datasetsContents !== null) yield app.datasetsContents;
    }
  }
}

/** Completed recording bundles are immutable; active/incomplete bundles are copied in the frozen pass. */
async function* completedRecordingTexts(recordingsRoot: string): AsyncIterable<string> {
  for (const project of await fs.readdir(recordingsRoot, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith('.')) continue;
    for (const bundle of await fs.readdir(path.join(recordingsRoot, project.name), { withFileTypes: true })) {
      if (!bundle.isDirectory() || bundle.name.startsWith('.')) continue;
      const bundlePath = path.join(recordingsRoot, project.name, bundle.name);
      const metadata = await readStoredWorkflowRecordingMetadata(bundlePath);
      if (!metadata) continue;
      const artifacts: Array<'recording' | 'replay-project' | 'replay-dataset'> = metadata.run.hasReplayDataset
        ? ['recording', 'replay-project', 'replay-dataset']
        : ['recording', 'replay-project'];
      const texts: string[] = [];
      let complete = true;
      for (const artifact of artifacts) {
        try {
          texts.push(
            await readArtifactText(
              getRecordingArtifactPath(bundlePath, artifact, metadata.run.encoding),
              metadata.run.encoding,
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          complete = false;
          break;
        }
      }
      if (complete) yield* texts;
    }
  }
}

async function assertEmptyTargetObjectNamespaces(
  config: ReturnType<typeof readWorkflowMigrationTargetConfig>,
): Promise<void> {
  const client = new S3Client(createManagedWorkflowS3ClientConfig(config));
  try {
    for (const prefix of [config.objectStoragePrefix, 'runtime-libraries/']) {
      try {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: config.objectStorageBucket,
            Prefix: prefix,
            MaxKeys: 1,
          }),
        );
        if (result.Contents?.length) throw new Error(`Destination S3 namespace is not empty: ${prefix}`);
      } catch (error) {
        if ((error as { name?: string }).name !== 'NoSuchBucket') throw error;
      }
    }
  } finally {
    client.destroy();
  }
}

function assertWorkflowSnapshotMatches(source: SourceWorkflow, target: ManagedWorkflowMigrationSnapshot | null): void {
  if (!target) throw new Error(`Managed workflow is missing: ${source.relativePath}`);
  const legacyPublishedVersion =
    source.publishedEndpointName !== '' && source.publishedVersionId === null && source.publishedVersions.length === 0;
  if (
    legacyPublishedVersion &&
    (target.publishedVersions.length !== 1 ||
      target.publishedVersions[0]?.contents !== source.publishedContents ||
      target.publishedVersions[0]?.datasetsContents !== source.publishedDatasetsContents ||
      target.publishedVersions[0]?.endpointName !== source.publishedEndpointName)
  ) {
    throw new Error(`Managed legacy published version mismatch for ${source.relativePath}`);
  }

  if (
    fingerprintWorkflowMigrationState(source, legacyPublishedVersion) !==
    fingerprintWorkflowMigrationState(target, legacyPublishedVersion)
  ) {
    throw new Error(`Managed workflow content or publication metadata mismatch for ${source.relativePath}`);
  }
}

async function importSourceWorkflows(
  sourceWorkflows: Iterable<SourceWorkflow> | AsyncIterable<SourceWorkflow>,
  backend: ManagedWorkflowBackend,
): Promise<Map<string, string>> {
  const importedProjects = new Map<string, string>();

  for await (const workflow of sourceWorkflows) {
    const existing = await backend.readWorkflowMigrationSnapshot(workflow.relativePath);
    if (existing) {
      assertWorkflowSnapshotMatches(workflow, existing);
      importedProjects.set(workflow.relativePath, workflow.workflowId);
      continue;
    }
    const importedProject = await backend.importWorkflow({
      workflowId: workflow.workflowId,
      relativePath: workflow.relativePath,
      name: workflow.name,
      fileName: workflow.fileName,
      updatedAt: workflow.updatedAt,
      contents: workflow.contents,
      datasetsContents: workflow.datasetsContents,
      endpointName: workflow.endpointName,
      endpointAccess: workflow.endpointAccess,
      forceSeparatePublishedRevision: workflow.endpointStatus === 'unpublished_changes',
      publicationVersion: workflow.publicationVersion,
      publishedEndpointName: workflow.publishedEndpointName,
      publishedVersionId: workflow.publishedVersionId,
      lastPublishedAt: workflow.lastPublishedAt,
      publishedContents: workflow.publishedContents,
      publishedDatasetsContents: workflow.publishedDatasetsContents,
      publishedWebApps: workflow.publishedWebApps,
      publishedVersions: workflow.publishedVersions,
    });

    importedProjects.set(workflow.relativePath, importedProject.id);
    await recordMigrationProgress({
      domain: 'project',
      id: workflow.relativePath,
      sourceHash: fingerprintWorkflowMigrationState(workflow),
    });
    console.log(`[workflow-storage:migrate] Imported workflow ${workflow.relativePath}`);
  }

  return importedProjects;
}

async function importSourceFolders(
  root: string,
  backend: ManagedWorkflowBackend,
  native?: SqliteMigrationSource,
): Promise<void> {
  const folderPaths = collectFolderPaths(
    native ? (await native.workflows.getTree()).folders : await listWorkflowFolders(root),
  );
  const existingPaths = new Set(collectFolderPaths((await backend.getTree()).folders));
  for (const existingPath of existingPaths) {
    if (!folderPaths.includes(existingPath)) throw new Error(`Unexpected managed workflow folder: ${existingPath}`);
  }
  folderPaths.sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const folderPath of folderPaths) {
    if (!existingPaths.has(folderPath)) {
      const parent = path.posix.dirname(folderPath);
      await backend.createWorkflowFolderItem(path.posix.basename(folderPath), parent === '.' ? '' : parent);
    }
    await recordMigrationProgress({
      domain: 'folder',
      id: folderPath,
      sourceHash: createHash('sha256').update(folderPath).digest('hex'),
    });
  }
}

async function importSourceRecordings(
  root: string,
  backend: ManagedWorkflowBackend,
  importedProjects: Map<string, string>,
  native?: SqliteMigrationSource,
): Promise<void> {
  if (!native) await initializeWorkflowRecordingStorage(root);
  const indexedWorkflows = native ? [] : await listWorkflowRecordingWorkflowStatsRows();
  const importedIds = new Set(importedProjects.values());
  for (const workflow of indexedWorkflows) {
    if (workflow.totalRuns > 0 && !importedIds.has(workflow.workflowId)) {
      throw new Error(`Recording index contains runs for a missing source project: ${workflow.workflowId}`);
    }
  }
  const sourceRecordingWorkflows = native
    ? await native.workflows.listWorkflowRecordingWorkflows()
    : await listWorkflowRecordingWorkflows(root);

  for (const sourceWorkflow of sourceRecordingWorkflows.workflows) {
    const relativePath = sourceWorkflow.project.relativePath;
    const importedProject = importedProjects.get(relativePath);
    if (!importedProject) {
      throw new Error(`Recordings refer to a project that was not imported: ${relativePath}`);
    }

    let page = 1;
    const pageSize = 100;
    while (true) {
      const runsPage = native
        ? await native.workflows.listWorkflowRecordingRunsPage(sourceWorkflow.workflowId, page, pageSize, 'all')
        : await listWorkflowRecordingRunsPage(root, sourceWorkflow.workflowId, page, pageSize, 'all');
      for (const run of runsPage.runs) {
        const readArtifact = (artifact: 'recording' | 'replay-project' | 'replay-dataset') =>
          native
            ? native.workflows.readWorkflowRecordingArtifact(run.id, artifact)
            : readWorkflowRecordingArtifact(root, run.id, artifact);
        const recordingContents = await readArtifact('recording');
        const replayProjectContents = await readArtifact('replay-project');
        const replayDatasetContents = run.hasReplayDataset ? await readArtifact('replay-dataset') : null;

        await backend.importWorkflowRecording({
          recordingId: run.id,
          workflowId: importedProject,
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
        await recordMigrationProgress({
          domain: 'recording',
          id: run.id,
          sourceHash: createHash('sha256')
            .update(JSON.stringify(run))
            .update(recordingContents)
            .update(replayProjectContents)
            .update(replayDatasetContents ?? '')
            .digest('hex'),
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

async function validateSourceRecordingBundles(recordingsRoot: string): Promise<number> {
  let recordingCount = 0;
  const projects = await fs.readdir(recordingsRoot, { withFileTypes: true });
  for (const project of projects) {
    if (project.name.startsWith('.')) continue;
    if (!project.isDirectory()) {
      throw new Error(`Unexpected source recording entry: ${project.name}`);
    }
    const bundles = await fs.readdir(path.join(recordingsRoot, project.name), { withFileTypes: true });
    for (const bundle of bundles) {
      if (bundle.name.startsWith('.')) continue;
      if (!bundle.isDirectory()) {
        throw new Error(`Unexpected source recording bundle entry: ${project.name}/${bundle.name}`);
      }
      const bundlePath = path.join(recordingsRoot, project.name, bundle.name);
      const metadataPath = getWorkflowRecordingMetadataPath(bundlePath);
      const metadataStat = await fs.lstat(metadataPath).catch(() => null);
      if (!metadataStat?.isFile() || metadataStat.isSymbolicLink()) {
        throw new Error(`Source recording bundle is incomplete or mismatched: ${project.name}/${bundle.name}`);
      }
      const metadata = await readStoredWorkflowRecordingMetadata(bundlePath);
      if (!metadata || metadata.workflowId !== project.name || metadata.run.id !== bundle.name) {
        throw new Error(`Source recording bundle is incomplete or mismatched: ${project.name}/${bundle.name}`);
      }
      const artifacts: Array<'recording' | 'replay-project' | 'replay-dataset'> = metadata.run.hasReplayDataset
        ? ['recording', 'replay-project', 'replay-dataset']
        : ['recording', 'replay-project'];
      for (const artifact of artifacts) {
        try {
          const artifactPath = getRecordingArtifactPath(bundlePath, artifact, metadata.run.encoding);
          const stat = await fs.lstat(artifactPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
          await readArtifactBytes(artifactPath, metadata.run.encoding);
        } catch {
          throw new Error(
            `Source recording bundle has a missing or unreadable ${artifact} artifact: ${project.name}/${bundle.name}`,
          );
        }
      }
      recordingCount += 1;
    }
  }
  return recordingCount;
}

async function verifyMigration(
  root: string,
  backend: ManagedWorkflowBackend,
  native?: SqliteMigrationSource,
): Promise<VerificationSummary> {
  const [sourceFolders, sourceWorkflows, sourceRecordingWorkflows, targetTree, targetRecordingWorkflows] =
    await Promise.all([
      native ? native.workflows.getTree().then((tree) => tree.folders) : listWorkflowFolders(root),
      native ? native.projectHeaders() : collectSourceWorkflows(root),
      native ? native.workflows.listWorkflowRecordingWorkflows() : listWorkflowRecordingWorkflows(root),
      backend.getTree(),
      backend.listWorkflowRecordingWorkflows(),
    ]);
  const sourceIds = new Set(sourceWorkflows.map((workflow) => workflow.workflowId));
  for (const indexed of native ? [] : await listWorkflowRecordingWorkflowStatsRows()) {
    if (indexed.totalRuns > 0 && !sourceIds.has(indexed.workflowId)) {
      throw new Error(`Recording index contains runs for a missing source project: ${indexed.workflowId}`);
    }
  }

  const sourceFolderPaths = collectFolderPaths(sourceFolders);
  const targetFolderPaths = collectFolderPaths(targetTree.folders);
  const sourceProjectState = sourceWorkflows
    .map((workflow) => ({
      relativePath: workflow.relativePath,
      endpointName: workflow.endpointName,
      lastPublishedAt: workflow.lastPublishedAt,
      status: workflow.endpointStatus,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
  const summary = verifyMigrationState({
    sourceFolderPaths,
    targetFolderPaths,
    sourceProjectState,
    targetProjectState,
    sourceRecordingState,
    targetRecordingState,
  });

  for await (const source of native ? native.projects() : (sourceWorkflows as SourceWorkflow[])) {
    assertWorkflowSnapshotMatches(source, await backend.readWorkflowMigrationSnapshot(source.relativePath));
    if (source.publishedEndpointName) {
      const resolved = await backend.loadPublishedExecutionProject(source.publishedEndpointName);
      if (!resolved) throw new Error(`Managed published execution route is missing: ${source.relativePath}`);
      if (resolved.project.metadata.id !== source.workflowId)
        throw new Error(`Managed published execution route selected another project: ${source.relativePath}`);
      if (resolved.endpointAccess !== source.endpointAccess)
        throw new Error(`Managed published execution access policy differs: ${source.relativePath}`);
    }
    if (source.endpointName && source.publishedEndpointName) {
      const latest = await backend.loadLatestExecutionProject(source.endpointName);
      if (latest?.project.metadata.id !== source.workflowId) {
        throw new Error(`Managed latest execution route did not resolve: ${source.relativePath}`);
      }
    }
    for (const app of source.publishedWebApps) {
      const [resolved, policy] = await Promise.all([
        backend.loadPublishedWebAppExecutionProject(app.slug),
        backend.resolveWebAppAccessPolicy(app.slug),
      ]);
      if (
        resolved?.project.metadata.id !== source.workflowId ||
        // Execution routes namespace the stable database binding ID; the row itself retains the source ID.
        resolved.webAppBindingId !== `managed:${app.appId}` ||
        policy?.appId !== app.appId ||
        JSON.stringify(policy.allowedEmails) !== JSON.stringify(app.allowedEmails)
      ) {
        throw new Error(`Managed published web-app route or policy did not resolve: ${app.slug}`);
      }
    }
  }

  for (const sourceWorkflow of sourceRecordingWorkflows.workflows) {
    const targetWorkflow = targetRecordingWorkflows.workflows.find(
      (candidate) => candidate.project.relativePath === sourceWorkflow.project.relativePath,
    );
    if (!targetWorkflow)
      throw new Error(`Managed recording workflow is missing: ${sourceWorkflow.project.relativePath}`);
    for (let page = 1; ; page += 1) {
      const sourceRuns = native
        ? await native.workflows.listWorkflowRecordingRunsPage(sourceWorkflow.workflowId, page, 100, 'all')
        : await listWorkflowRecordingRunsPage(root, sourceWorkflow.workflowId, page, 100, 'all');
      const targetRuns = await backend.listWorkflowRecordingRunsPage(targetWorkflow.workflowId, page, 100, 'all');
      if (sourceRuns.runs.length !== targetRuns.runs.length) {
        throw new Error(`Managed recording page differs for ${sourceWorkflow.project.relativePath}`);
      }
      const targetById = new Map(targetRuns.runs.map((run) => [run.id, run]));
      for (const run of sourceRuns.runs) {
        const copied = targetById.get(run.id);
        if (
          !copied ||
          JSON.stringify({
            createdAt: copied.createdAt,
            runKind: copied.runKind,
            status: copied.status,
            durationMs: copied.durationMs,
            endpointNameAtExecution: copied.endpointNameAtExecution,
            executionIdentity: copied.executionIdentity ?? null,
            errorMessage: copied.errorMessage ?? null,
            hasReplayDataset: copied.hasReplayDataset,
          }) !==
            JSON.stringify({
              createdAt: run.createdAt,
              runKind: run.runKind,
              status: run.status,
              durationMs: run.durationMs,
              endpointNameAtExecution: run.endpointNameAtExecution,
              executionIdentity: run.executionIdentity ?? null,
              errorMessage: run.errorMessage ?? null,
              hasReplayDataset: run.hasReplayDataset,
            })
        ) {
          throw new Error(`Managed recording metadata mismatch for ${run.id}`);
        }
        const artifacts: Array<'recording' | 'replay-project' | 'replay-dataset'> = run.hasReplayDataset
          ? ['recording', 'replay-project', 'replay-dataset']
          : ['recording', 'replay-project'];
        for (const artifact of artifacts) {
          const [sourceContents, targetContents] = await Promise.all([
            native
              ? native.workflows.readWorkflowRecordingArtifact(run.id, artifact)
              : readWorkflowRecordingArtifact(root, run.id, artifact),
            backend.readWorkflowRecordingArtifact(run.id, artifact),
          ]);
          if (sourceContents !== targetContents) {
            throw new Error(`Managed ${artifact} artifact mismatch for recording ${run.id}`);
          }
        }
      }
      if (page * 100 >= sourceRuns.totalRuns) break;
    }
  }

  return summary;
}

async function main() {
  const command = process.argv[2];
  if (command !== 'precopy' && command !== 'migrate' && command !== 'verify' && command !== 'freeze-source') {
    throw new Error('Expected migration command: freeze-source, precopy, migrate or verify.');
  }
  const mode = command;
  const sourceRoot = getSourceRoot();
  const sourceAppDataRoot = process.env.RIVET_MIGRATION_SOURCE_APP_DATA_ROOT?.trim();
  const sourceRecordingsRoot = process.env.RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT?.trim();
  const sourceRuntimeLibrariesRoot = process.env.RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT?.trim();
  const encryptionKey = process.env.RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY?.trim();
  const controlRoot =
    process.env.RIVET_MIGRATION_SOURCE_LOCAL_METADATA_CONTROL_ROOT?.trim() ||
    process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT?.trim();
  if (command === 'freeze-source') {
    if (!controlRoot || !sourceAppDataRoot || !sourceRecordingsRoot || !sourceRuntimeLibrariesRoot)
      throw new Error('Native source freeze requires the control root and all four original source roots.');
    await SqliteMigrationSource.freeze(controlRoot, {
      workflows: sourceRoot,
      appData: path.resolve(sourceAppDataRoot),
      recordings: path.resolve(sourceRecordingsRoot),
      runtimeLibraries: path.resolve(sourceRuntimeLibrariesRoot),
    });
    console.log(
      '[workflow-storage:freeze-source] Durable SQLite source barrier installed. Keep both source processes stopped until destination verification and cutover.',
    );
    return;
  }
  const targetConfig = readWorkflowMigrationTargetConfig(process.env);
  if (controlRoot && mode === 'precopy')
    throw new Error('Native SQLite migration uses a frozen copy and verification; legacy precopy is not supported.');
  if (!sourceAppDataRoot || !sourceRecordingsRoot || !sourceRuntimeLibrariesRoot || !encryptionKey) {
    throw new Error(
      'Migration requires source App Settings, recordings, and runtime-library roots plus RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY.',
    );
  }
  for (const sourcePath of controlRoot
    ? [sourceAppDataRoot]
    : [sourceRoot, sourceAppDataRoot, sourceRecordingsRoot, sourceRuntimeLibrariesRoot]) {
    if (
      !(await fs
        .stat(sourcePath)
        .then((stat) => stat.isDirectory())
        .catch(() => false))
    ) {
      throw new Error(`Migration source directory does not exist: ${sourcePath}`);
    }
  }
  process.env.RIVET_APP_DATA_ROOT = path.resolve(sourceAppDataRoot);
  process.env.RIVET_WORKFLOWS_ROOT = sourceRoot;
  process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = path.resolve(sourceRecordingsRoot);
  enableWorkflowRecordingMigrationCopyMode();
  if (mode !== 'precopy' && process.env.RIVET_MIGRATION_SOURCE_QUIESCED !== '1') {
    throw new Error(
      'Stop source writes and runs, then set RIVET_MIGRATION_SOURCE_QUIESCED=1 before copying or verifying.',
    );
  }
  if (process.env.RIVET_MIGRATION_TARGET_OFFLINE !== '1') {
    throw new Error(
      'Do not start destination API or execution pods during copy or verification; set RIVET_MIGRATION_TARGET_OFFLINE=1 after confirming they are stopped.',
    );
  }
  const gatePool = new Pool(getManagedDbPoolConfig(targetConfig));
  const manifestRoots = {
    workflows: sourceRoot,
    recordings: path.resolve(sourceRecordingsRoot),
    appData: path.resolve(sourceAppDataRoot),
    runtimeLibraries: path.resolve(sourceRuntimeLibrariesRoot),
  };
  const native = controlRoot
    ? await SqliteMigrationSource.open(controlRoot, manifestRoots, {
        expectedIdentity: process.env.RIVET_MIGRATION_SOURCE_IDENTITY,
      })
    : undefined;
  const sourceIdentity =
    native?.sourceIdentity ??
    migrationSourceIdentity([
      sourceRoot,
      path.resolve(sourceAppDataRoot),
      path.resolve(sourceRecordingsRoot),
      path.resolve(sourceRuntimeLibrariesRoot),
    ]);
  const targetIdentity = migrationTargetIdentity(targetConfig);
  let releaseImporterLock;
  try {
    releaseImporterLock = await acquireVmMigrationImporterLock(gatePool);
  } catch (error) {
    await native?.dispose();
    await gatePool.end();
    throw error;
  }

  if (mode === 'precopy') {
    try {
      const sourceWorkflows = await collectSourceWorkflows(sourceRoot);
      if (sourceWorkflows.length === 0 && process.env.RIVET_MIGRATION_ALLOW_EMPTY_SOURCE !== '1') {
        throw new Error('The source workflows root contains no projects.');
      }
      if (!(await hasVmMigrationTargetGate(gatePool))) await assertEmptyTargetObjectNamespaces(targetConfig);
      await beginVmMigrationTarget(gatePool, sourceIdentity, targetIdentity);
      const staged = await precopyMigrationTexts(
        targetConfig,
        sourceIdentity,
        (async function* () {
          yield* workflowTexts(sourceWorkflows);
          yield* completedRecordingTexts(path.resolve(sourceRecordingsRoot));
        })(),
      );
      console.log(
        `[workflow-storage:precopy] Staged ${staged.objects} content-addressed project objects (${staged.bytes} bytes).`,
      );
    } finally {
      try {
        await releaseImporterLock();
      } finally {
        await gatePool.end();
      }
    }
    return;
  }

  const backend = new ManagedWorkflowBackend(
    targetConfig,
    mode === 'migrate' ? createPrecopyAwareMigrationBlobStore(targetConfig, sourceIdentity) : undefined,
    { migrationMode: mode === 'verify' ? 'verify' : 'copy' },
  );

  try {
    // A previously verified target must fail closed if this audit later finds
    // source drift, extra target rows, or a missing object. The importer lock
    // prevents a competing copy from reopening it during this comparison.
    if (mode === 'verify') await invalidateVmMigrationTargetGate(gatePool, sourceIdentity, targetIdentity);
    const sourceRecordingCount = native
      ? native.catalog.listRecordingIds().length
      : await validateSourceRecordingBundles(sourceRecordingsRoot);
    const sourceSettings = await collectSourceAppSettings(sourceAppDataRoot, targetConfig, native?.settings);
    const configuredSettingsCount = sourceSettings.filter((row) => row.sourceHash !== null).length;
    if (configuredSettingsCount === 0 && process.env.RIVET_MIGRATION_ALLOW_DEFAULT_APP_SETTINGS !== '1') {
      throw new Error(
        'The source App Settings root contains no saved settings. Check the path before proceeding, or explicitly set RIVET_MIGRATION_ALLOW_DEFAULT_APP_SETTINGS=1.',
      );
    }
    if (mode === 'migrate' && !native) await initializeFilesystemProjectTransactions(sourceRoot);
    const sourceManifestParts = native ? await native.manifest() : await readVmMigrationSourceParts(manifestRoots);
    const sourceWorkflows = native ? await native.projectHeaders() : await collectSourceWorkflows(sourceRoot);
    if (sourceWorkflows.length === 0 && process.env.RIVET_MIGRATION_ALLOW_EMPTY_SOURCE !== '1') {
      throw new Error(
        'The source workflows root contains no projects. Check the path before proceeding, or explicitly set RIVET_MIGRATION_ALLOW_EMPTY_SOURCE=1.',
      );
    }
    console.log(
      `[workflow-storage:${mode}] Source preflight found ${sourceWorkflows.length} projects, ${sourceRecordingCount} recordings, and ${configuredSettingsCount} saved App Settings domains.`,
    );
    const sourceManifest = fingerprintVmMigrationSourceParts(sourceManifestParts);
    if (mode === 'migrate') {
      if (!(await hasVmMigrationTargetGate(gatePool))) await assertEmptyTargetObjectNamespaces(targetConfig);
      await beginVmMigrationTarget(gatePool, sourceIdentity, targetIdentity);
      await bindVmMigrationSourceManifest(gatePool, sourceIdentity, targetIdentity, sourceManifest);
    } else {
      await assertVmMigrationSourceManifest(gatePool, sourceIdentity, targetIdentity, sourceManifest);
    }
    console.log(`[workflow-storage:${mode}] Initializing managed backend...`);
    await backend.initialize();
    console.log(`[workflow-storage:${mode}] Managed backend ready.`);

    if (mode === 'migrate') {
      const sourceProjectPaths = new Set(sourceWorkflows.map((workflow) => workflow.relativePath));
      const targetTree = await backend.getTree();
      for (const project of flattenProjects(targetTree.projects, targetTree.folders)) {
        if (!sourceProjectPaths.has(project.relativePath)) {
          throw new Error(`Unexpected managed workflow: ${project.relativePath}`);
        }
      }
      console.log(`[workflow-storage:${mode}] Importing workflows from ${sourceRoot}...`);
      await importSourceFolders(sourceRoot, backend, native);
      const importedProjects = await importSourceWorkflows(
        native ? native.projects() : (sourceWorkflows as SourceWorkflow[]),
        backend,
      );
      console.log(`[workflow-storage:${mode}] Importing recordings...`);
      await importSourceRecordings(sourceRoot, backend, importedProjects, native);
    }

    console.log(`[workflow-storage:${mode}] Verifying managed state...`);
    const summary = await verifyMigration(sourceRoot, backend, native);
    console.log(
      `[workflow-storage:${mode}] Verified ${summary.targetProjectCount} workflows, ${summary.targetFolderCount} folders, and ${summary.targetRecordingWorkflowCount} recording workflow summaries.`,
    );
    const operationalRows = await migrateOperationalSqlite({
      sourceAppDataRoot: native?.paths.operationalRoot ?? sourceAppDataRoot,
      target: targetConfig,
      verifyOnly: mode === 'verify',
    });
    if (mode === 'migrate')
      await recordMigrationProgress({
        domain: 'operational-data',
        id: 'evaluation-and-health',
        sourceHash: fingerprintVmMigrationSourceParts({
          evaluation: sourceManifestParts['evaluation-runs.sqlite']!,
          health: sourceManifestParts['llm-profile-health.sqlite']!,
        }),
      });
    console.log(`[workflow-storage:${mode}] Verified ${operationalRows} Evaluation and LLM Profile health rows.`);
    const runtimePackages = await migrateRuntimeLibraries({
      sourceRoot: sourceRuntimeLibrariesRoot,
      target: targetConfig,
      verifyOnly: mode === 'verify',
      sourceState: native
        ? (await native.catalog.readRuntimeLibraryState()) ?? {
            manifest: { packages: {}, updatedAt: '' },
            archive: null,
          }
        : undefined,
    });
    if (mode === 'migrate')
      await recordMigrationProgress({
        domain: 'runtime-libraries',
        id: 'active-release',
        sourceHash: sourceManifestParts['runtime-libraries']!,
      });
    console.log(`[workflow-storage:${mode}] Verified ${runtimePackages} runtime-library packages.`);
    const settingsCount = await migrateAppSettings({
      sourceRoot: sourceAppDataRoot,
      target: targetConfig,
      encryptionKey,
      verifyOnly: mode === 'verify',
      sourceCatalog: native?.settings,
    });
    if (mode === 'migrate')
      await recordMigrationProgress({
        domain: 'app-settings',
        id: 'all-domains',
        sourceHash: sourceManifestParts.settings!,
      });
    console.log(`[workflow-storage:${mode}] Verified ${settingsCount} encrypted App Settings domains.`);
    const verifiedManifestParts = native ? await native.manifest() : await readVmMigrationSourceParts(manifestRoots);
    const changedSourceDomain = Object.keys(sourceManifestParts).find(
      (name) => sourceManifestParts[name] !== verifiedManifestParts[name],
    );
    if (changedSourceDomain) {
      throw new Error(`Frozen VM ${changedSourceDomain} source changed during ${mode}; target remains closed.`);
    }
    await assertVmMigrationSourceManifest(
      gatePool,
      sourceIdentity,
      targetIdentity,
      fingerprintVmMigrationSourceParts(verifiedManifestParts),
    );
    if (mode === 'verify') {
      const report: VmMigrationVerificationReport = {
        projects: summary.targetProjectCount,
        folders: summary.targetFolderCount,
        recordings: sourceRecordingCount,
        publishedEndpoints: sourceWorkflows.filter((workflow) => workflow.publishedEndpointName).length,
        publishedWebApps: sourceWorkflows.reduce((count, workflow) => count + workflow.publishedWebApps.length, 0),
        evaluationAndHealthRows: operationalRows,
        runtimeLibraryPackages: runtimePackages,
        appSettingsDomains: settingsCount,
        checked: [
          'Exact project, dataset, publication, version and folder state',
          'Published and latest endpoint routing and access policy',
          'Published web-app binding and email access policy',
          'Recording metadata and replay artifact bytes',
          'Evaluation and LLM-profile health rows',
          'Runtime-library release and artifact',
          'Encrypted App Settings domains',
        ],
      };
      const reportFile = process.env.RIVET_MIGRATION_REPORT_PATH;
      if (reportFile) {
        if (!path.isAbsolute(reportFile)) throw new Error('Migration report path must be absolute.');
        const temporary = `${reportFile}.${process.pid}.tmp`;
        await writeDurableExclusive(temporary, JSON.stringify(report), 0o600);
        await fs.rename(temporary, reportFile);
        await syncDirectory(path.dirname(reportFile));
      }
      await verifyVmMigrationTargetGate(gatePool, sourceIdentity, targetIdentity);
    }
  } finally {
    try {
      await backend.dispose();
    } finally {
      try {
        await native?.dispose();
      } finally {
        try {
          await releaseImporterLock();
        } finally {
          await gatePool.end();
        }
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const databasePassword = (() => {
    try {
      return new URL(process.env.RIVET_MIGRATION_TARGET_DATABASE_URL ?? '').password;
    } catch {
      return '';
    }
  })();
  const decodedDatabasePassword = (() => {
    try {
      return decodeURIComponent(databasePassword);
    } catch {
      return databasePassword;
    }
  })();
  const secrets = [
    process.env.RIVET_MIGRATION_TARGET_DATABASE_URL,
    databasePassword,
    decodedDatabasePassword,
    process.env.RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID,
    process.env.RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY,
    process.env.RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY,
  ].filter((secret): secret is string => Boolean(secret));
  const redacted = secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), message);
  console.error(`[workflow-storage] Migration failed: ${redacted}`);
  process.exit(1);
});
