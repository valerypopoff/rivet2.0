import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hooksDir = dirname(fileURLToPath(import.meta.url));

function source(...pathParts: string[]): string {
  return readFileSync(join(hooksDir, ...pathParts), 'utf8');
}

test('workspace host releases cached context atoms without deleting persisted context values', () => {
  const savedGraphsSource = source('..', 'state', 'savedGraphs.ts');
  const workspaceHostCleanupSource = source('workspaceHost', 'useWorkspaceHostProjectCleanup.ts');
  const workspaceHostOpenSource = source('workspaceHost', 'useWorkspaceHostOpenProject.ts');
  const workspaceHostCloseSource = source('workspaceHost', 'useWorkspaceHostCloseProject.ts');

  assert.match(savedGraphsSource, /export function releaseProjectContextState\(projectId: ProjectId\): void \{/);
  assert.match(savedGraphsSource, /projectContextState\.remove\(projectId\);/);
  assert.doesNotMatch(savedGraphsSource, /storage\.removeItem\(`projectContext__"\$\{projectId\}"`\)/);
  assert.match(workspaceHostCleanupSource, /releaseProjectContextState\(projectId\);/);
  assert.match(workspaceHostOpenSource, /cleanupClosedProject\(replacedProjectId\);/);
  assert.match(workspaceHostCloseSource, /cleanupClosedProject\(projectId,/);
  assert.doesNotMatch(workspaceHostCleanupSource, /clearProjectContextState/);
});

test('workspace host exposes a narrow clean-baseline API for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostCleanBaselineSource = source('workspaceHost', 'useWorkspaceHostCleanBaseline.ts');
  const hostSource = source('..', 'host.tsx');

  const cleanBaselineType = workspaceHostTypesSource.match(
    /export type RivetProjectCleanBaselineSnapshotInput = \{(?<body>[\s\S]*?)\};/,
  )?.groups?.body;

  assert.ok(cleanBaselineType);
  assert.match(cleanBaselineType, /project: Project \| Omit<Project, 'data'>;/);
  assert.match(cleanBaselineType, /data\?: Project\['data'\];/);
  assert.doesNotMatch(cleanBaselineType, /path\?:/);
  assert.doesNotMatch(cleanBaselineType, /openedGraph\?:/);
  assert.doesNotMatch(cleanBaselineType, /testSuites\?:/);
  assert.match(
    workspaceHostTypesSource,
    /markCurrentProjectClean\(snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostTypesSource,
    /markProjectClean\(projectId: ProjectId, snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(workspaceHostCleanBaselineSource, /buildCurrentProjectContentSnapshot\(/);
  assert.match(workspaceHostCleanBaselineSource, /markProjectContentClean\(previousDigests, cleanBaseline\)/);
  assert.match(workspaceHostCleanBaselineSource, /markProjectDirtyFlag\(previousFlags, projectId, false\)/);
  assert.match(
    workspaceHostCleanBaselineSource,
    /if \(!projects\.openedProjects\[projectId\] && currentProject\.metadata\.id !== projectId\) \{/,
  );
  assert.match(hostSource, /RivetProjectCleanBaselineSnapshotInput/);
});

test('workspace host exposes the normal project save transition for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostSaveSource = source('workspaceHost', 'useWorkspaceHostSave.ts');
  const workspaceHostFacadeSource = source('useRivetWorkspaceHost.ts');
  const hostSource = source('..', 'host.tsx');

  assert.match(workspaceHostTypesSource, /saveCurrentProject\(\): Promise<boolean>;/);
  assert.match(workspaceHostSaveSource, /workspaceTransitions\.saveProject\(\)/);
  assert.match(workspaceHostFacadeSource, /const saveCurrentProject = useWorkspaceHostSave\(\);/);
  assert.match(workspaceHostFacadeSource, /saveCurrentProject,/);
  assert.match(hostSource, /RivetWorkspaceHost,/);
});

test('workspace host exposes project compare controls for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostCompareSource = source('workspaceHost', 'useWorkspaceHostCompare.ts');
  const workspaceHostCleanupSource = source('workspaceHost', 'useWorkspaceHostProjectCleanup.ts');
  const workspaceHostOpenSource = source('workspaceHost', 'useWorkspaceHostOpenProject.ts');
  const hostSource = source('..', 'host.tsx');

  assert.match(workspaceHostTypesSource, /export type RivetProjectCompareOptions = \{/);
  assert.match(workspaceHostTypesSource, /labels\?: ProjectCompareSideLabels;/);
  assert.match(
    workspaceHostTypesSource,
    /startProjectCompare\(\s*referenceProject: Project,\s*referencePath\?: string \| null,\s*options\?: RivetProjectCompareOptions,\s*\): Promise<boolean>;/,
  );
  assert.match(workspaceHostTypesSource, /stopProjectCompare\(projectId\?: ProjectId\): Promise<boolean>;/);
  assert.match(workspaceHostCompareSource, /setViewingProjectComparisonNode\(undefined\);/);
  assert.match(workspaceHostCompareSource, /setProjectCompareReference\(\{/);
  assert.match(workspaceHostCompareSource, /projectCompareReference\.projectId !== projectId/);
  assert.match(workspaceHostCleanupSource, /reference\?\.projectId === projectId \? undefined : reference/);
  assert.match(workspaceHostOpenSource, /cleanupClosedProject\(replacedProjectId\);/);
  assert.match(workspaceHostCompareSource, /labels: options\?\.labels/);
  assert.match(hostSource, /RivetProjectCompareOptions/);
  assert.match(hostSource, /ProjectCompareSideLabels/);
});

test('workspace host exposes a narrow project metadata update API for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostMetadataSource = source('workspaceHost', 'useWorkspaceHostProjectMetadata.ts');
  const hostSource = source('..', 'host.tsx');
  const metadataUpdateSource = source('..', 'utils', 'projectMetadataUpdates.ts');

  assert.match(workspaceHostTypesSource, /export type RivetProjectMetadataUpdateOptions = \{/);
  assert.match(workspaceHostTypesSource, /path\?: string \| null;/);
  assert.match(workspaceHostTypesSource, /persistedExternally\?: boolean;/);
  assert.match(workspaceHostTypesSource, /changeSource\?: 'external-wrapper-rename';/);
  assert.match(workspaceHostTypesSource, /export type RivetProjectMetadataPatch = ProjectMetadataPatch;/);
  assert.match(
    metadataUpdateSource,
    /export type ProjectMetadataPatch = Pick<Partial<Project\['metadata'\]>, 'title' \| 'description'>;/,
  );
  assert.match(
    workspaceHostTypesSource,
    /updateProjectMetadata\(\s*projectId: ProjectId,\s*metadataPatch: RivetProjectMetadataPatch,\s*options\?: RivetProjectMetadataUpdateOptions,\s*\): Promise<boolean>;/,
  );
  assert.match(workspaceHostMetadataSource, /updateOpenedProjectMetadata\(/);
  assert.match(workspaceHostMetadataSource, /setCurrentProject\(patchedProject\);/);
  assert.match(workspaceHostMetadataSource, /setOpenedProjectSnapshots\(/);
  assert.match(workspaceHostMetadataSource, /if \(options\.persistedExternally\) \{/);
  assert.match(workspaceHostMetadataSource, /if \(!wasProjectDirty && patchedProject\) \{/);
  assert.match(
    workspaceHostMetadataSource,
    /hasProjectContentChangedFromCleanDigest\(savedProjectContentDigests, contentBeforePatch\)/,
  );
  assert.match(workspaceHostMetadataSource, /markProjectDirtyFlag\(previousFlags, projectId, true\)/);
  assert.match(hostSource, /RivetProjectMetadataPatch/);
  assert.match(hostSource, /RivetProjectMetadataUpdateOptions/);
});

test('workspace host exposes transient project tab UI state for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostTabUiSource = source('workspaceHost', 'useWorkspaceHostTabUi.ts');
  const workspaceHostOpenSource = source('workspaceHost', 'useWorkspaceHostOpenProject.ts');
  const workspaceHostCleanupSource = source('workspaceHost', 'useWorkspaceHostProjectCleanup.ts');
  const hostSource = source('..', 'host.tsx');
  const projectTabUiSource = source('..', 'state', 'projectTabUi.ts');

  assert.match(projectTabUiSource, /export type ProjectTabUiState = \{/);
  assert.match(projectTabUiSource, /preview\?: boolean;/);
  assert.match(
    projectTabUiSource,
    /export const projectTabUiState = atom<Record<ProjectId, ProjectTabUiState \| undefined>>\(\{\}\);/,
  );
  assert.doesNotMatch(projectTabUiSource, /atomWithStorage/);
  assert.match(workspaceHostTypesSource, /export type RivetProjectTabUiState = ProjectTabUiState;/);
  assert.match(
    workspaceHostTypesSource,
    /export type RivetProjectOpenOptions = \{[\s\S]*tabUi\?: RivetProjectTabUiState;/,
  );
  assert.match(workspaceHostTypesSource, /export type RivetProjectReplaceOptions = RivetProjectOpenOptions;/);
  assert.match(
    workspaceHostTypesSource,
    /openProjectSnapshot\(snapshot: RivetProjectSnapshotInput, options\?: RivetProjectOpenOptions\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostTypesSource,
    /replaceCurrent\(snapshot: RivetProjectSnapshotInput, options\?: RivetProjectReplaceOptions\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostTypesSource,
    /setProjectTabUiState\(projectId: ProjectId, state\?: RivetProjectTabUiState\): Promise<boolean>;/,
  );
  assert.match(workspaceHostTabUiSource, /if \(!projects\.openedProjects\[projectId\]\) \{/);
  assert.match(workspaceHostOpenSource, /const shouldPreseedTabUiState = options\.tabUi !== undefined;/);
  assert.match(
    workspaceHostOpenSource,
    /if \(shouldPreseedTabUiState\) \{[\s\S]*updateProjectTabUiState\(states, projectId, options\.tabUi\)/,
  );
  assert.match(
    workspaceHostOpenSource,
    /if \(shouldPreseedTabUiState\) \{[\s\S]*updateProjectTabUiState\(states, projectId, previousTabUiState\)/,
  );
  assert.match(workspaceHostCleanupSource, /removeProjectTabUiState\(states, projectId\)/);
  assert.match(workspaceHostOpenSource, /cleanupClosedProject\(replacedProjectId\);/);
  assert.match(hostSource, /RivetProjectOpenOptions/);
  assert.match(hostSource, /RivetProjectReplaceOptions/);
  assert.match(hostSource, /RivetProjectTabUiState/);
});

test('workspace host exposes transient opening project tabs for hosted wrappers', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostOpeningTabsSource = source('workspaceHost', 'useWorkspaceHostOpeningTabs.ts');
  const hostSource = source('..', 'host.tsx');
  const openingTabsSource = source('..', 'state', 'openingProjectTabs.ts');
  const openingTabsUtilsSource = source('..', 'utils', 'openingProjectTabs.ts');
  const projectSelectorSource = source('..', 'components', 'ProjectSelector.tsx');
  const projectTabRowSource = readFileSync(
    join(hooksDir, '..', 'components', 'projectSelector', 'ProjectTabRow.tsx'),
    'utf8',
  );
  const rivetAppSource = source('..', 'components', 'RivetApp.tsx');
  const nodeRunningIndicatorSource = readFileSync(
    join(hooksDir, '..', 'components', 'visualNode', 'NodeRunningIndicator.tsx'),
    'utf8',
  );
  const menuCommandsSource = source('useMenuCommands.ts');

  assert.match(openingTabsSource, /export type OpeningProjectTabInfo = \{/);
  assert.match(openingTabsSource, /replaceTargetProjectId\?: ProjectId;/);
  assert.match(openingTabsSource, /export const openingProjectTabsState = atom</);
  assert.match(openingTabsSource, /export const selectedOpeningProjectTabIdState = atom/);
  assert.match(openingTabsSource, /getWorkspaceVisibleTabCount\(\{/);
  assert.doesNotMatch(openingTabsSource, /atomWithStorage/);
  assert.match(openingTabsUtilsSource, /export function buildProjectTabListItems/);
  assert.match(openingTabsUtilsSource, /export function getWorkspaceVisibleTabCount/);

  assert.match(workspaceHostTypesSource, /export type RivetOpeningProjectTabInput = \{/);
  assert.match(workspaceHostTypesSource, /title: string;/);
  assert.match(workspaceHostTypesSource, /path\?: string \| null;/);
  assert.match(workspaceHostTypesSource, /export type RivetOpeningProjectTabOptions = RivetProjectOpenOptions & \{/);
  assert.match(workspaceHostTypesSource, /replaceCurrent\?: boolean;/);
  assert.match(workspaceHostOpeningTabsSource, /const startOpeningProjectTab = useStableCallback\(/);
  assert.match(workspaceHostOpeningTabsSource, /const finishOpeningProjectTab = useStableCallback\(/);
  assert.match(workspaceHostTypesSource, /cancelOpeningProjectTab\(openingTabId: string\): Promise<boolean>;/);
  assert.match(workspaceHostTypesSource, /replaceProjectId\?: ProjectId/);
  assert.match(workspaceHostOpeningTabsSource, /projects\.openedProjects\[currentProject\.metadata\.id as ProjectId\]/);
  assert.match(workspaceHostOpeningTabsSource, /setSelectedOpeningProjectTabId\(openingTabId\);/);
  assert.match(workspaceHostOpeningTabsSource, /await cancelOpeningProjectTab\(openingTabId\);/);

  assert.match(projectSelectorSource, /buildProjectTabListItems\(/);
  assert.match(projectSelectorSource, /const sortableProjectIds = useMemo\(/);
  assert.match(
    projectSelectorSource,
    /useSyncCurrentStateIntoOpenedProjects\(\{ enabled: projectMode && selectedOpeningProjectTabId == null \}\);/,
  );
  assert.match(projectSelectorSource, /<ProjectTabRow/);
  assert.match(projectTabRowSource, /<OpeningProjectTab/);
  assert.match(
    projectSelectorSource,
    /onCloseOpeningProjectTab=\{\(openingTabId\) => void cancelOpeningProjectTab\(openingTabId\)\}/,
  );
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

test('workspace host preserves existing executor mode and accepts an initial mode for new hosted snapshot tabs', () => {
  const workspaceHostTypesSource = source('workspaceHost', 'types.ts');
  const workspaceHostOpenSource = source('workspaceHost', 'useWorkspaceHostOpenProject.ts');

  assert.match(workspaceHostTypesSource, /executorMode\?: ProjectExecutorMode;/);
  assert.match(workspaceHostOpenSource, /const store = useStore\(\);/);
  assert.match(
    workspaceHostOpenSource,
    /const existingExecutorMode = store\.get\(projectsState\)\.openedProjects\[projectId\]\?\.executorMode;/,
  );
  assert.match(workspaceHostOpenSource, /const executorMode = existingExecutorMode \?\? options\.executorMode;/);
  assert.match(workspaceHostOpenSource, /executorMode,/);
  assert.match(
    workspaceHostOpenSource,
    /openProjectSnapshot\(snapshot, \{ \.\.\.options, replaceCurrent: true \}\)/,
  );
  assert.match(
    workspaceHostOpenSource,
    /const nextExecutorMode = previousProjects\.openedProjects\[projectId\]\?\.executorMode \?\? executorMode;/,
  );
  assert.match(workspaceHostOpenSource, /\.\.\.\(nextExecutorMode \? \{ executorMode: nextExecutorMode \} : \{\}\),/);
});
