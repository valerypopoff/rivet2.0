import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import { getAppDataRoot, getWorkflowRecordingsRoot, getWorkflowsRoot } from './security.js';
import { readDeploymentStorageRuntimeSettingsSync } from './deployment-storage-settings.js';
import { listProjectPathsRecursive } from './routes/workflows/fs-helpers.js';
import {
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
} from './routes/workflows/publication.js';
import {
  readFilesystemPublishedVersionsForMigration,
  validateFilesystemPublishedVersionArchiveForMigration,
} from './routes/workflows/published-versions.js';
import { listWorkflowFolders } from './routes/workflows/workflow-query.js';
import { collectFolderPaths } from './scripts/migrate-workflow-storage-lib.js';
import { withLocalSourceBudget } from './local-metadata/source-budget.js';
import { readMigrationSourceUtf8 } from './scripts/migration-source-utf8.js';

export type VmMigrationSourceInventory = {
  projects: number;
  folders: number;
  recordingBundles: number;
  publishedEndpoints: number;
  publishedWebApps: number;
  publishedVersions: number;
  savedSettingsDomains: number;
  sourceDatabaseAuthority: string;
  codeNodes: number;
  fileNodes: number;
  warnings: string[];
};

/** Read-only preview. The frozen importer's deeper validation remains authoritative. */
export async function inspectVmMigrationSource(): Promise<VmMigrationSourceInventory> {
  const projectPaths = await listProjectPathsRecursive(getWorkflowsRoot());
  const folders = collectFolderPaths(await listWorkflowFolders(getWorkflowsRoot()));
  let codeNodes = 0;
  let fileNodes = 0;
  let publishedEndpoints = 0;
  let publishedWebApps = 0;
  let publishedVersions = 0;
  const projectIds = new Set<string>();
  const historicalProjectIds = await validateFilesystemPublishedVersionArchiveForMigration(getWorkflowsRoot());
  for (const projectPath of projectPaths) {
    await withLocalSourceBudget(async () => {
      const stat = await fs.lstat(projectPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source project is not a regular file.');
      await readMigrationSourceUtf8(projectPath);
      const project = await loadProjectFromFile(projectPath);
      const projectId = project.metadata.id?.trim();
      if (!projectId || projectIds.has(projectId)) throw new Error('Source has a missing or duplicate project ID.');
      projectIds.add(projectId);
      const projectName = path.basename(projectPath, '.rivet-project');
      const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
      if (settings.publishedEndpointName) {
        if (!(await resolvePublishedWorkflowProjectPath(getWorkflowsRoot(), projectPath, settings))) {
          throw new Error(
            `Published endpoint snapshot is missing for ${path.relative(getWorkflowsRoot(), projectPath)}.`,
          );
        }
        publishedEndpoints += 1;
      }
      publishedWebApps += settings.publishedWebApps.length;
      publishedVersions += (await readFilesystemPublishedVersionsForMigration(getWorkflowsRoot(), projectPath)).length;
      for (const graph of Object.values(project.graphs)) {
        for (const node of Object.values(graph.nodes)) {
          if (node.type === 'code' || node.type === 'codeNew') codeNodes += 1;
          if (node.type === 'readFile') fileNodes += 1;
        }
      }
    });
  }
  for (const projectId of historicalProjectIds) {
    if (!projectIds.has(projectId)) throw new Error('Published history belongs to a missing source project.');
  }
  let recordingBundles = 0;
  const recordingsRoot = getWorkflowRecordingsRoot();
  const recordingProjects = await fs
    .readdir(recordingsRoot, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  for (const project of recordingProjects) {
    if (project.name.startsWith('.')) continue;
    if (!project.isDirectory()) throw new Error('Unexpected entry in the recording root.');
    for (const bundle of await fs.readdir(path.join(recordingsRoot, project.name), { withFileTypes: true })) {
      if (bundle.name.startsWith('.')) continue;
      if (!bundle.isDirectory()) throw new Error('Unexpected entry in a recording project directory.');
      recordingBundles += 1;
    }
  }
  const settingsRoot = path.join(getAppDataRoot(), 'settings');
  const settings = await fs.readdir(settingsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const savedSettingsDomains = settings.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  const warnings = [
    'VM environment, TLS, external secrets, browser-local data and plugins must be reviewed separately.',
  ];
  const storage = readDeploymentStorageRuntimeSettingsSync();
  if (storage.storageMode !== 'filesystem') throw new Error('The source is not using local project folders.');
  if (storage.databaseMode === 'local-docker') {
    warnings.push(
      'Local Docker PostgreSQL is not an authority while local project folders are active. Inspect and back up its volume separately if another application uses it.',
    );
  }
  if (codeNodes || fileNodes) {
    warnings.push(
      `${codeNodes} Code node(s) and ${fileNodes} Read File node(s) need a manual portability review for VM paths, local modules and external side effects.`,
    );
  }
  return {
    projects: projectPaths.length,
    folders: folders.length,
    recordingBundles,
    publishedEndpoints,
    publishedWebApps,
    publishedVersions,
    savedSettingsDomains,
    sourceDatabaseAuthority: 'Local workflow files and SQLite operational databases',
    codeNodes,
    fileNodes,
    warnings,
  };
}
