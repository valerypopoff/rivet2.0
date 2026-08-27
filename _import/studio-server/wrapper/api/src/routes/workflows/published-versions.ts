import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../shared/workflow-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../shared/workflow-types.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  ensureWorkflowsRoot,
  getPublishedSnapshotsRoot,
  getPublishedWorkflowSnapshotDatasetPath,
  getPublishedWorkflowSnapshotMetadataPath,
  getPublishedWorkflowSnapshotPath,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import {
  createWorkflowPublicationStateHash,
  ensureWorkflowEndpointNameIsUnique,
  readStoredWorkflowProjectSettings,
  writeStoredWorkflowProjectSettings,
} from './publication.js';
import type { StoredWorkflowProjectSettings } from './types.js';
import { getWorkflowProject } from './workflow-query.js';

type StoredPublishedVersionMetadata = {
  version: 1;
  id: string;
  projectId: string;
  projectName: string;
  relativePath: string;
  endpointName: string;
  publishedAt: string;
  stateHash: string;
  isStarred: boolean;
  comment: string;
};

type FilesystemPublishedVersionRecord = StoredPublishedVersionMetadata & {
  isCurrent: boolean;
};

type WorkflowPublishedVersionDownloadResult = {
  contents: string;
  fileName: string;
};

type WorkflowPublishedVersionSnapshotResult = WorkflowPublishedVersionDownloadResult & {
  datasetsContents: string | null;
};

type LiveProjectSnapshot = {
  contents: string;
  datasetsContents: string | null;
};

function normalizeStoredPublishedVersionMetadata(value: unknown): StoredPublishedVersionMetadata | null {
  const raw = value as Partial<StoredPublishedVersionMetadata> | null;
  if (!raw || raw.version !== 1) {
    return null;
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  const projectName = typeof raw.projectName === 'string' ? raw.projectName.trim() : '';
  const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath.trim() : '';
  const endpointName = typeof raw.endpointName === 'string' ? raw.endpointName.trim() : '';
  const publishedAt = typeof raw.publishedAt === 'string' ? raw.publishedAt.trim() : '';
  const stateHash = typeof raw.stateHash === 'string' ? raw.stateHash.trim() : '';
  const isStarred = raw.isStarred === true;
  const comment = normalizePublishedVersionCommentForStorage(raw.comment);

  if (!id || !projectId || !projectName || !relativePath || !endpointName || !publishedAt || !stateHash) {
    return null;
  }

  return {
    version: 1,
    id,
    projectId,
    projectName,
    relativePath,
    endpointName,
    publishedAt,
    stateHash,
    isStarred,
    comment,
  };
}

function normalizePublishedVersionCommentForStorage(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH);
}

function normalizePublishedVersionCommentInput(value: unknown): string {
  if (typeof value !== 'string') {
    throw createHttpError(400, 'Missing comment');
  }

  if (value.length > WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH) {
    throw createHttpError(400, `Published version comment must be ${WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH} characters or fewer`);
  }

  return value.trim();
}

function comparePublishedVersionsNewestFirst(
  left: WorkflowPublishedVersionSummary,
  right: WorkflowPublishedVersionSummary,
): number {
  const rightTime = Date.parse(right.publishedAt);
  const leftTime = Date.parse(left.publishedAt);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return right.id.localeCompare(left.id);
}

function getPublishedVersionDownloadFileName(projectName: string, publishedAt: string): string {
  const timestamp = publishedAt
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-');

  return `${projectName} [published ${timestamp}]${PROJECT_EXTENSION}`;
}

async function readWorkflowProjectMetadataId(projectPath: string): Promise<string> {
  try {
    const project = await loadProjectFromFile(projectPath);
    const projectId = project.metadata.id;
    if (!projectId) {
      throw createHttpError(400, 'Project is missing metadata.id');
    }

    return projectId;
  } catch (error) {
    if ((error as { status?: number }).status) {
      throw error;
    }

    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw createHttpError(400, 'Could not read project metadata');
  }
}

