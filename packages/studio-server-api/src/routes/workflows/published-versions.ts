import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../studio-server-shared/workflow-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  ensureWorkflowsRoot,
  getPublishedSnapshotsRoot,
  getPublishedWorkflowSnapshotDatasetPath,
  getPublishedWorkflowSnapshotMetadataPath,
  getPublishedWorkflowSnapshotPath,
  getWorkflowDatasetPath,
  isSafePublishedSnapshotId,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import {
  createStoredWorkflowProjectSettingsChange,
  createWorkflowPublicationStateHashFromContents,
  ensureWorkflowEndpointNameIsUnique,
  readStoredWorkflowProjectSettings,
} from './publication.js';
import {
  saveFilesystemPublicationTransaction,
  type PublicationFileChange,
} from './filesystem-publication-transactions.js';
import type { StoredWorkflowProjectSettings } from './types.js';
import { assertFilesystemPublicationPreconditions } from './publication-preconditions.js';
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
  datasetsContents: Buffer | null;
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
  if (
    (raw.isStarred !== undefined && typeof raw.isStarred !== 'boolean') ||
    (raw.comment !== undefined && typeof raw.comment !== 'string')
  ) return null;
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
  let metadataText: string;
  try {
    metadataText = await fs.readFile(getPublishedWorkflowSnapshotMetadataPath(root, snapshotId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const metadata = normalizeStoredPublishedVersionMetadata(JSON.parse(metadataText));
    if (!metadata || metadata.id !== snapshotId) {
      throw new Error('Invalid published-version metadata');
    }
    return metadata;
  } catch (error) {
    throw new Error(`Corrupt published-version metadata for ${snapshotId}; operator repair is required`, { cause: error });
  }
}

function publishedVersionMetadataChange(root: string, metadata: StoredPublishedVersionMetadata): PublicationFileChange {
  return {
    path: getPublishedWorkflowSnapshotMetadataPath(root, metadata.id),
    contents: `${JSON.stringify(metadata, null, 2)}\n`,
  };
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

export async function getCurrentPublishedWorkflowVersionMetadataChange(options: {
  root: string;
  projectPath: string;
  settings: StoredWorkflowProjectSettings;
}): Promise<PublicationFileChange | null> {
  const snapshotId = options.settings.publishedSnapshotId;
  if (!snapshotId) {
    return null;
  }

  const existingMetadata = await readPublishedVersionMetadata(options.root, snapshotId);
  if (existingMetadata) {
    const projectId = await readWorkflowProjectMetadataId(options.projectPath);
    if (existingMetadata.projectId !== projectId) {
      throw new Error(`Published-version metadata for ${snapshotId} belongs to a different project`);
    }
    if (await pathExists(getPublishedWorkflowSnapshotPath(options.root, snapshotId))) {
      await ensurePublishedSnapshotProjectIdMatches(options.root, snapshotId, projectId);
    }
    return null;
  }

  const snapshotPath = getPublishedWorkflowSnapshotPath(options.root, snapshotId);
  if (!await pathExists(snapshotPath)) {
    return null;
  }

  const projectId = await readWorkflowProjectMetadataId(options.projectPath);
  await ensurePublishedSnapshotProjectIdMatches(options.root, snapshotId, projectId);
  const projectName = path.basename(options.projectPath, PROJECT_EXTENSION);
  const endpointName = options.settings.publishedEndpointName || options.settings.endpointName;
  if (!endpointName) {
    return null;
  }

  const snapshotStats = await fs.stat(snapshotPath);
  return publishedVersionMetadataChange(options.root, {
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
    let metadata: StoredPublishedVersionMetadata | null;
    try {
      metadata = await readPublishedVersionMetadata(root, snapshotId);
    } catch (error) {
      if (snapshotId === currentSnapshotId) throw error;
      console.warn(`[workflow-storage] Preserving but omitting corrupt noncurrent published-version metadata ${snapshotId}:`, error);
      continue;
    }
    if (snapshotId === currentSnapshotId && metadata && metadata.projectId !== projectId) {
      throw new Error(`Published-version metadata for ${snapshotId} belongs to a different project`);
    }
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
  const record = records.find((candidate) => candidate.id === versionId) ?? null;
  if (record) {
    await ensurePublishedSnapshotProjectIdMatches(root, record.id, record.projectId);
  } else if (isSafePublishedSnapshotId(versionId)) {
    // A corrupt older entry may be omitted from the list to avoid taking down
    // other projects. A caller naming that exact version still needs the real
    // corruption diagnostic, not an indistinguishable 404.
    await readPublishedVersionMetadata(root, versionId);
  }
  return record;
}

export async function createPublishedWorkflowVersionMetadataChange(options: {
  root: string;
  projectPath: string;
  snapshotId: string;
  endpointName: string;
  stateHash: string;
  publishedAt: string;
}): Promise<PublicationFileChange> {
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

  return publishedVersionMetadataChange(options.root, metadata);
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
  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [publishedVersionMetadataChange(root, mapPublishedVersionRecordToMetadata(nextRecord))],
  });

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
  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [publishedVersionMetadataChange(root, mapPublishedVersionRecordToMetadata(nextRecord))],
  });

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
    const datasetsContents = await pathExists(datasetPath) ? await fs.readFile(datasetPath) : null;
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
    datasetsContents: snapshot.datasetsContents?.toString('utf8') ?? null,
  };
}

