import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hooksDir = dirname(fileURLToPath(import.meta.url));

test('workspace host releases cached context atoms without deleting persisted context values', () => {
  const savedGraphsSource = readFileSync(join(hooksDir, '..', 'state', 'savedGraphs.ts'), 'utf8');
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');

  assert.match(savedGraphsSource, /export function releaseProjectContextState\(projectId: ProjectId\): void \{/);
  assert.match(savedGraphsSource, /projectContextState\.remove\(projectId\);/);
  assert.doesNotMatch(savedGraphsSource, /storage\.removeItem\(`projectContext__"\$\{projectId\}"`\)/);
  assert.match(workspaceHostSource, /releaseProjectContextState\(currentProjectId\);/);
  assert.match(workspaceHostSource, /releaseProjectContextState\(projectId\);/);
  assert.doesNotMatch(workspaceHostSource, /clearProjectContextState/);
});

test('workspace host exposes a narrow clean-baseline API for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');

  const cleanBaselineType = workspaceHostSource.match(
    /export type RivetProjectCleanBaselineSnapshotInput = \{(?<body>[\s\S]*?)\};/,
  )?.groups?.body;

  assert.ok(cleanBaselineType);
  assert.match(cleanBaselineType, /project: Project \| Omit<Project, 'data'>;/);
  assert.match(cleanBaselineType, /data\?: Project\['data'\];/);
  assert.doesNotMatch(cleanBaselineType, /path\?:/);
  assert.doesNotMatch(cleanBaselineType, /openedGraph\?:/);
  assert.doesNotMatch(cleanBaselineType, /testSuites\?:/);
  assert.match(
    workspaceHostSource,
    /markCurrentProjectClean\(snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostSource,
    /markProjectClean\(projectId: ProjectId, snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(workspaceHostSource, /buildCurrentProjectContentSnapshot\(/);
  assert.match(workspaceHostSource, /markProjectContentClean\(previousDigests, cleanBaseline\)/);
  assert.match(workspaceHostSource, /markProjectDirtyFlag\(previousFlags, projectId, false\)/);
  assert.match(
    workspaceHostSource,
    /if \(!projects\.openedProjects\[projectId\] && currentProject\.metadata\.id !== projectId\) \{/,
  );
  assert.match(hostSource, /RivetProjectCleanBaselineSnapshotInput/);
});

test('workspace host exposes project compare controls for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');

  assert.match(workspaceHostSource, /export type RivetProjectCompareOptions = \{/);
  assert.match(workspaceHostSource, /labels\?: ProjectCompareSideLabels;/);
  assert.match(
    workspaceHostSource,
    /startProjectCompare\(\s*referenceProject: Project,\s*referencePath\?: string \| null,\s*options\?: RivetProjectCompareOptions,\s*\): Promise<boolean>;/,
  );
  assert.match(workspaceHostSource, /stopProjectCompare\(projectId\?: ProjectId\): Promise<boolean>;/);
  assert.match(workspaceHostSource, /setViewingProjectComparisonNode\(undefined\);/);
  assert.match(workspaceHostSource, /setProjectCompareReference\(\{/);
  assert.match(workspaceHostSource, /reference\?\.projectId === projectId \? undefined : reference/);
  assert.match(workspaceHostSource, /reference\?\.projectId === currentProjectId \? undefined : reference/);
  assert.match(workspaceHostSource, /labels: options\?\.labels/);
  assert.match(hostSource, /RivetProjectCompareOptions/);
  assert.match(hostSource, /ProjectCompareSideLabels/);
});

test('workspace host exposes a narrow project metadata update API for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');
  const metadataUpdateSource = readFileSync(join(hooksDir, '..', 'utils', 'projectMetadataUpdates.ts'), 'utf8');

  assert.match(workspaceHostSource, /export type RivetProjectMetadataUpdateOptions = \{/);
  assert.match(workspaceHostSource, /path\?: string \| null;/);
  assert.match(workspaceHostSource, /persistedExternally\?: boolean;/);
  assert.match(workspaceHostSource, /changeSource\?: 'external-wrapper-rename';/);
  assert.match(workspaceHostSource, /export type RivetProjectMetadataPatch = ProjectMetadataPatch;/);
  assert.match(
    metadataUpdateSource,
    /export type ProjectMetadataPatch = Pick<Partial<Project\['metadata'\]>, 'title' \| 'description'>;/,
  );
  assert.match(
    workspaceHostSource,
    /updateProjectMetadata\(\s*projectId: ProjectId,\s*metadataPatch: RivetProjectMetadataPatch,\s*options\?: RivetProjectMetadataUpdateOptions,\s*\): Promise<boolean>;/,
  );
  assert.match(workspaceHostSource, /updateOpenedProjectMetadata\(/);
  assert.match(workspaceHostSource, /setCurrentProject\(patchedProject\);/);
  assert.match(workspaceHostSource, /setOpenedProjectSnapshots\(/);
  assert.match(workspaceHostSource, /if \(options\.persistedExternally\) \{/);
  assert.match(workspaceHostSource, /if \(!wasProjectDirty && patchedProject\) \{/);
  assert.match(workspaceHostSource, /hasProjectContentChangedFromCleanDigest\(savedProjectContentDigests, contentBeforePatch\)/);
  assert.match(workspaceHostSource, /markProjectDirtyFlag\(previousFlags, projectId, true\)/);
  assert.match(hostSource, /RivetProjectMetadataPatch/);
  assert.match(hostSource, /RivetProjectMetadataUpdateOptions/);
});

test('workspace host exposes transient project tab UI state for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');
  const projectTabUiSource = readFileSync(join(hooksDir, '..', 'state', 'projectTabUi.ts'), 'utf8');

  assert.match(projectTabUiSource, /export type ProjectTabUiState = \{/);
  assert.match(projectTabUiSource, /preview\?: boolean;/);
  assert.match(projectTabUiSource, /export const projectTabUiState = atom<Record<ProjectId, ProjectTabUiState \| undefined>>\(\{\}\);/);
  assert.doesNotMatch(projectTabUiSource, /atomWithStorage/);
  assert.match(workspaceHostSource, /export type RivetProjectTabUiState = ProjectTabUiState;/);
  assert.match(workspaceHostSource, /export type RivetProjectOpenOptions = \{[\s\S]*tabUi\?: RivetProjectTabUiState;/);
  assert.match(workspaceHostSource, /export type RivetProjectReplaceOptions = \{[\s\S]*tabUi\?: RivetProjectTabUiState;/);
  assert.match(
    workspaceHostSource,
    /openProjectSnapshot\(snapshot: RivetProjectSnapshotInput, options\?: RivetProjectOpenOptions\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostSource,
    /replaceCurrent\(snapshot: RivetProjectSnapshotInput, options\?: RivetProjectReplaceOptions\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostSource,
    /setProjectTabUiState\(projectId: ProjectId, state\?: RivetProjectTabUiState\): Promise<boolean>;/,
  );
  assert.match(workspaceHostSource, /if \(!projects\.openedProjects\[projectId\]\) \{/);
  assert.match(workspaceHostSource, /const shouldPreseedTabUiState = options\.tabUi !== undefined;/);
  assert.match(
    workspaceHostSource,
    /if \(shouldPreseedTabUiState\) \{[\s\S]*updateProjectTabUiState\(states, projectId, options\.tabUi\)/,
  );
  assert.match(
    workspaceHostSource,
    /if \(shouldPreseedTabUiState\) \{[\s\S]*updateProjectTabUiState\(states, projectId, previousTabUiState\)/,
  );
  assert.match(workspaceHostSource, /removeProjectTabUiState\(states, projectId\)/);
  assert.match(workspaceHostSource, /removeProjectTabUiState\(states, currentProjectId\)/);
  assert.match(hostSource, /RivetProjectOpenOptions/);
  assert.match(hostSource, /RivetProjectReplaceOptions/);
  assert.match(hostSource, /RivetProjectTabUiState/);
});
