import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  getWorkflowRecordingsRoot as getConfiguredWorkflowRecordingsRoot,
  getWorkflowsRoot,
  validatePath,
} from '../../security.js';
import { badRequest, conflict } from '../../utils/httpError.js';

export const PROJECT_EXTENSION = '.rivet-project';
export const PROJECT_SETTINGS_SUFFIX = '.wrapper-settings.json';
export const PROJECT_STATS_SUFFIX = '.wrapper-stats.json';
export const PUBLISHED_SNAPSHOTS_DIR = '.published';
export const WORKFLOW_RECORDINGS_DIR = '.recordings';
export const WORKFLOW_DATASET_SUFFIX = '.rivet-data';
export const WORKFLOW_RECORDING_FILE_NAME = 'recording.rivet-recording.gz';
export const LEGACY_WORKFLOW_RECORDING_FILE_NAME = 'recording.rivet-recording';
export const WORKFLOW_RECORDING_METADATA_FILE_NAME = 'metadata.json';
export const WORKFLOW_RECORDING_PROJECT_FILE_NAME = `replay${PROJECT_EXTENSION}.gz`;
export const LEGACY_WORKFLOW_RECORDING_PROJECT_FILE_NAME = `replay${PROJECT_EXTENSION}`;

export async function ensureWorkflowsRoot(): Promise<string> {
  const root = getWorkflowsRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(getPublishedSnapshotsRoot(root), { recursive: true });
  return root;
}

export async function ensureWorkflowRecordingsRoot(root?: string): Promise<string> {
  const recordingsRoot = getWorkflowRecordingsRoot(root);
  await fs.mkdir(recordingsRoot, { recursive: true });
  return recordingsRoot;
}

export function sanitizeWorkflowName(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw badRequest(`Missing ${label}`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw badRequest(`Missing ${label}`);
  }

  if (trimmed === '.' || trimmed === '..') {
    throw badRequest(`Invalid ${label}`);
  }

  if (trimmed.startsWith('.')) {
    throw badRequest(`${label} must not start with a dot`);
  }

  if (/[\\/]/.test(trimmed)) {
    throw badRequest(`${label} must not contain path separators`);
  }

  if (/[<>:"|?*]/.test(trimmed)) {
    throw badRequest(`${label} contains invalid filesystem characters`);
  }

  return trimmed;
}

export function resolveWorkflowRelativePath(
  root: string,
  relativePath: unknown,
  options: {
    allowProjectFile: boolean;
    allowEmpty?: boolean;
  },
): string {
  if (typeof relativePath !== 'string') {
    if (options.allowEmpty && (relativePath == null || relativePath === '')) {
      return root;
    }

    throw badRequest('Missing relativePath');
  }

  const normalized = relativePath.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    if (options.allowEmpty) {
      return root;
    }

    throw badRequest('Missing relativePath');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw badRequest('Invalid relativePath');
  }

  if (!options.allowProjectFile && normalized.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected folder path, received project path');
  }

  return validatePath(path.join(root, ...segments));
}

