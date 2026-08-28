import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadProjectAndAttachedDataFromString,
  type AttachedData,
  type Project,
} from '@valerypopoff/rivet2-node';

import {
  getWorkflowDatasetPath,
  getWorkflowProjectSettingsPath,
  PUBLISHED_SNAPSHOTS_DIR,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import {
  hasPublishedWorkflowLineage,
  isWorkflowEndpointPublished,
  normalizeWorkflowEndpointLookupName,
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
} from './publication.js';
import type { StoredWorkflowProjectSettings } from './types.js';

export type FilesystemExecutionRunKind = 'published' | 'latest';

export type PathSignature = {
  path: string;
  type: 'missing' | 'file' | 'directory' | 'other';
  mtimeMs: number | null;
  size: number | null;
  entriesKey?: string | null;
};

export type FilesystemPathValidationState = Map<string, PathSignature>;

export type FilesystemExecutionRoutingValidationState = {
  settingsSignature: PathSignature;
  liveInputSignatures: FilesystemPathValidationState;
};

export type FilesystemExecutionPointer = {
  sourceProjectPath: string;
  executionProjectPath: string;
  settingsPath: string;
  routingValidationState: FilesystemExecutionRoutingValidationState;
};

export type FilesystemExecutionMaterialization = {
  sourceProjectPath: string;
  executionProjectPath: string;
  project: Project;
  attachedData: AttachedData;
  datasetsContents: string | null;
  projectSignature: PathSignature;
  datasetSignature: PathSignature;
};

export type FilesystemExecutionCandidate = {
  projectPath: string;
  settingsPath: string;
  settingsSignature: PathSignature;
  latestLookupName: string | null;
  publishedLookupName: string | null;
  publishedExecutionProjectPath: string | null;
  publishedLiveInputSignatures: FilesystemPathValidationState;
};

export type FilesystemExecutionScan = {
  directories: string[];
  candidates: FilesystemExecutionCandidate[];
};

async function scanWorkflowTree(root: string): Promise<{ projectPaths: string[]; directories: string[] }> {
  const projectPaths: string[] = [];
  const directories: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    directories.push(directoryPath);
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION)) {
        projectPaths.push(path.join(directoryPath, entry.name));
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      await visit(path.join(directoryPath, entry.name));
    }
  }

  await visit(root);

  const publishedSnapshotsRoot = path.join(root, PUBLISHED_SNAPSHOTS_DIR);
  if ((await capturePathMetadata(publishedSnapshotsRoot)).type === 'directory') {
    directories.push(publishedSnapshotsRoot);
  }

  return {
    projectPaths,
    directories,
  };
}

function createRoutingValidationState(settingsSignature: PathSignature, liveInputSignatures?: FilesystemPathValidationState): FilesystemExecutionRoutingValidationState {
  return {
    settingsSignature,
    liveInputSignatures: new Map(liveInputSignatures ?? []),
  };
}

function createExecutionPointer(
  projectPath: string,
  executionProjectPath: string,
  settingsPath: string,
  settingsSignature: PathSignature,
  liveInputSignatures?: FilesystemPathValidationState,
): FilesystemExecutionPointer {
  return {
    sourceProjectPath: projectPath,
    executionProjectPath,
    settingsPath,
    routingValidationState: createRoutingValidationState(settingsSignature, liveInputSignatures),
  };
}

function shouldTrackLivePublishedInputs(
  settings: StoredWorkflowProjectSettings,
  publishedProjectPath: string | null,
  snapshotProjectPath: string | null,
): boolean {
  if (!settings.publishedStateHash) {
    return false;
  }

  if (!snapshotProjectPath) {
    return true;
  }

  return publishedProjectPath !== snapshotProjectPath;
}

async function capturePublishedLiveInputSignatures(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
  publishedProjectPath: string | null,
  snapshotProjectPath: string | null,
): Promise<FilesystemPathValidationState> {
  if (!shouldTrackLivePublishedInputs(settings, publishedProjectPath, snapshotProjectPath)) {
    return new Map();
  }

  const datasetPath = getWorkflowDatasetPath(projectPath);
  const signatures = await Promise.all([
    capturePathSignature(projectPath),
    capturePathSignature(datasetPath),
  ]);

  return new Map([
    [projectPath, signatures[0]],
    [datasetPath, signatures[1]],
  ]);
}

export async function capturePathMetadata(filePath: string): Promise<Omit<PathSignature, 'entriesKey'>> {
  try {
    const stats = await fs.stat(filePath);
    const type = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
    return {
      path: filePath,
      type,
      mtimeMs: stats.mtimeMs,
      size: stats.isFile() ? stats.size : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path: filePath,
        type: 'missing',
        mtimeMs: null,
        size: null,
      };
    }

    throw error;
  }
}

export async function capturePathSignature(filePath: string): Promise<PathSignature> {
  const metadata = await capturePathMetadata(filePath);
  const entriesKey = metadata.type === 'directory'
    ? JSON.stringify(
        (await fs.readdir(filePath, { withFileTypes: true }))
          .filter((entry) =>
            (entry.isDirectory() && !entry.name.startsWith('.')) ||
            (entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION)),
          )
          .map((entry) => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'}:${entry.name}`)
          .sort(),
      )
    : null;

  return {
    ...metadata,
    entriesKey,
  };
}

