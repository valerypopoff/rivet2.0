import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectFromString } from '@valerypopoff/rivet2-node';

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
import { LocalUpgradeDiagnosticError, localUpgradeSourceError } from './upgrade-diagnostics.js';

export type SourceWorkflow = LocalWorkflowCatalogSnapshot;

/** Folder identities include empty folders but not hidden storage/transaction roots. */
export async function collectSourceFolderPaths(root: string): Promise<string[]> {
  const folders: string[] = [];
  async function visit(directory: string, relativePath: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw localUpgradeSourceError(
        new LocalUpgradeDiagnosticError('unsupported-source-entry'),
        relativePath,
        'unsupported-source-entry',
      );
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink())
        throw localUpgradeSourceError(
          new LocalUpgradeDiagnosticError('unsupported-source-entry'),
          `${relativePath}/${entry.name}`,
          'unsupported-source-entry',
        );
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
    throw new LocalUpgradeDiagnosticError('unsupported-source-entry');
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
      throw new LocalUpgradeDiagnosticError('publication-snapshot-missing');
    }
    if (readProject(contents).metadata.id !== workflowId) {
      throw new LocalUpgradeDiagnosticError('publication-owner-mismatch');
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

/** Read-only source diagnosis, not candidate verification or backup certification. */
export async function checkLocalWorkflowSource(root: string): Promise<{ projects: number; folders: number }> {
  const folders = await collectSourceFolderPaths(root);
  let projects = 0;
  for await (const _project of iterateSourceWorkflows(root)) projects++;
  return { projects, folders: folders.length };
}

function readProject(contents: string) {
  try {
    return loadProjectFromString(contents, { logErrors: false });
  } catch (error) {
    if (error instanceof LocalUpgradeDiagnosticError) throw error;
    throw new LocalUpgradeDiagnosticError('project-parse-failed', undefined, error);
  }
}

/** Local conversion retains one project/history bundle at a time. */
export async function* iterateSourceWorkflows(root: string): AsyncGenerator<SourceWorkflow> {
  const projectPaths = await listProjectPathsRecursive(root);
  const projectIds = new Set<string>();
  let historicalProjectIds;
  try {
    historicalProjectIds = await validateFilesystemPublishedVersionArchiveForMigration(root);
  } catch (error) {
    if (error instanceof LocalUpgradeDiagnosticError) throw error;
    throw new LocalUpgradeDiagnosticError('publication-history-invalid', undefined, error);
  }

  for (const projectPath of projectPaths) {
    const relativePath = normalizeRelativePath(root, projectPath);
    try {
      yield await withLocalSourceBudget(async () => {
        const fileName = path.basename(projectPath);
        const name = path.basename(projectPath, PROJECT_EXTENSION);
        const stats = await fs.lstat(projectPath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new LocalUpgradeDiagnosticError('unsupported-source-entry');
        }
        const contents = await readMigrationSourceUtf8(projectPath);
        const project = readProject(contents);
        const workflowId = project.metadata.id?.trim();
        if (!workflowId) throw new LocalUpgradeDiagnosticError('project-id-missing');
        if (projectIds.has(workflowId)) throw new LocalUpgradeDiagnosticError('project-id-duplicate');
        projectIds.add(workflowId);
        const settingsText = await readOptionalUtf8(getWorkflowProjectSettingsPath(projectPath));
        const settings = await readStoredWorkflowProjectSettings(projectPath, name, settingsText).catch((error) => {
          throw new LocalUpgradeDiagnosticError('project-settings-invalid', undefined, error);
        });
        const datasetsContents = await readOptionalUtf8(getWorkflowDatasetPath(projectPath));
        const sourceSnapshot = { contents, datasetsContents, settings };
        const visibleSettings = await getWorkflowProjectSettings(projectPath, name, {
          includeAggregatePublicationStatus: false,
          sourceSnapshot,
        });
        const publishedProjectPath = await resolvePublishedWorkflowProjectPath(
          root,
          projectPath,
          settings,
          sourceSnapshot,
        );
        if (settings.publishedEndpointName && !publishedProjectPath) {
          throw new LocalUpgradeDiagnosticError('publication-snapshot-missing');
        }
        const publishedContents = publishedProjectPath ? await readOptionalUtf8(publishedProjectPath) : null;
        if (publishedProjectPath && publishedContents === null) {
          throw new LocalUpgradeDiagnosticError('publication-snapshot-missing');
        }
        if (
          publishedProjectPath &&
          publishedContents !== null &&
          readProject(publishedContents).metadata.id !== workflowId
        ) {
          throw new LocalUpgradeDiagnosticError('publication-owner-mismatch');
        }
        const publishedVersions = await readFilesystemPublishedVersionsForMigration(root, projectPath, {
          projectId: workflowId,
          settings,
        }).catch((error) => {
          if (error instanceof LocalUpgradeDiagnosticError) throw error;
          throw new LocalUpgradeDiagnosticError('publication-history-invalid', undefined, error);
        });
        return {
          workflowId,
          relativePath,
          name,
          fileName,
          updatedAt: stats.mtime.toISOString(),
          contents,
          datasetsContents,
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
    } catch (error) {
      throw localUpgradeSourceError(error, relativePath, 'unexpected-error');
    }
  }
  for (const projectId of historicalProjectIds) {
    if (!projectIds.has(projectId)) {
      throw new LocalUpgradeDiagnosticError('publication-project-missing');
    }
  }
}
