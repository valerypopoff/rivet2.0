import { createHash } from 'node:crypto';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectStatus,
} from '../../../studio-server-shared/workflow-types.js';
import type { WorkflowRecordingWorkflowSummary } from '../../../studio-server-shared/workflow-recording-types.js';
import { validateObjectStorageLocation } from '../object-storage-location.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import type { ManagedWorkflowMigrationSnapshot } from '../routes/workflows/managed/types.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} for the managed migration destination.`);
  return value;
}

export function readWorkflowMigrationTargetDatabaseConfig(
  env: NodeJS.ProcessEnv,
): Pick<ManagedWorkflowStorageConfig, 'databaseMode' | 'databaseUrl' | 'databaseSslMode'> {
  const databaseUrlText = required(env, 'RIVET_MIGRATION_TARGET_DATABASE_URL');
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(databaseUrlText);
  } catch {
    // Node's URL error retains the original input, including credentials.
    throw new Error('RIVET_MIGRATION_TARGET_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('RIVET_MIGRATION_TARGET_DATABASE_URL must use postgres or postgresql.');
  }
  if (!databaseUrl.hostname || databaseUrl.pathname.length < 2 || databaseUrl.hash) {
    throw new Error('RIVET_MIGRATION_TARGET_DATABASE_URL must name a host and database without a fragment.');
  }
  databaseUrl.searchParams.delete('sslmode');
  const databaseSslMode = required(env, 'RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE');
  if (!['disable', 'require', 'verify-full'].includes(databaseSslMode)) {
    throw new Error('RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE must be disable, require, or verify-full.');
  }
  return {
    databaseMode: 'managed',
    databaseUrl: databaseUrl.toString(),
    databaseSslMode: databaseSslMode as ManagedWorkflowStorageConfig['databaseSslMode'],
  };
}

export function readWorkflowMigrationTargetObjectStorageConfig(
  env: NodeJS.ProcessEnv,
): Pick<
  ManagedWorkflowStorageConfig,
  | 'objectStorageBucket'
  | 'objectStorageEndpoint'
  | 'objectStorageRegion'
  | 'objectStoragePrefix'
  | 'objectStorageForcePathStyle'
  | 'objectStorageAccessKeyId'
  | 'objectStorageSecretAccessKey'
> {
  const pathStyle = required(env, 'RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE');
  if (pathStyle !== 'true' && pathStyle !== 'false') {
    throw new Error('RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE must be true or false.');
  }
  const location = validateObjectStorageLocation({
    objectStorageBucket: required(env, 'RIVET_MIGRATION_TARGET_S3_BUCKET'),
    objectStorageEndpoint: env.RIVET_MIGRATION_TARGET_S3_ENDPOINT?.trim() ?? '',
    objectStorageRegion: required(env, 'RIVET_MIGRATION_TARGET_S3_REGION'),
    objectStoragePrefix: required(env, 'RIVET_MIGRATION_TARGET_S3_PREFIX'),
    objectStorageForcePathStyle: pathStyle === 'true',
  });
  return {
    ...location,
    objectStorageEndpoint: location.objectStorageEndpoint || null,
    objectStorageAccessKeyId: required(env, 'RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID'),
    objectStorageSecretAccessKey: required(env, 'RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY'),
  };
}

/** A migration destination must be independent of the live VM Storage setting. */
export function readWorkflowMigrationTargetConfig(env: NodeJS.ProcessEnv): ManagedWorkflowStorageConfig {
  return {
    ...readWorkflowMigrationTargetDatabaseConfig(env),
    ...readWorkflowMigrationTargetObjectStorageConfig(env),
  };
}

/** Hash complete application-visible state without putting project contents in an error or log. */
export function fingerprintWorkflowMigrationState(
  workflow: ManagedWorkflowMigrationSnapshot,
  legacyPublishedVersion = false,
): string {
  const versions = legacyPublishedVersion ? [] : workflow.publishedVersions;
  const canonical = {
    workflowId: workflow.workflowId,
    relativePath: workflow.relativePath,
    name: workflow.name,
    fileName: workflow.fileName,
    updatedAt: workflow.updatedAt,
    contents: workflow.contents,
    datasetsContents: workflow.datasetsContents,
    endpointName: workflow.endpointName,
    endpointAccess: workflow.endpointAccess ?? 'public',
    publicationVersion: workflow.publicationVersion ?? '0',
    publishedEndpointName: workflow.publishedEndpointName,
    publishedVersionId: legacyPublishedVersion ? null : workflow.publishedVersionId ?? null,
    lastPublishedAt: workflow.lastPublishedAt ?? null,
    publishedContents: workflow.publishedContents ?? null,
    publishedDatasetsContents: workflow.publishedDatasetsContents ?? null,
    publishedVersions: [...versions].sort((left, right) => left.versionId.localeCompare(right.versionId)),
    publishedWebApps:
      workflow.publishedWebApps
        ?.map((webApp) => ({
          appId: webApp.appId,
          uiGraphId: webApp.uiGraphId,
          slug: webApp.slug,
          allowedEmails: webApp.allowedEmails ?? [],
          publishedAt: webApp.publishedAt,
          contents: webApp.contents,
          datasetsContents: webApp.datasetsContents,
        }))
        .sort((left, right) => left.uiGraphId.localeCompare(right.uiGraphId)) ?? [],
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type MigrationProjectState = {
  relativePath: string;
  endpointName: string;
  lastPublishedAt: string | null;
  status: WorkflowProjectStatus;
};

export type MigrationRecordingState = {
  relativePath: string;
  totalRuns: number;
  failedRuns: number;
  suspiciousRuns: number;
  latestRunAt: string | null;
};

export type VerificationSummary = {
  sourceProjectCount: number;
  targetProjectCount: number;
  sourceFolderCount: number;
  targetFolderCount: number;
  sourceRecordingWorkflowCount: number;
  targetRecordingWorkflowCount: number;
};

export function flattenProjectsFromRecordingSummary(
  workflows: WorkflowRecordingWorkflowSummary[],
): MigrationRecordingState[] {
  return workflows
    .map((workflow) => ({
      relativePath: workflow.project.relativePath,
      totalRuns: workflow.totalRuns,
      failedRuns: workflow.failedRuns,
      suspiciousRuns: workflow.suspiciousRuns,
      latestRunAt: workflow.latestRunAt ?? null,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function flattenProjects(projects: WorkflowProjectItem[], folders: WorkflowFolderItem[]): WorkflowProjectItem[] {
  const flattenedProjects = [...projects];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      flattenedProjects.push(...folder.projects);
      visit(folder.folders);
    }
  };

  visit(folders);
  return flattenedProjects;
}

export function collectFolderPaths(folders: WorkflowFolderItem[]): string[] {
  const paths: string[] = [];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      paths.push(folder.relativePath);
      visit(folder.folders);
    }
  };

  visit(folders);
  return paths.sort((left, right) => left.localeCompare(right));
}

export function verifyMigrationState(options: {
  sourceFolderPaths: string[];
  targetFolderPaths: string[];
  sourceProjectState: MigrationProjectState[];
  targetProjectState: MigrationProjectState[];
  sourceRecordingState: MigrationRecordingState[];
  targetRecordingState: MigrationRecordingState[];
}): VerificationSummary {
  const {
    sourceFolderPaths,
    targetFolderPaths,
    sourceProjectState,
    targetProjectState,
    sourceRecordingState,
    targetRecordingState,
  } = options;

  const sourceFolderPathSet = new Set(sourceFolderPaths);
  const targetFolderPathSet = new Set(targetFolderPaths);
  for (const sourceFolderPath of sourceFolderPathSet) {
    if (!targetFolderPathSet.has(sourceFolderPath))
      throw new Error(`Managed workflow folder is missing: ${sourceFolderPath}`);
  }
  for (const targetFolderPath of targetFolderPathSet) {
    if (!sourceFolderPathSet.has(targetFolderPath))
      throw new Error(`Unexpected managed workflow folder: ${targetFolderPath}`);
  }

  const targetProjectStateByRelativePath = new Map(
    targetProjectState.map((project) => [project.relativePath, project]),
  );
  for (const sourceProject of sourceProjectState) {
    const targetProject = targetProjectStateByRelativePath.get(sourceProject.relativePath);
    if (!targetProject) {
      throw new Error(`Managed workflow is missing: ${sourceProject.relativePath}`);
    }

    if (JSON.stringify(sourceProject) !== JSON.stringify(targetProject)) {
      throw new Error(`Managed workflow mismatch for ${sourceProject.relativePath}`);
    }
  }
  const sourceProjectPaths = new Set(sourceProjectState.map((project) => project.relativePath));
  for (const targetProject of targetProjectState) {
    if (!sourceProjectPaths.has(targetProject.relativePath)) {
      throw new Error(`Unexpected managed workflow: ${targetProject.relativePath}`);
    }
  }

  const targetRecordingStateByRelativePath = new Map(
    targetRecordingState.map((workflow) => [workflow.relativePath, workflow]),
  );
  for (const sourceRecording of sourceRecordingState) {
    const targetRecording = targetRecordingStateByRelativePath.get(sourceRecording.relativePath);
    if (!targetRecording) {
      throw new Error(`Managed recording summary is missing: ${sourceRecording.relativePath}`);
    }

    if (targetRecording.totalRuns !== sourceRecording.totalRuns) {
      throw new Error(`Managed recording count differs for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.failedRuns !== sourceRecording.failedRuns) {
      throw new Error(`Managed failed recording count differs for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.suspiciousRuns !== sourceRecording.suspiciousRuns) {
      throw new Error(`Managed suspicious recording count differs for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.latestRunAt !== sourceRecording.latestRunAt) {
      throw new Error(`Managed latest recording timestamp differs for ${sourceRecording.relativePath}`);
    }
  }
  const sourceRecordingPaths = new Set(sourceRecordingState.map((workflow) => workflow.relativePath));
  for (const targetRecording of targetRecordingState) {
    if (!sourceRecordingPaths.has(targetRecording.relativePath)) {
      throw new Error(`Unexpected managed recording summary: ${targetRecording.relativePath}`);
    }
  }

  return {
    sourceProjectCount: sourceProjectState.length,
    targetProjectCount: targetProjectState.length,
    sourceFolderCount: sourceFolderPaths.length,
    targetFolderCount: targetFolderPaths.length,
    sourceRecordingWorkflowCount: sourceRecordingState.length,
    targetRecordingWorkflowCount: targetRecordingState.length,
  };
}
