import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowProjectReferenceSource } from '../../../../studio-server-shared/workflow-types.js';
import { getWorkflowsRoot } from '../../security.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  getPublishedWorkflowSnapshotPath,
  listProjectPathsRecursive,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import {
  isWorkflowEndpointPublished,
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
} from './publication.js';

export type WorkflowProjectReferenceSnapshot = { source: WorkflowProjectReferenceSource; contents: string };
export type WorkflowProjectReferenceCatalogEntry = {
  name: string;
  relativePath: string;
  projectMetadataId?: string;
  identity: string;
};

export async function listFilesystemProjectReferenceCatalog(): Promise<WorkflowProjectReferenceCatalogEntry[]> {
  const root = getWorkflowsRoot();
  const entries: WorkflowProjectReferenceCatalogEntry[] = [];
  for (const projectPath of await listProjectPathsRecursive(root)) {
    const name = path.basename(projectPath, PROJECT_EXTENSION);
    const stats = await fs.stat(projectPath);
    const settings = await readStoredWorkflowProjectSettings(projectPath, name);
    entries.push({
      name,
      relativePath: path.relative(root, projectPath).replace(/\\/g, '/'),
      identity: JSON.stringify([stats.mtimeMs, stats.ctimeMs, stats.size, settings]),
    });
  }
  return entries;
}

/** Project-only reads: do not materialize datasets, recordings or archived history. */
export async function readFilesystemProjectReferenceSnapshots(
  relativePath: unknown,
): Promise<WorkflowProjectReferenceSnapshot[]> {
  const root = getWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, { allowProjectFile: true }));
  const settings = await readStoredWorkflowProjectSettings(projectPath, path.basename(projectPath, PROJECT_EXTENSION));
  const snapshots: WorkflowProjectReferenceSnapshot[] = [
    { source: { kind: 'saved-latest' }, contents: await fs.readFile(projectPath, 'utf8') },
  ];
  const reads = new Map<string, Promise<string>>();
  const read = (file: string) => {
    let result = reads.get(file);
    if (!result) {
      result = fs.readFile(file, 'utf8');
      reads.set(file, result);
    }
    return result;
  };
  if (isWorkflowEndpointPublished(settings, settings.publishedEndpointName)) {
    const publishedPath = await resolvePublishedWorkflowProjectPath(root, projectPath, settings);
    if (!publishedPath) throw createHttpError(409, 'Published project snapshot is unavailable.');
    snapshots.push({
      source: { kind: 'published-endpoint', label: settings.publishedEndpointName },
      contents: await read(publishedPath),
    });
  }
  for (const app of settings.publishedWebApps) {
    snapshots.push({
      source: { kind: 'published-web-app', label: app.slug },
      contents: await read(getPublishedWorkflowSnapshotPath(root, app.publishedSnapshotId)),
    });
  }
  return snapshots;
}