export function arePathSignaturesEqual(left: PathSignature, right: PathSignature): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === 'directory') {
    return left.entriesKey === right.entriesKey;
  }

  return left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.entriesKey === right.entriesKey;
}

export async function capturePathValidationState(paths: Iterable<string>): Promise<FilesystemPathValidationState> {
  const signatures = await Promise.all(
    [...paths].map(async (filePath) => [filePath, await capturePathSignature(filePath)] as const),
  );

  return new Map(signatures);
}

export async function isPathValidationStateFresh(validationState: FilesystemPathValidationState): Promise<boolean> {
  const comparisons = await Promise.all(
    [...validationState.entries()].map(async ([filePath, signature]) =>
      arePathSignaturesEqual(signature, await capturePathSignature(filePath))),
  );

  return comparisons.every(Boolean);
}

export async function scanFilesystemExecutionCandidates(root: string): Promise<FilesystemExecutionScan> {
  const { projectPaths, directories } = await scanWorkflowTree(root);
  const candidates = await Promise.all(projectPaths.map(async (projectPath) => {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settingsPath = getWorkflowProjectSettingsPath(projectPath);
    const [settings, settingsSignature] = await Promise.all([
      readStoredWorkflowProjectSettings(projectPath, projectName),
      capturePathSignature(settingsPath),
    ]);

    const latestLookupName = settings.endpointName && hasPublishedWorkflowLineage(settings)
      ? normalizeWorkflowEndpointLookupName(settings.endpointName)
      : null;
    const publishedEndpointName = settings.publishedEndpointName;
    const isPublishedEndpoint = publishedEndpointName
      ? isWorkflowEndpointPublished(settings, publishedEndpointName)
      : false;
    const publishedLookupName = isPublishedEndpoint
      ? normalizeWorkflowEndpointLookupName(publishedEndpointName)
      : null;
    const snapshotProjectPath = settings.publishedSnapshotId
      ? path.join(root, PUBLISHED_SNAPSHOTS_DIR, `${settings.publishedSnapshotId}${PROJECT_EXTENSION}`)
      : null;
    const publishedExecutionProjectPath = publishedLookupName
      ? await resolvePublishedWorkflowProjectPath(root, projectPath, settings)
      : null;

    return {
      projectPath,
      settingsPath,
      settingsSignature,
      latestLookupName,
      publishedLookupName,
      publishedExecutionProjectPath,
      publishedLiveInputSignatures: publishedLookupName
        ? await capturePublishedLiveInputSignatures(projectPath, settings, publishedExecutionProjectPath, snapshotProjectPath)
        : new Map(),
    } satisfies FilesystemExecutionCandidate;
  }));

  return {
    directories,
    candidates,
  };
}

export async function resolveFilesystemPublishedExecutionPointer(
  root: string,
  endpointName: string,
): Promise<FilesystemExecutionPointer | null> {
  const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
  const scan = await scanFilesystemExecutionCandidates(root);
  const liveInputSignatures = new Map<string, PathSignature>();

  for (const candidate of scan.candidates) {
    if (candidate.publishedLookupName !== lookupName) {
      continue;
    }

    for (const [filePath, signature] of candidate.publishedLiveInputSignatures) {
      liveInputSignatures.set(filePath, signature);
    }

    if (!candidate.publishedExecutionProjectPath) {
      continue;
    }

    return createExecutionPointer(
      candidate.projectPath,
      candidate.publishedExecutionProjectPath,
      candidate.settingsPath,
      candidate.settingsSignature,
      liveInputSignatures,
    );
  }

  return null;
}

export async function resolveFilesystemLatestExecutionPointer(
  root: string,
  endpointName: string,
): Promise<FilesystemExecutionPointer | null> {
  const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
  const scan = await scanFilesystemExecutionCandidates(root);

  for (const candidate of scan.candidates) {
    if (candidate.latestLookupName !== lookupName) {
      continue;
    }

    return createExecutionPointer(
      candidate.projectPath,
      candidate.projectPath,
      candidate.settingsPath,
      candidate.settingsSignature,
    );
  }

  return null;
}

export async function loadFilesystemExecutionMaterialization(
  pointer: FilesystemExecutionPointer,
): Promise<FilesystemExecutionMaterialization> {
  const projectSignature = await capturePathSignature(pointer.executionProjectPath);
  if (projectSignature.type !== 'file') {
    const error = new Error(`Project file not found: ${pointer.executionProjectPath}`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }

  const datasetPath = getWorkflowDatasetPath(pointer.executionProjectPath);
  const datasetSignature = await capturePathSignature(datasetPath);
  const projectContents = await fs.readFile(pointer.executionProjectPath, 'utf8');
  const [project, attachedData] = loadProjectAndAttachedDataFromString(projectContents);

  return {
    sourceProjectPath: pointer.sourceProjectPath,
    executionProjectPath: pointer.executionProjectPath,
    project,
    attachedData,
    datasetsContents: datasetSignature.type === 'file' ? await fs.readFile(datasetPath, 'utf8') : null,
    projectSignature,
    datasetSignature,
  };
}
