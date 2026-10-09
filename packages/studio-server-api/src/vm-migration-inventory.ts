import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import { getAppDataRoot, getWorkflowRecordingsRoot, getWorkflowsRoot } from './security.js';
import { readDeploymentStorageRuntimeSettingsSync } from './deployment-storage-settings.js';
import { collectSourceFolderPaths, iterateSourceWorkflows } from './local-metadata/filesystem-workflow-source.js';
import { getLocalMetadataServingSelection } from './local-metadata/serving-selection.js';
import { SqliteMigrationSource } from './scripts/sqlite-migration-source.js';

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
  const selected = getLocalMetadataServingSelection();
  if (selected) {
    const source = await SqliteMigrationSource.open(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, selected.source, {
      inspection: true,
      expectedIdentity: SqliteMigrationSource.identity(
        process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!,
        selected.generationId,
        selected.source,
      ),
    });
    try {
      let codeNodes = 0,
        fileNodes = 0;
      for (const relativePath of source.catalog.listProjectPaths()) {
        const draft = await source.catalog.readDraftDefinition(relativePath);
        if (!draft) throw new Error('Source project changed during inspection. Retry Inspect source.');
        const project = loadProjectFromString(draft.contents, { logErrors: false });
        for (const graph of Object.values(project.graphs))
          for (const node of graph.nodes) {
            if (node.type === 'code' || node.type === 'codeNew') codeNodes++;
            if (node.type === 'readFile') fileNodes++;
          }
      }
      return {
        ...source.catalog.readMigrationCounts(),
        savedSettingsDomains: source.settings.listKeys().length,
        sourceDatabaseAuthority: 'Selected live SQLite generation and immutable local artifacts',
        codeNodes,
        fileNodes,
        warnings: [
          'Back up the complete selected generation and local-metadata control root, plus the original app-data maintenance barrier. Retained legacy files are not current data.',
          'SQLite migration skips online pre-copy. Pause this server, wait for every writer and run to drain, then copy and verify.',
          'VM environment, TLS, external secrets, browser-local data and plugins must be reviewed separately.',
          ...(codeNodes || fileNodes
            ? [
                `${codeNodes} Code node(s) and ${fileNodes} Read File node(s) need a manual portability review for VM paths, local modules and external side effects.`,
              ]
            : []),
        ],
      };
    } finally {
      await source.dispose();
    }
  }
  const folders = await collectSourceFolderPaths(getWorkflowsRoot());
  let projects = 0;
  let codeNodes = 0;
  let fileNodes = 0;
  let publishedEndpoints = 0;
  let publishedWebApps = 0;
  let publishedVersions = 0;
  // Use conversion's bounded, quiet reader and fixed diagnostics. The previous
  // inventory duplicated these checks and hid duplicate IDs behind a generic error.
  for await (const source of iterateSourceWorkflows(getWorkflowsRoot())) {
    projects++;
    const project = loadProjectFromString(source.contents, { logErrors: false });
    if (source.publishedEndpointName) publishedEndpoints++;
    publishedWebApps += source.publishedWebApps.length;
    publishedVersions += source.publishedVersions.length;
    for (const graph of Object.values(project.graphs)) {
      for (const node of Object.values(graph.nodes)) {
        if (node.type === 'code' || node.type === 'codeNew') codeNodes += 1;
        if (node.type === 'readFile') fileNodes += 1;
      }
    }
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
    projects,
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
