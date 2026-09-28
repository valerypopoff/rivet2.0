import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import {
  getPublishedWorkflowSnapshotDatasetPath,
  getPublishedWorkflowSnapshotPath,
  getWorkflowProjectSettingsPath,
  listProjectPathsRecursive,
  getWorkflowDatasetPath,
  PROJECT_EXTENSION,
} from '../routes/workflows/fs-helpers.js';
import {
  getWorkflowProjectSettings,
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
} from '../routes/workflows/publication.js';
import {
  readFilesystemPublishedVersionsForMigration,
  validateFilesystemPublishedVersionArchiveForMigration,
} from '../routes/workflows/published-versions.js';
import { readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import type { LocalWorkflowCatalogSnapshot } from './workflow-catalog.js';
import { withLocalSourceBudget } from './source-budget.js';

export type SourceWorkflow = LocalWorkflowCatalogSnapshot;

/** Folder identities include empty folders but not hidden storage/transaction roots. */
export async function collectSourceFolderPaths(root: string): Promise<string[]> {
  const folders: string[] = [];
  async function visit(directory: string, relativePath: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Source folder is not a real directory: ${directory}`);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Source workflow tree contains a symlink: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      folders.push(child);
      await visit(path.join(directory, entry.name), child);
    }
  }
  await visit(root, '');
  return folders.sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, '/');
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Migration source artifact must be a regular file: ${filePath}`);
  }
  return readMigrationSourceUtf8(filePath);
}

async function readSourcePublishedWebApps(
  root: string,
  workflowId: string,
  settings: Awaited<ReturnType<typeof readStoredWorkflowProjectSettings>>,
): Promise<SourceWorkflow['publishedWebApps']> {
  const webApps: SourceWorkflow['publishedWebApps'] = [];
  for (const webApp of settings.publishedWebApps) {
    const snapshotPath = getPublishedWorkflowSnapshotPath(root, webApp.publishedSnapshotId);
    const contents = await readOptionalUtf8(snapshotPath);
    if (contents === null) {
      throw new Error(`Published web app ${webApp.slug} is missing snapshot ${webApp.publishedSnapshotId}`);
    }
    if ((await loadProjectFromFile(snapshotPath)).metadata.id !== workflowId) {
      throw new Error(`Published web app ${webApp.slug} snapshot belongs to another project`);
    }
    webApps.push({
      appId: webApp.appId,
      uiGraphId: webApp.uiGraphId,
      uiGraphName: webApp.uiGraphName,
      slug: webApp.slug,
      allowedEmails: webApp.allowedEmails,
      publishedAt: webApp.publishedAt,
      contents,
      datasetsContents: await readOptionalUtf8(
        getPublishedWorkflowSnapshotDatasetPath(root, webApp.publishedSnapshotId),
      ),
    });
  }
  return webApps;
}

/** Strict legacy source reader for managed migration and local candidate staging. */
export async function collectSourceWorkflows(root: string): Promise<SourceWorkflow[]> {
  const workflows: SourceWorkflow[] = [];
  for await (const project of iterateSourceWorkflows(root)) workflows.push(project);
  return workflows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Local conversion retains one project/history bundle at a time. */
export async function* iterateSourceWorkflows(root: string): AsyncGenerator<SourceWorkflow> {
  const projectPaths = await listProjectPathsRecursive(root);
  const projectIds = new Set<string>();
  const historicalProjectIds = await validateFilesystemPublishedVersionArchiveForMigration(root);

  for (const projectPath of projectPaths) {
    yield await withLocalSourceBudget(async () => {
      const relativePath = normalizeRelativePath(root, projectPath);
      const fileName = path.basename(projectPath);
      const name = path.basename(projectPath, PROJECT_EXTENSION);
      const stats = await fs.lstat(projectPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Source project is not a regular file: ${relativePath}`);
      }
      const contents = await readMigrationSourceUtf8(projectPath);
      const project = await loadProjectFromFile(projectPath);
      const workflowId = project.metadata.id?.trim();
      if (!workflowId || projectIds.has(workflowId)) {
        throw new Error(`Source project has a missing or duplicate metadata.id: ${relativePath}`);
      }
      projectIds.add(workflowId);
      await readOptionalUtf8(getWorkflowProjectSettingsPath(projectPath));
      const settings = await readStoredWorkflowProjectSettings(projectPath, name);
      const visibleSettings = await getWorkflowProjectSettings(projectPath, name, {
        includeAggregatePublicationStatus: false,
      });
      const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, settings);
      if (settings.publishedEndpointName && !publishedProjectPath) {
        throw new Error(
          `Published endpoint ${settings.publishedEndpointName} has no readable snapshot: ${relativePath}`,
        );
      }
      const publishedContents = publishedProjectPath ? await readOptionalUtf8(publishedProjectPath) : null;
      if (publishedProjectPath && publishedContents === null) {
        throw new Error(`Published endpoint snapshot is missing: ${relativePath}`);
      }
      if (publishedProjectPath && (await loadProjectFromFile(publishedProjectPath)).metadata.id !== workflowId) {
        throw new Error(`Published endpoint snapshot belongs to another project: ${relativePath}`);
      }
      const publishedVersions = await readFilesystemPublishedVersionsForMigration(root, projectPath);
      return {
        workflowId,
        relativePath,
        name,
        fileName,
        updatedAt: stats.mtime.toISOString(),
        contents,
        datasetsContents: await readOptionalUtf8(getWorkflowDatasetPath(projectPath)),
        endpointName: settings.endpointName,
        endpointAccess: settings.endpointAccess,
        endpointStatus: visibleSettings.status,
        publicationVersion: settings.publicationVersion ?? '0',
        publishedEndpointName: settings.publishedEndpointName,
        publishedVersionId: settings.publishedSnapshotId,
        lastPublishedAt: visibleSettings.lastPublishedAt,
        publishedContents,
        publishedDatasetsContents: publishedProjectPath
          ? await readOptionalUtf8(getWorkflowDatasetPath(publishedProjectPath))
          : null,
        publishedWebApps: await readSourcePublishedWebApps(root, workflowId, settings),
        publishedVersions,
      };
    });
  }
  for (const projectId of historicalProjectIds) {
    if (!projectIds.has(projectId)) {
      throw new Error(`Published-version archive refers to a missing source project: ${projectId}`);
    }
  }
}