export function requireProjectPath(resolvedPath: string): string {
  if (!resolvedPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  return resolvedPath;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const pathsDifferOnlyByCase = (leftPath: string, rightPath: string) =>
  leftPath !== rightPath && leftPath.toLowerCase() === rightPath.toLowerCase();

export async function renamePathHandlingCaseChange(currentPath: string, nextPath: string): Promise<void> {
  if (!pathsDifferOnlyByCase(currentPath, nextPath)) {
    await fs.rename(currentPath, nextPath);
    return;
  }

  const temporaryPath = validatePath(
    path.join(path.dirname(currentPath), `.${randomUUID()}-${path.basename(nextPath)}`),
  );

  await fs.rename(currentPath, temporaryPath);
  await fs.rename(temporaryPath, nextPath);
}

export function getWorkflowProjectSettingsPath(projectPath: string): string {
  return `${projectPath}${PROJECT_SETTINGS_SUFFIX}`;
}

export function getWorkflowProjectStatsPath(projectPath: string): string {
  return `${projectPath}${PROJECT_STATS_SUFFIX}`;
}

export function getPublishedSnapshotsRoot(root: string): string {
  return validatePath(path.join(root, PUBLISHED_SNAPSHOTS_DIR));
}

export function getWorkflowRecordingsRoot(root?: string): string {
  if (process.env.RIVET_WORKFLOW_RECORDINGS_ROOT?.trim()) {
    return getConfiguredWorkflowRecordingsRoot();
  }

  const workflowsRoot = root ? validatePath(root) : getWorkflowsRoot();
  return validatePath(path.join(workflowsRoot, WORKFLOW_RECORDINGS_DIR));
}

export function getWorkflowProjectRecordingsRoot(root: string, projectMetadataId: string): string {
  return validatePath(path.join(getWorkflowRecordingsRoot(root), projectMetadataId));
}

export function getWorkflowRecordingBundlePath(root: string, projectMetadataId: string, recordingId: string): string {
  return validatePath(path.join(getWorkflowProjectRecordingsRoot(root, projectMetadataId), recordingId));
}

export function getWorkflowRecordingPath(bundlePath: string, encoding: 'gzip' | 'identity' = 'gzip'): string {
  return validatePath(
    path.join(bundlePath, encoding === 'gzip' ? WORKFLOW_RECORDING_FILE_NAME : LEGACY_WORKFLOW_RECORDING_FILE_NAME),
  );
}

export function getWorkflowRecordingMetadataPath(bundlePath: string): string {
  return validatePath(path.join(bundlePath, WORKFLOW_RECORDING_METADATA_FILE_NAME));
}

export function getWorkflowRecordingReplayProjectPath(
  bundlePath: string,
  encoding: 'gzip' | 'identity' = 'gzip',
): string {
  return validatePath(
    path.join(
      bundlePath,
      encoding === 'gzip' ? WORKFLOW_RECORDING_PROJECT_FILE_NAME : LEGACY_WORKFLOW_RECORDING_PROJECT_FILE_NAME,
    ),
  );
}

export function getWorkflowRecordingReplayDatasetPath(
  bundlePath: string,
  encoding: 'gzip' | 'identity' = 'gzip',
): string {
  return getWorkflowDatasetPath(getWorkflowRecordingReplayProjectPath(bundlePath, encoding));
}

export function getPublishedWorkflowSnapshotPath(root: string, snapshotId: string): string {
  return validatePath(path.join(getPublishedSnapshotsRoot(root), `${snapshotId}${PROJECT_EXTENSION}`));
}

export function getPublishedWorkflowSnapshotDatasetPath(root: string, snapshotId: string): string {
  return getWorkflowDatasetPath(getPublishedWorkflowSnapshotPath(root, snapshotId));
}

export function getPublishedWorkflowSnapshotMetadataPath(root: string, snapshotId: string): string {
  return validatePath(path.join(getPublishedSnapshotsRoot(root), `${snapshotId}.json`));
}

export function getWorkflowDatasetPath(projectPath: string): string {
  return projectPath.replace(PROJECT_EXTENSION, WORKFLOW_DATASET_SUFFIX);
}

export function getProjectSidecarPaths(projectPath: string): { dataset: string; settings: string; stats: string } {
  return {
    dataset: getWorkflowDatasetPath(projectPath),
    settings: getWorkflowProjectSettingsPath(projectPath),
    stats: getWorkflowProjectStatsPath(projectPath),
  };
}

export async function moveProjectWithSidecars(sourceProjectPath: string, targetProjectPath: string): Promise<void> {
  const sourceSidecars = getProjectSidecarPaths(sourceProjectPath);
  const targetSidecars = getProjectSidecarPaths(targetProjectPath);
  const sourceDatasetExists = await pathExists(sourceSidecars.dataset);
  const sourceSettingsExists = await pathExists(sourceSidecars.settings);
  const sourceStatsExists = await pathExists(sourceSidecars.stats);
  const projectRename = (fromPath: string, toPath: string) => renamePathHandlingCaseChange(fromPath, toPath);

  if (sourceProjectPath !== targetProjectPath && await pathExists(targetProjectPath)) {
    throw conflict(`Project already exists: ${path.basename(targetProjectPath)}`);
  }

  if (sourceDatasetExists && sourceSidecars.dataset !== targetSidecars.dataset && await pathExists(targetSidecars.dataset)) {
    throw conflict(`Dataset file already exists for project: ${path.basename(targetProjectPath)}`);
  }

  if (sourceSettingsExists && sourceSidecars.settings !== targetSidecars.settings && await pathExists(targetSidecars.settings)) {
    throw conflict(`Settings file already exists for project: ${path.basename(targetProjectPath)}`);
  }

  let datasetMoved = false;
  let settingsMoved = false;

  try {
    await projectRename(sourceProjectPath, targetProjectPath);

    if (sourceDatasetExists && sourceSidecars.dataset !== targetSidecars.dataset) {
      await projectRename(sourceSidecars.dataset, targetSidecars.dataset);
      datasetMoved = true;
    }

    if (sourceSettingsExists && sourceSidecars.settings !== targetSidecars.settings) {
      await projectRename(sourceSidecars.settings, targetSidecars.settings);
      settingsMoved = true;
    }

    if (sourceSidecars.stats !== targetSidecars.stats) {
      if (!pathsDifferOnlyByCase(sourceSidecars.stats, targetSidecars.stats) && await pathExists(targetSidecars.stats)) {
        await fs.rm(targetSidecars.stats, { force: true }).catch(() => {});
      }

      if (sourceStatsExists) {
        await projectRename(sourceSidecars.stats, targetSidecars.stats).catch(() => {});
      }
    }
  } catch (error) {
    if (settingsMoved) {
      await renamePathHandlingCaseChange(targetSidecars.settings, sourceSidecars.settings).catch(() => {});
    }

    if (datasetMoved) {
      await renamePathHandlingCaseChange(targetSidecars.dataset, sourceSidecars.dataset).catch(() => {});
    }

    if (sourceProjectPath !== targetProjectPath && await pathExists(targetProjectPath) && !await pathExists(sourceProjectPath)) {
      await renamePathHandlingCaseChange(targetProjectPath, sourceProjectPath).catch(() => {});
    }

    throw error;
  }
}

export async function deleteProjectWithSidecars(projectPath: string): Promise<void> {
  await fs.rm(projectPath, { force: false });

  const sidecars = getProjectSidecarPaths(projectPath);
  if (await pathExists(sidecars.dataset)) {
    await fs.rm(sidecars.dataset, { force: false });
  }

  if (await pathExists(sidecars.settings)) {
    await fs.rm(sidecars.settings, { force: false });
  }

  if (await pathExists(sidecars.stats)) {
    await fs.rm(sidecars.stats, { force: false });
  }
}

export async function deleteWorkflowProjectRecordings(root: string, projectMetadataId: string | null | undefined): Promise<void> {
  if (!projectMetadataId) {
    return;
  }

  const recordingsRoot = getWorkflowProjectRecordingsRoot(root, projectMetadataId);
  if (await pathExists(recordingsRoot)) {
    await fs.rm(recordingsRoot, { recursive: true, force: false });
  }
}

export async function listProjectPathsRecursive(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const nestedProjectPaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => listProjectPathsRecursive(path.join(folderPath, entry.name))),
  );

  return [
    ...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .map((entry) => path.join(folderPath, entry.name)),
    ...nestedProjectPaths.flat(),
  ];
}

export function quoteForYaml(value: string): string {
  return JSON.stringify(value);
}

export function createBlankProjectFile(projectName: string): string {
  const projectId = randomUUID();
  const graphId = randomUUID();

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${quoteForYaml(projectId)}`,
    `    title: ${quoteForYaml(projectName)}`,
    '    description: ""',
    `    mainGraphId: ${quoteForYaml(graphId)}`,
    '  graphs:',
    `    ${quoteForYaml(graphId)}:`,
    '      metadata:',
    `        id: ${quoteForYaml(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}
