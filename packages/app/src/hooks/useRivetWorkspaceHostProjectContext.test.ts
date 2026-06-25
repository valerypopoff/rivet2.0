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
  assert.match(workspaceHostSource, /releaseProjectContextState\(replaceTargetProjectId\);/);
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
  assert.match(workspaceHostSource, /reference\?\.projectId === replaceTargetProjectId \? undefined : reference/);
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
  assert.match(
    workspaceHostSource,
    /hasProjectContentChangedFromCleanDigest\(savedProjectContentDigests, contentBeforePatch\)/,
  );
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
  assert.match(
    projectTabUiSource,
    /export const projectTabUiState = atom<Record<ProjectId, ProjectTabUiState \| undefined>>\(\{\}\);/,
  );
  assert.doesNotMatch(projectTabUiSource, /atomWithStorage/);
  assert.match(workspaceHostSource, /export type RivetProjectTabUiState = ProjectTabUiState;/);
  assert.match(workspaceHostSource, /export type RivetProjectOpenOptions = \{[\s\S]*tabUi\?: RivetProjectTabUiState;/);
  assert.match(
    workspaceHostSource,
    /export type RivetProjectReplaceOptions = \{[\s\S]*tabUi\?: RivetProjectTabUiState;/,
  );
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
  assert.match(workspaceHostSource, /removeProjectTabUiState\(states, replaceTargetProjectId\)/);
  assert.match(hostSource, /RivetProjectOpenOptions/);
  assert.match(hostSource, /RivetProjectReplaceOptions/);
  assert.match(hostSource, /RivetProjectTabUiState/);
});