async function ensurePublishedSnapshotProjectIdMatches(
  root: string,
  snapshotId: string,
  projectId: string,
): Promise<void> {
  try {
    const snapshotProject = await loadProjectFromFile(getPublishedWorkflowSnapshotPath(root, snapshotId));
    if (snapshotProject.metadata.id !== projectId) {
      throw createHttpError(409, 'Published version snapshot belongs to a different project');
    }
  } catch (error) {
    if ((error as { status?: number }).status) {
      throw error;
    }

    throw createHttpError(400, 'Could not read published version snapshot metadata');
  }
}

async function readPublishedVersionMetadata(root: string, snapshotId: string): Promise<StoredPublishedVersionMetadata | null> {
  try {
    const metadataText = await fs.readFile(getPublishedWorkflowSnapshotMetadataPath(root, snapshotId), 'utf8');
    const metadata = normalizeStoredPublishedVersionMetadata(JSON.parse(metadataText));
    return metadata?.id === snapshotId ? metadata : null;
  } catch {
    return null;
  }
}

async function writePublishedVersionMetadata(root: string, metadata: StoredPublishedVersionMetadata): Promise<void> {
  await fs.writeFile(
    getPublishedWorkflowSnapshotMetadataPath(root, metadata.id),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}

async function createLegacyCurrentPublishedVersionRecord(options: {
  root: string;
  projectPath: string;
  projectId: string;
  projectName: string;
  settings: StoredWorkflowProjectSettings;
}): Promise<FilesystemPublishedVersionRecord | null> {
  const snapshotId = options.settings.publishedSnapshotId;
  if (!snapshotId) {
    return null;
  }

  const snapshotPath = getPublishedWorkflowSnapshotPath(options.root, snapshotId);
  try {
    const snapshotProject = await loadProjectFromFile(snapshotPath);
    if (snapshotProject.metadata.id !== options.projectId) {
      return null;
    }

    const endpointName = options.settings.publishedEndpointName || options.settings.endpointName;
    if (!endpointName) {
      return null;
    }

    const snapshotStats = await fs.stat(snapshotPath);
    return {
      version: 1,
      id: snapshotId,
      projectId: options.projectId,
      projectName: options.projectName,
      relativePath: path.relative(options.root, options.projectPath).replace(/\\/g, '/'),
      endpointName,
      publishedAt: options.settings.lastPublishedAt ?? snapshotStats.mtime.toISOString(),
      stateHash: options.settings.publishedStateHash ?? 'legacy',
      isStarred: false,
      comment: '',
      isCurrent: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function ensureCurrentPublishedWorkflowVersionMetadata(options: {
  root: string;
  projectPath: string;
  settings: StoredWorkflowProjectSettings;
}): Promise<void> {
  const snapshotId = options.settings.publishedSnapshotId;
  if (!snapshotId) {
    return;
  }

  if (await readPublishedVersionMetadata(options.root, snapshotId)) {
    return;
  }

  const snapshotPath = getPublishedWorkflowSnapshotPath(options.root, snapshotId);
  if (!await pathExists(snapshotPath)) {
    return;
  }

  const projectId = await readWorkflowProjectMetadataId(options.projectPath);
  const projectName = path.basename(options.projectPath, PROJECT_EXTENSION);
  const endpointName = options.settings.publishedEndpointName || options.settings.endpointName;
  if (!endpointName) {
    return;
  }

  const snapshotStats = await fs.stat(snapshotPath);
  await writePublishedVersionMetadata(options.root, {
    version: 1,
    id: snapshotId,
    projectId,
    projectName,
    relativePath: path.relative(options.root, options.projectPath).replace(/\\/g, '/'),
    endpointName,
    publishedAt: options.settings.lastPublishedAt ?? snapshotStats.mtime.toISOString(),
    stateHash: options.settings.publishedStateHash ?? 'legacy',
    isStarred: false,
    comment: '',
  });
}

async function listPublishedVersionRecords(
  root: string,
  projectId: string,
  currentSnapshotId: string | null,
): Promise<FilesystemPublishedVersionRecord[]> {
  const publishedRoot = getPublishedSnapshotsRoot(root);
  let entries: Dirent[];

  try {
    entries = await fs.readdir(publishedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const records: FilesystemPublishedVersionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const snapshotId = entry.name.slice(0, -'.json'.length);
    const metadata = await readPublishedVersionMetadata(root, snapshotId);
    if (!metadata || metadata.projectId !== projectId) {
      continue;
    }

    if (!await pathExists(getPublishedWorkflowSnapshotPath(root, snapshotId))) {
      continue;
    }

    records.push({
      ...metadata,
      isCurrent: currentSnapshotId === snapshotId,
    });
  }

  return records;
}

async function listPublishedVersionRecordsForProject(
  root: string,
  projectPath: string,
): Promise<FilesystemPublishedVersionRecord[]> {
  const projectId = await readWorkflowProjectMetadataId(projectPath);
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const records = await listPublishedVersionRecords(root, projectId, settings.publishedSnapshotId);

  if (
    settings.publishedSnapshotId &&
    !records.some((record) => record.id === settings.publishedSnapshotId)
  ) {
    const legacyCurrentRecord = await createLegacyCurrentPublishedVersionRecord({
      root,
      projectPath,
      projectId,
      projectName,
      settings,
    });
    if (legacyCurrentRecord) {
      records.push(legacyCurrentRecord);
    }
  }

  return records;
}

async function resolveFilesystemPublishedVersion(
  root: string,
  projectPath: string,
  versionId: string,
): Promise<FilesystemPublishedVersionRecord | null> {
  const records = await listPublishedVersionRecordsForProject(root, projectPath);
  return records.find((record) => record.id === versionId) ?? null;
}

export async function writePublishedWorkflowVersionMetadata(options: {
  root: string;
  projectPath: string;
  snapshotId: string;
  endpointName: string;
  stateHash: string;
  publishedAt: string;
}): Promise<void> {
  const projectId = await readWorkflowProjectMetadataId(options.projectPath);
  const projectName = path.basename(options.projectPath, PROJECT_EXTENSION);
  const relativePath = path.relative(options.root, options.projectPath).replace(/\\/g, '/');
  const metadata: StoredPublishedVersionMetadata = {
    version: 1,
    id: options.snapshotId,
    projectId,
    projectName,
    relativePath,
    endpointName: options.endpointName,
    publishedAt: options.publishedAt,
    stateHash: options.stateHash,
    isStarred: false,
    comment: '',
  };

  await writePublishedVersionMetadata(options.root, metadata);
}

export async function listWorkflowPublishedVersions(
  relativePath: unknown,
): Promise<WorkflowPublishedVersionsResponse> {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const records = await listPublishedVersionRecordsForProject(root, projectPath);
  const versions = records
    .map(mapPublishedVersionRecordToSummary)
    .sort(comparePublishedVersionsNewestFirst);

  return { versions };
}

function mapPublishedVersionRecordToSummary(record: FilesystemPublishedVersionRecord): WorkflowPublishedVersionSummary {
  return {
    id: record.id,
    projectId: record.projectId,
    projectName: record.projectName,
    endpointName: record.endpointName,
    publishedAt: record.publishedAt,
    isCurrent: record.isCurrent,
    isStarred: record.isStarred,
    comment: record.comment,
  };
}

function mapPublishedVersionRecordToMetadata(record: FilesystemPublishedVersionRecord): StoredPublishedVersionMetadata {
  return {
    version: record.version,
    id: record.id,
    projectId: record.projectId,
    projectName: record.projectName,
    relativePath: record.relativePath,
    endpointName: record.endpointName,
    publishedAt: record.publishedAt,
    stateHash: record.stateHash,
    isStarred: record.isStarred,
    comment: record.comment,
  };
}

async function writeRestoredLiveProjectSnapshot(options: {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
}): Promise<void> {
  await fs.writeFile(options.projectPath, options.contents, 'utf8');

  const datasetPath = getWorkflowDatasetPath(options.projectPath);
  if (options.datasetsContents == null) {
    await fs.rm(datasetPath, { force: true });
    return;
  }

  await fs.writeFile(datasetPath, options.datasetsContents, 'utf8');
}

async function readLiveProjectSnapshot(projectPath: string): Promise<LiveProjectSnapshot> {
  const datasetPath = getWorkflowDatasetPath(projectPath);

  return {
    contents: await fs.readFile(projectPath, 'utf8'),
    datasetsContents: (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null,
  };
}

export async function setWorkflowPublishedVersionStar(
  relativePath: unknown,
  versionId: unknown,
  isStarred: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw createHttpError(400, 'Missing versionId');
  }

  if (typeof isStarred !== 'boolean') {
    throw createHttpError(400, 'Missing isStarred');
  }

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const record = await resolveFilesystemPublishedVersion(root, projectPath, versionId.trim());
  if (!record) {
    throw createHttpError(404, 'Published version not found');
  }

  const nextRecord: FilesystemPublishedVersionRecord = {
    ...record,
    isStarred,
  };
  await writePublishedVersionMetadata(root, mapPublishedVersionRecordToMetadata(nextRecord));

  return mapPublishedVersionRecordToSummary(nextRecord);
}

export async function setWorkflowPublishedVersionComment(
  relativePath: unknown,
  versionId: unknown,
  comment: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw createHttpError(400, 'Missing versionId');
  }

  const normalizedComment = normalizePublishedVersionCommentInput(comment);

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const record = await resolveFilesystemPublishedVersion(root, projectPath, versionId.trim());
  if (!record) {
    throw createHttpError(404, 'Published version not found');
  }

  const nextRecord: FilesystemPublishedVersionRecord = {
    ...record,
    comment: normalizedComment,
  };
  await writePublishedVersionMetadata(root, mapPublishedVersionRecordToMetadata(nextRecord));

  return mapPublishedVersionRecordToSummary(nextRecord);
}

async function readWorkflowPublishedVersionSnapshot(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionSnapshotResult> {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw createHttpError(400, 'Missing versionId');
  }

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const record = await resolveFilesystemPublishedVersion(root, projectPath, versionId.trim());
  if (!record) {
    throw createHttpError(404, 'Published version not found');
  }

  const snapshotPath = getPublishedWorkflowSnapshotPath(root, record.id);
  const datasetPath = getPublishedWorkflowSnapshotDatasetPath(root, record.id);
  try {
    const datasetsContents = await pathExists(datasetPath) ? await fs.readFile(datasetPath, 'utf8') : null;
    return {
      contents: await fs.readFile(snapshotPath, 'utf8'),
      datasetsContents,
      fileName: getPublishedVersionDownloadFileName(record.projectName, record.publishedAt),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Published version not found');
    }

    throw error;
  }
}

export async function readWorkflowPublishedVersionDownload(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionDownloadResult> {
  const snapshot = await readWorkflowPublishedVersionSnapshot(relativePath, versionId);
  return {
    contents: snapshot.contents,
    fileName: snapshot.fileName,
  };
}

export async function readWorkflowPublishedVersionPreview(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionPreviewResponse> {
  const snapshot = await readWorkflowPublishedVersionSnapshot(relativePath, versionId);
  return {
    contents: snapshot.contents,
    datasetsContents: snapshot.datasetsContents,
  };
}

export async function restoreWorkflowPublishedVersion(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionRestoreResponse> {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw createHttpError(400, 'Missing versionId');
  }

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const record = await resolveFilesystemPublishedVersion(root, projectPath, versionId.trim());
  if (!record) {
    throw createHttpError(404, 'Published version not found');
  }

  await ensureWorkflowEndpointNameIsUnique(root, projectPath, record.endpointName);
  await ensurePublishedSnapshotProjectIdMatches(root, record.id, record.projectId);

  const snapshot = await readWorkflowPublishedVersionSnapshot(relativePath, record.id);
  const previousLiveSnapshot = await readLiveProjectSnapshot(projectPath);
  const restoredSnapshotId = randomUUID();
  const lastPublishedAt = new Date().toISOString();

  try {
    await ensureCurrentPublishedWorkflowVersionMetadata({
      root,
      projectPath,
      settings: existingSettings,
    });
    await writeRestoredLiveProjectSnapshot({
      projectPath,
      contents: snapshot.contents,
      datasetsContents: snapshot.datasetsContents,
    });

    const publishedStateHash = await createWorkflowPublicationStateHash(projectPath, record.endpointName);
    await fs.writeFile(getPublishedWorkflowSnapshotPath(root, restoredSnapshotId), snapshot.contents, 'utf8');
    if (snapshot.datasetsContents == null) {
      await fs.rm(getPublishedWorkflowSnapshotDatasetPath(root, restoredSnapshotId), { force: true });
    } else {
      await fs.writeFile(getPublishedWorkflowSnapshotDatasetPath(root, restoredSnapshotId), snapshot.datasetsContents, 'utf8');
    }
    await writePublishedWorkflowVersionMetadata({
      root,
      projectPath,
      snapshotId: restoredSnapshotId,
      endpointName: record.endpointName,
      stateHash: publishedStateHash,
      publishedAt: lastPublishedAt,
    });
    await writeStoredWorkflowProjectSettings(projectPath, {
      endpointName: record.endpointName,
      publishedEndpointName: record.endpointName,
      publishedSnapshotId: restoredSnapshotId,
      publishedStateHash,
      lastPublishedAt,
      publishedWebApps: existingSettings.publishedWebApps,
    });
  } catch (error) {
    await fs.rm(getPublishedWorkflowSnapshotPath(root, restoredSnapshotId), { force: true }).catch(() => {});
    await fs.rm(getPublishedWorkflowSnapshotDatasetPath(root, restoredSnapshotId), { force: true }).catch(() => {});
    await fs.rm(getPublishedWorkflowSnapshotMetadataPath(root, restoredSnapshotId), { force: true }).catch(() => {});
    await writeRestoredLiveProjectSnapshot({
      projectPath,
      contents: previousLiveSnapshot.contents,
      datasetsContents: previousLiveSnapshot.datasetsContents,
    }).catch(() => {});
    await writeStoredWorkflowProjectSettings(projectPath, existingSettings).catch(() => {});
    throw error;
  }

  const restoredRecord = await resolveFilesystemPublishedVersion(root, projectPath, restoredSnapshotId);
  if (!restoredRecord) {
    throw createHttpError(500, 'Restored published version could not be loaded');
  }

  return {
    project: await getWorkflowProject(root, projectPath),
    version: mapPublishedVersionRecordToSummary(restoredRecord),
  };
}

export async function deleteWorkflowPublishedVersionsByProjectId(
  root: string,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) {
    return;
  }

  const publishedRoot = getPublishedSnapshotsRoot(root);
  let entries: Dirent[];

  try {
    entries = await fs.readdir(publishedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(PROJECT_EXTENSION)) {
      continue;
    }

    const snapshotId = entry.name.slice(0, -PROJECT_EXTENSION.length);
    const snapshotPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
    let shouldDelete = false;

    const metadata = await readPublishedVersionMetadata(root, snapshotId);
    if (metadata?.projectId === projectId) {
      shouldDelete = true;
    } else {
      try {
        const snapshotProject = await loadProjectFromFile(snapshotPath);
        shouldDelete = snapshotProject.metadata.id === projectId;
      } catch {
        shouldDelete = false;
      }
    }

    if (!shouldDelete) {
      continue;
    }

    await fs.rm(snapshotPath, { force: true });
    await fs.rm(getPublishedWorkflowSnapshotDatasetPath(root, snapshotId), { force: true });
    await fs.rm(getPublishedWorkflowSnapshotMetadataPath(root, snapshotId), { force: true });
  }
}
