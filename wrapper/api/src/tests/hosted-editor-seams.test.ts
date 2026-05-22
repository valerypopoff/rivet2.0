import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectRepoFileMissing,
  readRepoFile,
} from './helpers/repo-contract-helpers.js';

test('hosted editor shell mounts RivetAppHost with wrapper providers, executor URL, UI policy, and workspace bridge', () => {
  const entry = readRepoFile('wrapper/web/entry.tsx');
  const hostedEditorApp = readRepoFile('wrapper/web/dashboard/HostedEditorApp.tsx');
  const hostedProviders = readRepoFile('wrapper/web/dashboard/hostedRivetProviders.ts');
  const editorMessageBridge = readRepoFile('wrapper/web/dashboard/EditorMessageBridge.tsx');

  assert.match(entry, /rivet\/packages\/app\/src\/host\.css/);
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
  assert.match(hostedEditorApp, /<EditorMessageBridge workspaceHost=\{workspaceHost\} \/>/);

  assert.match(hostedEditorApp, /const HOSTED_FILE_MENU_VISIBLE_ITEMS = \[/);
  for (const visibleItem of ['import_graph', 'export_graph', 'settings', 'get_help']) {
    assert.match(hostedEditorApp, new RegExp(`'${visibleItem}'`));
  }
  for (const hiddenItem of ['new_project', 'open_project', 'save_project', 'save_project_as']) {
    assert.doesNotMatch(hostedEditorApp, new RegExp(`'${hiddenItem}'`));
  }

  assert.match(hostedProviders, /io: new HostedIOProvider\(hostedDatasetProvider\)/);
  assert.match(hostedProviders, /datasets: hostedDatasetProvider/);
  assert.match(hostedProviders, /environment: getDefaultEnvironmentProvider\(\)/);
  assert.match(hostedProviders, /pathPolicy: getDefaultPathPolicyProvider\(\)/);
  assert.doesNotMatch(hostedProviders, /utils\/globals\/datasetProvider|utils\/globals\/ioProvider/);
  assert.match(editorMessageBridge, /workspaceHost: RivetWorkspaceHost/);
  assert.match(editorMessageBridge, /useOpenWorkflowProject\(workspaceHost\)/);
  assert.doesNotMatch(editorMessageBridge, /useRivetWorkspaceHost/);
});

test('hosted project IO keeps app-state cleanup and workspace commands on wrapper-owned seams', () => {
  const editorBridgeTypes = readRepoFile('wrapper/shared/editor-bridge.ts');
  const editorMessageBridge = readRepoFile('wrapper/web/dashboard/EditorMessageBridge.tsx');
  const openWorkflowProject = readRepoFile('wrapper/web/dashboard/useOpenWorkflowProject.ts');
  const savedGraphsOverride = readRepoFile('wrapper/web/overrides/state/savedGraphs.ts');
  const loadProjectOverride = readRepoFile('wrapper/web/overrides/hooks/useLoadProject.ts');
  const syncOpenedProjectsOverride = readRepoFile('wrapper/web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts');
  const hostedIOProvider = readRepoFile('wrapper/web/io/HostedIOProvider.ts');
  const hostedDatasetProvider = readRepoFile('wrapper/web/io/HostedDatasetProvider.ts');

  assert.match(editorBridgeTypes, /projectId\?: string \| null/);
  assert.match(editorBridgeTypes, /refresh-open-project-from-disk/);
  assert.match(editorBridgeTypes, /workflow-paths-moved/);
  assert.match(editorMessageBridge, /workspaceRef\.current\.closeProject\(deletedProjectId\)/);
  assert.match(editorMessageBridge, /workspaceRef\.current\.moveProjectPaths/);
  assert.match(editorMessageBridge, /deleteHostedProjectContextState\(projectId\)/);
  assert.match(editorMessageBridge, /await clearHostedDatasetsForProject\(projectId\)/);
  assert.match(editorMessageBridge, /refresh-open-project-from-disk/);
  assert.match(editorMessageBridge, /setOpenedProjectSnapshots/);
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

  assert.match(loadProjectOverride, /openedProjectSnapshotsState/);
  assert.match(loadProjectOverride, /useWorkspaceTransitions/);
  assert.match(loadProjectOverride, /providedSnapshot/);
  assert.doesNotMatch(loadProjectOverride, /setProject\(projectInfo\.project\)/);
  assert.match(syncOpenedProjectsOverride, /normalizeOpenedProjects/);
  assert.match(syncOpenedProjectsOverride, /openedProjectSnapshotsState/);
  assert.match(savedGraphsOverride, /deleteHostedProjectContextState\(projectId: ProjectId\)/);
  assert.match(savedGraphsOverride, /clearProjectContextState as deleteStoredProjectContextState/);
  assert.doesNotMatch(savedGraphsOverride, /storage\.removeItem/);

  assert.match(hostedIOProvider, /this\.#datasetProvider\.exportDatasetsForProject/);
  assert.match(hostedIOProvider, /this\.#datasetProvider\.importDatasetsForProject/);
  assert.doesNotMatch(hostedIOProvider, /utils\/globals\/datasetProvider/);
  assert.match(hostedDatasetProvider, /deleteStoredDatasetsForProject\(projectId: ProjectId\)/);
  assert.match(hostedDatasetProvider, /metadata\.projectId === projectId/);
});

test('hosted executor, save, find, and clipboard shims stay scoped to wrapper-owned overrides', () => {
  const viteAliases = readRepoFile('wrapper/web/vite-aliases.ts');
  const hostedEditorApp = readRepoFile('wrapper/web/dashboard/HostedEditorApp.tsx');
  const editorEvents = readRepoFile('wrapper/web/dashboard/useEditorBridgeEvents.ts');
  const editorMessageBridge = readRepoFile('wrapper/web/dashboard/EditorMessageBridge.tsx');
  const windowsHotkeysFix = readRepoFile('wrapper/web/overrides/hooks/useWindowsHotkeysFix.tsx');
  const clipboardHotkeys = readRepoFile('wrapper/web/overrides/hooks/useCopyNodesHotkeys.ts');
  const packageJson = readRepoFile('package.json');

  assert.match(hostedEditorApp, /executor=\{\{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL \}\}/);
  assert.doesNotMatch(viteAliases, /useExecutorSession|useRemoteDebugger|useGraphExecutor|useRemoteExecutor|useSaveProject|useMenuCommands/);
  assert.match(editorMessageBridge, /const \{ saveProject \} = useSaveProject\(\)/);
  assert.doesNotMatch(editorMessageBridge, /rivet-project-saved/);
  assert.match(windowsHotkeysFix, /menuId === 'save_project' && isHostedMode\(\)/);
  assert.doesNotMatch(windowsHotkeysFix, /CmdOrCtrl\+Shift\+I|import_graph/);
  assert.match(editorEvents, /postMessageToEditor\(editorWindow,\s*\{\s*type: 'trigger-editor-find-shortcut'/);
  assert.match(editorEvents, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(editorEvents, /isEditableElement\(eventTarget\)/);
  assert.match(editorMessageBridge, /function replayEditorFindShortcut/);
  assert.match(editorMessageBridge, /MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS/);
  assert.match(editorMessageBridge, /setSearching\(openOrFocusGraphSearchState\)/);
  assert.match(viteAliases, /useCopyNodesHotkeys/);
  assert.match(clipboardHotkeys, /function handleCut/);
  assert.match(clipboardHotkeys, /handleCopy\(event\);\s*deleteNodes\(\{ nodeIds: selectedNodeIds \}\)/);
  assert.match(clipboardHotkeys, /window\.addEventListener\('cut', cutListener, true\)/);

  for (const stalePath of [
    'wrapper/web/overrides/hooks/hostedInternalExecutorSession.ts',
    'wrapper/web/overrides/hooks/useHostedExecutorSession.ts',
    'wrapper/web/overrides/hooks/useHostedRemoteDebugger.ts',
    'wrapper/web/tests/hosted-executor-session.test.ts',
    'wrapper/web/overrides/hooks/useGraphExecutor.ts',
    'wrapper/web/overrides/hooks/useRemoteExecutor.ts',
    'wrapper/web/overrides/hooks/useRemoteDebugger.ts',
    'wrapper/web/overrides/hooks/useSaveProject.ts',
    'wrapper/web/overrides/hooks/useMenuCommands.ts',
    'wrapper/web/overrides/hooks/remoteDebuggerClient.ts',
    'wrapper/web/overrides/hooks/remoteDebuggerDatasets.ts',
    'wrapper/web/overrides/components/DebuggerConnectPanel.tsx',
  ]) {
    expectRepoFileMissing(stalePath);
  }

  assert.doesNotMatch(packageJson, /remote-execution-session\.test|remote-executor-protocol\.test|hosted-executor-session\.test/);
});