test('workspace host exposes transient opening project tabs for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');
  const openingTabsSource = readFileSync(join(hooksDir, '..', 'state', 'openingProjectTabs.ts'), 'utf8');
  const openingTabsUtilsSource = readFileSync(join(hooksDir, '..', 'utils', 'openingProjectTabs.ts'), 'utf8');
  const projectSelectorSource = readFileSync(join(hooksDir, '..', 'components', 'ProjectSelector.tsx'), 'utf8');
  const projectTabRowSource = readFileSync(
    join(hooksDir, '..', 'components', 'projectSelector', 'ProjectTabRow.tsx'),
    'utf8',
  );
  const rivetAppSource = readFileSync(join(hooksDir, '..', 'components', 'RivetApp.tsx'), 'utf8');
  const nodeRunningIndicatorSource = readFileSync(
    join(hooksDir, '..', 'components', 'visualNode', 'NodeRunningIndicator.tsx'),
    'utf8',
  );
  const menuCommandsSource = readFileSync(join(hooksDir, 'useMenuCommands.ts'), 'utf8');

  assert.match(openingTabsSource, /export type OpeningProjectTabInfo = \{/);
  assert.match(openingTabsSource, /replaceTargetProjectId\?: ProjectId;/);
  assert.match(openingTabsSource, /export const openingProjectTabsState = atom</);
  assert.match(openingTabsSource, /export const selectedOpeningProjectTabIdState = atom/);
  assert.match(openingTabsSource, /getWorkspaceVisibleTabCount\(\{/);
  assert.doesNotMatch(openingTabsSource, /atomWithStorage/);
  assert.match(openingTabsUtilsSource, /export function buildProjectTabListItems/);
  assert.match(openingTabsUtilsSource, /export function getWorkspaceVisibleTabCount/);

  assert.match(workspaceHostSource, /export type RivetOpeningProjectTabInput = \{/);
  assert.match(workspaceHostSource, /title: string;/);
  assert.match(workspaceHostSource, /path\?: string \| null;/);
  assert.match(workspaceHostSource, /export type RivetOpeningProjectTabOptions = \{/);
  assert.match(workspaceHostSource, /replaceCurrent\?: boolean;/);
  assert.match(workspaceHostSource, /startOpeningProjectTab\(/);
  assert.match(workspaceHostSource, /finishOpeningProjectTab\(/);
  assert.match(workspaceHostSource, /cancelOpeningProjectTab\(openingTabId: string\): Promise<boolean>;/);
  assert.match(workspaceHostSource, /replaceProjectId\?: ProjectId/);
  assert.match(workspaceHostSource, /projects\.openedProjects\[currentProject\.metadata\.id as ProjectId\]/);
  assert.match(workspaceHostSource, /setSelectedOpeningProjectTabId\(openingTabId\);/);
  assert.match(workspaceHostSource, /await removeOpeningProjectTab\(openingTabId\);/);

  assert.match(projectSelectorSource, /buildProjectTabListItems\(/);
  assert.match(projectSelectorSource, /const sortableProjectIds = useMemo\(/);
  assert.match(
    projectSelectorSource,
    /useSyncCurrentStateIntoOpenedProjects\(\{ enabled: projectMode && selectedOpeningProjectTabId == null \}\);/,
  );
  assert.match(projectSelectorSource, /<ProjectTabRow/);
  assert.match(projectTabRowSource, /<OpeningProjectTab/);
  assert.match(projectSelectorSource, /onCloseOpeningProjectTab=\{\(openingTabId\) => void cancelOpeningProjectTab\(openingTabId\)\}/);
  assert.doesNotMatch(projectSelectorSource, /LoadingSpinner/);
  assert.doesNotMatch(projectSelectorSource, /opening-project-spinner/);
  assert.match(rivetAppSource, /workspaceVisibleTabCountState/);
  assert.match(rivetAppSource, /selectedOpeningProjectTabIdState/);
  assert.match(rivetAppSource, /<OpeningProjectPlaceholder \/>/);
  assert.match(rivetAppSource, /canvasBackgroundColorModeState/);
  assert.match(rivetAppSource, /canvasBackgroundCustomColorState/);
  assert.match(rivetAppSource, /getCanvasBackgroundColor\(\{/);
  assert.match(rivetAppSource, /resolveCanvasBackgroundColorMode\(canvasBackgroundColorMode\)/);
  assert.match(rivetAppSource, /background-color: var\(--canvas-background-color, var\(--grey-darker\)\);/);
  assert.match(rivetAppSource, /'--canvas-background-color': canvasBackgroundColor/);
  assert.doesNotMatch(rivetAppSource, /background: var\(--canvas-bg\)/);
  assert.match(rivetAppSource, /NodeRunningIndicator/);
  assert.match(rivetAppSource, /opening-project-placeholder-spinner[\s\S]*color: currentColor;/);
  assert.match(rivetAppSource, /opening-project-placeholder-title[\s\S]*color: currentColor;/);
  assert.doesNotMatch(rivetAppSource, /<div css=\{openingProjectPlaceholderStyles\} role="status"/);
  assert.match(rivetAppSource, /label="Opening project"/);
  assert.match(nodeRunningIndicatorSource, /box-sizing: border-box;/);
  assert.match(nodeRunningIndicatorSource, /display: inline-block;/);
  assert.match(menuCommandsSource, /selectedOpeningProjectTabId == null \? openedProjectIds\.length : 0/);

  assert.match(hostSource, /RivetOpeningProjectTabHandle/);
  assert.match(hostSource, /RivetOpeningProjectTabInput/);
  assert.match(hostSource, /RivetOpeningProjectTabOptions/);
});

test('workspace host carries existing project executor mode through hosted snapshot opens', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');

  assert.match(workspaceHostSource, /const store = useStore\(\);/);
  assert.match(
    workspaceHostSource,
    /const existingExecutorMode = store\.get\(projectsState\)\.openedProjects\[projectId\]\?\.executorMode;/,
  );
  assert.match(workspaceHostSource, /executorMode: existingExecutorMode,/);
  assert.match(
    workspaceHostSource,
    /const nextExecutorMode = previousProjects\.openedProjects\[projectId\]\?\.executorMode \?\? existingExecutorMode;/,
  );
  assert.match(workspaceHostSource, /\.\.\.\(nextExecutorMode \? \{ executorMode: nextExecutorMode \} : \{\}\),/);
});