export async function restoreWorkflowPublishedVersion(
  relativePath: unknown,
  versionId: unknown,
  preconditions: WorkflowDraftPublicationPreconditions,
  onCommitted?: () => void,
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
  await assertFilesystemPublicationPreconditions(projectPath, existingSettings, preconditions, 'restore-version');
  const record = await resolveFilesystemPublishedVersion(root, projectPath, versionId.trim());
  if (!record) {
    throw createHttpError(404, 'Published version not found');
  }

  await ensureWorkflowEndpointNameIsUnique(root, projectPath, record.endpointName);

  const snapshot = await readWorkflowPublishedVersionSnapshot(relativePath, record.id);
  const restoredSnapshotId = randomUUID();
  const lastPublishedAt = new Date().toISOString();
  const legacyMetadataChange = await getCurrentPublishedWorkflowVersionMetadataChange({
    root,
    projectPath,
    settings: existingSettings,
  });
  const publishedStateHash = createWorkflowPublicationStateHashFromContents(
    snapshot.contents,
    snapshot.datasetsContents,
    record.endpointName,
  );
  const metadataChange = await createPublishedWorkflowVersionMetadataChange({
    root,
    projectPath,
    snapshotId: restoredSnapshotId,
    endpointName: record.endpointName,
    stateHash: publishedStateHash,
    publishedAt: lastPublishedAt,
  });
  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [
      ...(legacyMetadataChange ? [legacyMetadataChange] : []),
      { path: getPublishedWorkflowSnapshotPath(root, restoredSnapshotId), contents: snapshot.contents },
      ...(snapshot.datasetsContents == null ? [] : [{
        path: getPublishedWorkflowSnapshotDatasetPath(root, restoredSnapshotId),
        contents: snapshot.datasetsContents,
      }]),
      metadataChange,
      { path: projectPath, contents: snapshot.contents },
      { path: getWorkflowDatasetPath(projectPath), contents: snapshot.datasetsContents },
      createStoredWorkflowProjectSettingsChange(projectPath, {
        endpointName: record.endpointName,
        endpointAccess: existingSettings.endpointAccess,
        publishedEndpointName: record.endpointName,
        publishedSnapshotId: restoredSnapshotId,
        publishedStateHash,
        lastPublishedAt,
        publishedWebApps: existingSettings.publishedWebApps,
      }, existingSettings),
    ],
  });
  onCommitted?.();

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
