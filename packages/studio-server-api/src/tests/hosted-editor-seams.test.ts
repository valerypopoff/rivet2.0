import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectRepoFileMissing,
  readRepoFile,
} from './helpers/repo-contract-helpers.js';

test('hosted editor shell mounts RivetAppHost with wrapper providers, executor URL, UI policy, and workspace bridge', () => {
  const entry = readRepoFile('packages/studio-server-web/entry.tsx');
  const hostedEditorApp = readRepoFile('packages/studio-server-web/dashboard/HostedEditorApp.tsx');
  const hostedProviders = readRepoFile('packages/studio-server-web/dashboard/hostedRivetProviders.ts');
  const editorMessageBridge = readRepoFile('packages/studio-server-web/dashboard/EditorMessageBridge.tsx');

  assert.match(entry, /\.\.\/app\/src\/host\.css/);
  assert.doesNotMatch(entry, /index\.css|colors\.css/);
  assert.match(hostedEditorApp, /<RivetAppHost/);
  assert.match(hostedEditorApp, /executor=\{\{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL \}\}/);
  assert.match(hostedEditorApp, /providers=\{hostedRivetProviders\}/);
  assert.match(hostedEditorApp, /ui=\{HOSTED_RIVET_UI\}/);
  assert.match(hostedEditorApp, /onWorkspaceHostReady=\{handleWorkspaceHostReady\}/);
  assert.match(hostedEditorApp, /onWorkspaceHostDisposed=\{handleWorkspaceHostDisposed\}/);
  assert.match(hostedEditorApp, /onProjectSaved=\{handleProjectSaved\}/);
  assert.match(hostedEditorApp, /onActiveProjectChanged=\{handleActiveProjectChanged\}/);
  assert.match(hostedEditorApp, /onOpenProjectCountChanged=\{handleOpenProjectCountChanged\}/);
  assert.match(
    hostedEditorApp,
    /<EditorMessageBridge\s+savedProjectSignal=\{savedProjectSignal\}\s+workspaceHost=\{workspaceHost\}\s+\/>/,
  );

  assert.match(hostedEditorApp, /const HOSTED_FILE_MENU_VISIBLE_ITEMS = \[/);
  assert.match(hostedEditorApp, /webApps:\s*\{\s*desktopPreview:\s*false,\s*\}/);
  for (const visibleItem of ['import_graph', 'export_graph', 'settings', 'get_help']) {
    assert.match(hostedEditorApp, new RegExp(`'${visibleItem}'`));
  }
  for (const hiddenItem of ['new_project', 'open_project', 'save_project', 'save_project_as']) {
    assert.doesNotMatch(hostedEditorApp, new RegExp(`'${hiddenItem}'`));
  }

  assert.match(hostedProviders, /io: new HostedIOProvider\(hostedDatasetProvider, hostedEvaluationStore\)/);
  assert.match(hostedProviders, /datasets: hostedDatasetProvider/);
  assert.match(hostedProviders, /environment: getDefaultEnvironmentProvider\(\)/);
  assert.match(hostedProviders, /pathPolicy: getDefaultPathPolicyProvider\(\)/);
  assert.match(hostedProviders, /createHttpRivetLLMProfileHealthStore/);
  assert.match(hostedProviders, /createHttpLLMProfileHealthAdminProvider/);
  assert.match(hostedProviders, /llmProfileHealthStore: hostedLLMProfileHealthStore/);
  assert.match(hostedProviders, /evaluationStore: hostedEvaluationStore/);
  assert.doesNotMatch(hostedProviders, /evaluationRunStore:/);
  assert.doesNotMatch(hostedProviders, /llmProfileHealthAdmin:/);
  assert.doesNotMatch(hostedProviders, /utils\/globals\/datasetProvider|utils\/globals\/ioProvider/);
  assert.match(editorMessageBridge, /workspaceHost: RivetWorkspaceHost/);
  assert.match(editorMessageBridge, /useOpenWorkflowProject\(workspaceHost\)/);
  assert.doesNotMatch(editorMessageBridge, /useRivetWorkspaceHost/);
});

test('hosted project IO keeps app-state cleanup and workspace commands on wrapper-owned seams', () => {
  const editorBridgeTypes = readRepoFile('packages/studio-server-shared/editor-bridge.ts');
  const editorMessageBridge = readRepoFile('packages/studio-server-web/dashboard/EditorMessageBridge.tsx');
  const editorCommandBridge = readRepoFile('packages/studio-server-web/dashboard/useEditorCommandBridge.ts');
  const editorProjectOpenCommands = readRepoFile('packages/studio-server-web/dashboard/editorProjectOpenCommands.ts');
  const editorProjectLifecycleCommands = readRepoFile('packages/studio-server-web/dashboard/editorProjectLifecycleCommands.ts');
  const openWorkflowProject = readRepoFile('packages/studio-server-web/dashboard/useOpenWorkflowProject.ts');
  const titleAfterSaveReconciler = readRepoFile('packages/studio-server-web/dashboard/useReconcileHostedProjectTitleAfterSave.ts');
  const savedGraphsOverride = readRepoFile('packages/studio-server-web/overrides/state/savedGraphs.ts');
  const loadProjectOverride = readRepoFile('packages/studio-server-web/overrides/hooks/useLoadProject.ts');
  const syncOpenedProjectsOverride = readRepoFile('packages/studio-server-web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts');
  const hostedIOProvider = readRepoFile('packages/studio-server-web/io/HostedIOProvider.ts');
  const hostedDatasetProvider = readRepoFile('packages/studio-server-web/io/HostedDatasetProvider.ts');

  assert.match(editorBridgeTypes, /projectId\?: string \| null/);
  assert.match(editorBridgeTypes, /refresh-open-project-from-disk/);
  assert.match(editorBridgeTypes, /workflow-paths-moved/);
  assert.match(editorMessageBridge, /useEditorCommandBridge/);
  assert.match(editorCommandBridge, /handleDeleteWorkflowProjectCommand/);
  assert.match(editorCommandBridge, /handleWorkflowPathsMovedCommand/);
  assert.match(editorCommandBridge, /handleRefreshOpenProjectCommand/);
  assert.match(editorCommandBridge, /setOpenedProjectSnapshots/);
  assert.match(editorCommandBridge, /loadedRecordingState/);
  assert.match(editorCommandBridge, /projectId != null && loadedRecording\?\.projectId === projectId \? null : loadedRecording/);
  assert.doesNotMatch(editorCommandBridge, /clearLoadedRecordingForProjectState/);
  assert.match(editorProjectLifecycleCommands, /context\.getWorkspace\(\)\.closeProject\(deletedProjectId\)/);
  assert.match(editorProjectLifecycleCommands, /context\.getWorkspace\(\)\.moveProjectPaths/);
  assert.match(editorProjectLifecycleCommands, /resolveHostedProjectMetadataUpdatesForPathMoves\(context\.getProjects\(\), moves\)/);
  assert.match(editorProjectLifecycleCommands, /context\.getWorkspace\(\)\.updateProjectMetadata/);
  assert.match(editorProjectLifecycleCommands, /persistedExternally: true/);
  assert.match(editorProjectLifecycleCommands, /changeSource: 'external-wrapper-rename'/);
  assert.match(editorProjectLifecycleCommands, /deleteHostedProjectContextState\(projectId\)/);
  assert.match(editorProjectLifecycleCommands, /await clearHostedDatasetsForProject\(projectId\)/);
  assert.match(editorProjectOpenCommands, /removeOpenedProjectSnapshot\(openedProject\.projectId\)/);
  assert.match(editorMessageBridge, /selectedExecutorState/);
  assert.match(editorMessageBridge, /setSelectedExecutor\('browser'\)/);
  assert.doesNotMatch(editorMessageBridge, /defaultExecutorState|setProjects|setOpenedProjects/);

  assert.match(openWorkflowProject, /openedProjectSnapshotsState/);
  assert.match(openWorkflowProject, /workspace\.openProjectSnapshot/);
  assert.match(openWorkflowProject, /workspace\.replaceCurrent/);
  assert.match(openWorkflowProject, /reloadFromDisk/);
  assert.match(openWorkflowProject, /canLoadProjectByPath\(ioProvider\)/);
  assert.match(openWorkflowProject, /retainOnlyOpenedProject/);
  assert.doesNotMatch(openWorkflowProject, /await loadProject|useRivetWorkspaceHost|useLoadProject/);

  assert.match(titleAfterSaveReconciler, /workspaceHost\.updateProjectMetadata/);
  assert.match(titleAfterSaveReconciler, /persistedExternally: true/);
  assert.doesNotMatch(titleAfterSaveReconciler, /projectsState|projectState|openedProjectSnapshotsState|savedProjectContentDigestsState|projectUnsavedChangesState|projectDataUnsavedChangesState/);
  assert.match(editorMessageBridge, /projectUnsavedChangesState/);
  assert.match(editorMessageBridge, /projectDataUnsavedChangesState/);
  assert.match(editorMessageBridge, /graphRunningState/);
  assert.doesNotMatch(editorMessageBridge, /savedProjectContentDigestsState/);
  assert.doesNotMatch(editorMessageBridge, /useSetAtom\(\s*(projectUnsavedChangesState|projectDataUnsavedChangesState)/);
  assert.doesNotMatch(editorMessageBridge, /markProjectDirtyFlag|markProjectClean/);

  assert.match(loadProjectOverride, /openedProjectSnapshotsState/);
  assert.match(loadProjectOverride, /useWorkspaceTransitions/);
  assert.match(loadProjectOverride, /providedSnapshot/);
  assert.doesNotMatch(loadProjectOverride, /setProject\(projectInfo\.project\)/);
  assert.match(syncOpenedProjectsOverride, /normalizeOpenedProjects/);
  assert.match(syncOpenedProjectsOverride, /openedProjectSnapshotsState/);
  assert.match(syncOpenedProjectsOverride, /savedProjectContentDigestsState/);
  assert.match(syncOpenedProjectsOverride, /projectUnsavedChangesState/);
  assert.match(syncOpenedProjectsOverride, /buildCurrentProjectContentSnapshot/);
  assert.match(syncOpenedProjectsOverride, /markProjectClean/);
  assert.match(syncOpenedProjectsOverride, /markProjectDirtyFlag/);
  assert.doesNotMatch(syncOpenedProjectsOverride, /evaluationsState|primeOpenedProjectSession/);
  assert.match(loadProjectOverride, /primeOpenedProjectSession\(projectInfo\.projectId/);
  assert.match(loadProjectOverride, /evaluation: cachedEvaluation/);
  assert.match(savedGraphsOverride, /createHybridStorage\('project'\)/);
  assert.match(
    savedGraphsOverride,
    /export function clearProjectContextState\(projectId: ProjectId\): void \{\s*\/\/[^\n]*\n\s*releaseProjectContextState\(projectId\);\s*\}/,
  );
  assert.match(
    savedGraphsOverride,
    /export function deleteHostedProjectContextState\(projectId: ProjectId\): void \{\s*clearProjectContextState\(projectId\);\s*projectStorage\.removeItem\(`projectContext__"\$\{projectId\}"`\);\s*\}/,
  );
  assert.doesNotMatch(savedGraphsOverride, /clearProjectContextState as/);

  assert.match(hostedIOProvider, /this\.#evaluationStore\.putLibrary/);
  assert.match(hostedIOProvider, /jotaiStore\.get\(evaluationLibraryState\)/);
  assert.match(hostedIOProvider, /await this\.#flushEvaluationLibrary\(\)/);
  assert.doesNotMatch(hostedIOProvider, /serializeEvaluationProjectData/);
  assert.match(hostedIOProvider, /contents: serializeProject\(project\) as string/);
  assert.match(hostedIOProvider, /datasetsContents: datasets\.length > 0 \? serializeDatasets\(datasets\) : null/);
  assert.match(hostedIOProvider, /this\.#datasetProvider\.exportDatasetsForProject/);
  assert.match(hostedIOProvider, /this\.#datasetProvider\.importDatasetsForProject/);
  assert.doesNotMatch(hostedIOProvider, /utils\/globals\/datasetProvider/);
  assert.match(hostedDatasetProvider, /deleteStoredDatasetsForProject\(projectId: ProjectId\)/);
  assert.match(hostedDatasetProvider, /metadata\.projectId === projectId/);
});

test('hosted executor, save, find, and clipboard seams keep clear ownership', () => {
  const viteAliases = readRepoFile('packages/studio-server-web/vite-aliases.ts');
  const hostedEditorApp = readRepoFile('packages/studio-server-web/dashboard/HostedEditorApp.tsx');
  const editorEvents = readRepoFile('packages/studio-server-web/dashboard/useEditorBridgeEvents.ts');
  const editorMessageBridge = readRepoFile('packages/studio-server-web/dashboard/EditorMessageBridge.tsx');
  const editorCommandBridge = readRepoFile('packages/studio-server-web/dashboard/useEditorCommandBridge.ts');
  const editorBridgeInteractions = readRepoFile('packages/studio-server-web/dashboard/useEditorBridgeInteractions.ts');
  const previewProjectLifecycle = readRepoFile('packages/studio-server-web/dashboard/usePreviewProjectLifecycle.ts');
  const clipboardHotkeys = readRepoFile('packages/studio-server-web/overrides/hooks/useCopyNodesHotkeys.ts');
  const packageJson = readRepoFile('package.json');

  assert.match(hostedEditorApp, /executor=\{\{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL \}\}/);
  assert.doesNotMatch(viteAliases, /useExecutorSession|useRemoteDebugger|useGraphExecutor|useRemoteExecutor|useSaveProject|useMenuCommands/);
  assert.match(editorMessageBridge, /useExecutorSessionRuntime\(\)/);
  assert.match(editorMessageBridge, /executorSessionRevisionState/);
  assert.match(previewProjectLifecycle, /executorTargetType === 'external-debugger'/);
  assert.match(hostedEditorApp, /keyboardShortcuts:\s*\{\s*saveProject: true/);
  assert.match(editorCommandBridge, /workspaceRef\.current\.saveCurrentProject\(\)/);
  assert.match(editorCommandBridge, /Failed to save the current hosted project/);
  assert.match(editorMessageBridge, /savedProjectSignal/);
  assert.match(previewProjectLifecycle, /promotePreviewProjectById/);
  assert.doesNotMatch(editorMessageBridge, /useSaveProject|onSave/);
  assert.doesNotMatch(editorMessageBridge, /rivet-project-saved/);
  assert.doesNotMatch(editorBridgeInteractions, /isSaveShortcutEvent|onSave/);
  assert.doesNotMatch(viteAliases, /useWindowsHotkeysFix/);
  assert.match(editorEvents, /if \(!event\.repeat\) \{\s*handleSaveProject\(\);\s*\}/);
  assert.match(editorEvents, /postMessageToEditor\(editorWindow,\s*\{\s*type: 'trigger-editor-find-shortcut'/);
  assert.match(editorEvents, /activeWorkflowProjectPath && isEditorDuplicateShortcutEvent\(event\)/);
  assert.match(editorEvents, /postMessageToEditor\(editorWindow,\s*\{\s*type: 'trigger-editor-duplicate-shortcut'/);
  assert.match(editorEvents, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(editorEvents, /isEditableElement\(eventTarget\)/);
  assert.match(editorBridgeInteractions, /function replayEditorFindShortcut/);
  assert.match(editorBridgeInteractions, /function replayEditorDuplicateShortcut/);
  assert.match(editorBridgeInteractions, /MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS/);
  assert.match(editorMessageBridge, /setSearching\(openOrFocusGraphSearchState\)/);
  assert.match(viteAliases, /useCopyNodesHotkeys/);
  assert.match(clipboardHotkeys, /function handleCut/);
  assert.match(clipboardHotkeys, /handleCopy\(event\);\s*deleteNodes\(\{ nodeIds: selectedNodeIds \}\)/);
  assert.match(clipboardHotkeys, /window\.addEventListener\('cut', cutListener, true\)/);

  for (const stalePath of [
    'packages/studio-server-web/overrides/hooks/hostedInternalExecutorSession.ts',
    'packages/studio-server-web/overrides/hooks/useHostedExecutorSession.ts',
    'packages/studio-server-web/overrides/hooks/useHostedRemoteDebugger.ts',
    'packages/studio-server-web/tests/hosted-executor-session.test.ts',
    'packages/studio-server-web/overrides/hooks/useGraphExecutor.ts',
    'packages/studio-server-web/overrides/hooks/useRemoteExecutor.ts',
    'packages/studio-server-web/overrides/hooks/useRemoteDebugger.ts',
    'packages/studio-server-web/overrides/hooks/useSaveProject.ts',
    'packages/studio-server-web/overrides/hooks/useMenuCommands.ts',
    'packages/studio-server-web/overrides/hooks/useWindowsHotkeysFix.tsx',
    'packages/studio-server-web/overrides/hooks/remoteDebuggerClient.ts',
    'packages/studio-server-web/overrides/hooks/remoteDebuggerDatasets.ts',
    'packages/studio-server-web/overrides/components/DebuggerConnectPanel.tsx',
  ]) {
    expectRepoFileMissing(stalePath);
  }

  assert.doesNotMatch(packageJson, /remote-execution-session\.test|remote-executor-protocol\.test|hosted-executor-session\.test/);
});
