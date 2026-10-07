import fs from 'node:fs/promises';
import path from 'node:path';

import {
  fingerprintVmMigrationSourceParts,
  readVmMigrationSourceParts,
} from '../scripts/vm-migration-source-manifest.js';
import { migrateLocalAppSettings } from '../scripts/migrate-local-app-settings.js';
import { createSourceArchive, readSourceManifest } from '../scripts/migrate-runtime-libraries.js';
import { LocalWorkflowCatalog } from './workflow-catalog.js';
import { stageFrozenRecordingCatalog, stageFrozenWorkflowCatalog } from './stage-workflow-catalog.js';
import { collectSourceFolderPaths, iterateSourceWorkflows } from './filesystem-workflow-source.js';
import { iterateSourceRecordings } from './filesystem-recording-source.js';
import { withLocalSourceBudget } from './source-budget.js';
import { verifySqliteWorkflowServing, type LocalServingCheckReport } from './verify-serving-candidate.js';
import { localMetadataSourceIdentity } from './source-identity.js';
import type { LocalUpgradeStage } from './upgrade-diagnostics.js';

type SourceRoots = { workflows: string; recordings: string; appData: string; runtimeLibraries: string };

export type LocalMetadataCandidateReport = {
  reportVersion: 1;
  activationReady: false;
  sourceIdentity: string;
  sourceFingerprint: string;
  folders: number;
  projects: number;
  publishedVersions: number;
  publishedWebApps: number;
  recordings: number;
  appSettingsDomains: number;
  runtimeLibraryPackages: number;
  servingChecks: LocalServingCheckReport;
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveThroughExistingParent(input: string): Promise<string> {
  let cursor = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      await fs.lstat(cursor);
      return path.join(await fs.realpath(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Stage and exactly compare candidate domains without changing serving
 * authority. The operator service separately certifies operational snapshots
 * and coordinates paused activation through the durable transition journal.
 */
export async function stageLocalMetadataCandidate(options: {
  source: SourceRoots;
  candidate: { catalogDatabasePath: string; settingsDatabasePath: string; artifactRoot: string };
  settingsEncryptionKey?: string;
  verifyOnly?: boolean;
  assertFrozen: () => Promise<void>;
  onStage?: (stage: LocalUpgradeStage) => Promise<void>;
}): Promise<LocalMetadataCandidateReport> {
  options = { ...options, source: { ...options.source }, candidate: { ...options.candidate } };
  const destinations = await Promise.all(
    [options.candidate.catalogDatabasePath, options.candidate.settingsDatabasePath, options.candidate.artifactRoot].map(
      resolveThroughExistingParent,
    ),
  );
  const comparable = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (new Set(destinations.map(comparable)).size !== destinations.length) {
    throw new Error('Local metadata candidate paths must be distinct.');
  }
  if (isInside(destinations[2]!, destinations[0]!) || isInside(destinations[2]!, destinations[1]!)) {
    throw new Error('Local metadata databases must be outside the artifact root.');
  }
  const sources = await Promise.all(Object.values(options.source).map(resolveThroughExistingParent));
  for (const destination of destinations) {
    for (const source of sources) {
      if (isInside(source, destination) || isInside(destination, source)) {
        throw new Error('Local metadata candidate must be outside every source root.');
      }
    }
  }
  await options.assertFrozen();
  if (!options.verifyOnly) await fs.mkdir(options.candidate.artifactRoot, { recursive: true, mode: 0o700 });
  const artifactRoot = await fs.lstat(options.candidate.artifactRoot);
  if (!artifactRoot.isDirectory() || artifactRoot.isSymbolicLink()) {
    throw new Error('Local metadata artifact root must be a real directory.');
  }
  await options.assertFrozen();
  const before = await readVmMigrationSourceParts(options.source);
  const catalog = new LocalWorkflowCatalog({
    databasePath: options.candidate.catalogDatabasePath,
    artifactRoot: options.candidate.artifactRoot,
  });
  try {
    await options.onStage?.('workflows');
    const workflows = await stageFrozenWorkflowCatalog({
      sourceRoot: options.source.workflows,
      catalog,
      verifyOnly: options.verifyOnly,
      assertFrozen: options.assertFrozen,
    });
    await options.onStage?.('recordings');
    const recordings = await stageFrozenRecordingCatalog({
      sourceRoot: options.source.workflows,
      recordingsRoot: options.source.recordings,
      catalog,
      verifyOnly: options.verifyOnly,
      assertFrozen: options.assertFrozen,
    });
    await options.assertFrozen();
    await options.onStage?.('settings');
    const appSettingsDomains = await withLocalSourceBudget(() =>
      migrateLocalAppSettings({
        sourceRoot: options.source.appData,
        databasePath: options.candidate.settingsDatabasePath,
        encryptionKey: options.settingsEncryptionKey,
        verifyOnly: options.verifyOnly,
      }),
    );
    await options.assertFrozen();
    await options.onStage?.('runtime-libraries');
    const manifest = await readSourceManifest(options.source.runtimeLibraries);
    const runtimeLibraryPackages = Object.keys(manifest.packages).length;
    const runtimeState = {
      manifest,
      archive: runtimeLibraryPackages
        ? await withLocalSourceBudget(() => createSourceArchive(options.source.runtimeLibraries))
        : null,
    };
    if (!options.verifyOnly) await catalog.importRuntimeLibraryState(runtimeState);
    const candidateRuntimeState = await catalog.readRuntimeLibraryState();
    if (
      !candidateRuntimeState ||
      JSON.stringify(candidateRuntimeState.manifest) !== JSON.stringify(runtimeState.manifest) ||
      (candidateRuntimeState.archive === null) !== (runtimeState.archive === null) ||
      (candidateRuntimeState.archive &&
        runtimeState.archive &&
        !candidateRuntimeState.archive.equals(runtimeState.archive))
    ) {
      throw new Error('Local runtime-library candidate differs from source.');
    }
    await options.assertFrozen();
    await options.onStage?.('serving-verification');
    const sourceProjects: Array<{ workflowId: string }> = [];
    for await (const project of iterateSourceWorkflows(options.source.workflows))
      sourceProjects.push({ workflowId: project.workflowId });
    const servingChecks = await verifySqliteWorkflowServing({
      databasePath: options.candidate.catalogDatabasePath,
      artifactRoot: options.candidate.artifactRoot,
      virtualRoot: options.source.workflows,
      projects: () => iterateSourceWorkflows(options.source.workflows),
      folders: await collectSourceFolderPaths(options.source.workflows),
      recordings: () => iterateSourceRecordings(options.source.recordings, sourceProjects),
      assertFrozen: options.assertFrozen,
    });
    const after = await readVmMigrationSourceParts(options.source);
    const sourceFingerprint = fingerprintVmMigrationSourceParts(before);
    if (fingerprintVmMigrationSourceParts(after) !== sourceFingerprint) {
      throw new Error('Local metadata source changed during candidate staging; the candidate is not verified.');
    }
    return {
      reportVersion: 1,
      activationReady: false,
      sourceIdentity: localMetadataSourceIdentity(options.source),
      sourceFingerprint,
      ...workflows,
      recordings,
      appSettingsDomains,
      runtimeLibraryPackages,
      servingChecks,
    };
  } finally {
    catalog.close();
  }
}
