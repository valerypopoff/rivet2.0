import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  type DataId,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type Project,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { toast, type Id as ToastId } from 'react-toastify';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { cleanupNodeAtomFamilies, graphState, historicalGraphState, isReadOnlyGraphState } from '../state/graph.js';
import {
  canvasPositionState,
  graphNavigationStackState,
  lastCanvasPositionByGraphState,
  selectedNodesState,
} from '../state/graphBuilder.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectDataState,
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  projectsState,
  projectState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { trivetState } from '../state/trivet.js';
import { useCenterViewOnGraph } from './useCenterViewOnGraph.js';
import { useSaveCurrentGraph } from './useSaveCurrentGraph.js';
import type { GraphViewContext } from '../domain/graphEditing/navigationActions.js';
import {
  createDefaultTrivetState,
  createGraphSwitchTransition,
  createProjectLoadTransition,
  mergeCurrentGraphIntoProject,
  shouldPersistProjectBeforeLoad,
} from '../utils/workspaceTransitions.js';
import { handleError } from '../utils/errorHandling.js';
import { useStaticDataDatabase } from './useStaticDataDatabase.js';
import { addOpenedProject } from '../utils/openedProjects.js';
import {
  resolveCanvasPositionsForProject,
  resolvePersistedCanvasPositionsForLegacyCache,
  resolveProjectEditorRestoreTarget,
} from '../utils/projectEditorState.js';
import { flushHybridStorageGroup } from '../state/storage.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { canSaveProjectDataNoPrompt } from '../utils/projectSaveCapabilities.js';
import { pluginsState, projectNodeRegistryState } from '../state/plugins.js';
import { withDerivedProjectPluginSpecs } from '../utils/pluginUsage.js';
import { useProjectExecutionSnapshots } from './useProjectExecutionSnapshots.js';
import { markProjectClean, markProjectDirtyFlag } from '../utils/projectUnsavedChanges.js';
import { useApplyProjectExecutorMode } from './useProjectExecutorMode.js';
import type { ProjectExecutorMode } from '../utils/projectExecutorMode.js';
import { projectWorkspaceTargetsState, setProjectWorkspaceTargetState } from '../state/workspaceTarget.js';
import {
  createGraphWorkspaceTarget,
  getFallbackGraphView,
  getProjectWorkspaceLeavePolicy,
  resolveProjectWorkspaceTarget,
} from '../domain/workspace/projectWorkspaceTarget.js';

export function useWorkspaceTransitions() {
  const ioProvider = useIOProvider();
  const hostCallbacks = useRivetAppHostCallbacks();
  const store = useStore();
  const database = useStaticDataDatabase();
  const [currentGraph, setGraph] = useAtom(graphState);
  const [project, setProject] = useAtom(projectState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const setProjectData = useSetAtom(projectDataState);
  const setTrivetState = useSetAtom(trivetState);
  const setNavigationStack = useSetAtom(graphNavigationStackState);
  const setIsReadOnlyGraph = useSetAtom(isReadOnlyGraphState);
  const setHistoricalGraph = useSetAtom(historicalGraphState);
  const setSelectedNodes = useSetAtom(selectedNodesState);
  const setPosition = useSetAtom(canvasPositionState);
  const setLastSavedPositions = useSetAtom(lastCanvasPositionByGraphState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const setProjects = useSetAtom(projectsState);
  const setWorkspaceTarget = useSetAtom(setProjectWorkspaceTargetState);
  const centerViewOnGraph = useCenterViewOnGraph();
  const saveCurrentGraph = useSaveCurrentGraph();
  const applyProjectExecutorMode = useApplyProjectExecutorMode();
  const { persistCurrentProjectExecutionSnapshot, restoreProjectExecutionSnapshot } = useProjectExecutionSnapshots();
  const { testSuites } = useAtomValue(trivetState);
  const {
    canvasPosition,
    graphNavigationStack,
    lastCanvasPositionsByGraph: lastSavedPositions,
    persistOpenedProjectSnapshot,
    persistCurrentProjectEditorSnapshot,
    projectEditorStateByProjectId,
  } = useCurrentProjectEditorSnapshot();

  const persistCurrentGraphWorkspace = () => {
    const currentTarget = store.get(projectWorkspaceTargetsState)[project.metadata.id];
    const leavePolicy = getProjectWorkspaceLeavePolicy(currentTarget);
    const currentGraphId = currentGraph.metadata?.id;

    if (project.metadata.id && leavePolicy.persistGraphViewport) {
      persistCurrentProjectEditorSnapshot({ currentGraphId });

      if (currentGraphId) {
        setLastSavedPositions((previousPositionsByGraph) => ({
          ...previousPositionsByGraph,
          [currentGraphId]: {
            x: canvasPosition.x,
            y: canvasPosition.y,
            zoom: canvasPosition.zoom,
          },
        }));
      }
    }

    const savedCurrentGraph = leavePolicy.commitLiveGraph ? saveCurrentGraph() : undefined;
    const latestProject = store.get(projectState);

    if (latestProject.metadata.id && savedCurrentGraph) {
      persistOpenedProjectSnapshot({ project: latestProject, graph: savedCurrentGraph });
    }

    return { latestProject, savedCurrentGraph };
  };

  async function applyStaticData(data: Project['data'] | undefined) {
    setProjectData(data);

    try {
      await database.clear();
    } catch (err) {
      handleError(err, 'Failed to clear static data cache while loading project', {
        metadata: {
          projectId: project.metadata.id,
          projectPath: loadedProject.path,
        },
        toastError: false,
      });
    }

    if (!data) {
      return;
    }

    for (const [id, dataValue] of Object.entries(data)) {
      try {
        await database.insert(id as DataId, dataValue!);
      } catch (err) {
        handleError(err, `Failed to hydrate static data entry "${id}" while loading project`, {
          metadata: {
            dataId: id,
            projectId: project.metadata.id,
            projectPath: loadedProject.path,
          },
          toastError: false,
        });
      }
    }
  }

  return {
    async loadProject(projectInfo: {
      project: Omit<Project, 'data'>;
      data?: Project['data'];
      fsPath?: string | null;
      openedGraph?: GraphId;
      testSuites?: typeof testSuites;
      graphToLoad?: typeof currentGraph;
      graphView?: GraphViewContext;
      markClean?: boolean;
      executorMode?: ProjectExecutorMode;
    }): Promise<boolean> {
      try {
        const currentProjectId = project.metadata.id;
        const targetProjectId = projectInfo.project.metadata.id;
        const currentProjectHasOpenTab = Boolean(
          currentProjectId && store.get(projectsState).openedProjects[currentProjectId],
        );
        const targetProjectHasOpenTab = Boolean(store.get(projectsState).openedProjects[targetProjectId]);
        const storedWorkspaceTarget = store.get(projectWorkspaceTargetsState)[targetProjectId];
        const shouldPersistCurrentProject = shouldPersistProjectBeforeLoad({
          currentProjectHasOpenTab,
          loadedProject,
          navigationStack: graphNavigationStack,
          project,
        });
        const currentWorkspaceTarget = store.get(projectWorkspaceTargetsState)[currentProjectId];
        const shouldPersistCurrentProjectEditorState =
          shouldPersistCurrentProject && getProjectWorkspaceLeavePolicy(currentWorkspaceTarget).persistGraphViewport;

        const currentProjectEditorSnapshot = shouldPersistCurrentProjectEditorState
          ? persistCurrentProjectEditorSnapshot()
          : undefined;

        if (shouldPersistCurrentProject && currentProjectId) {
          persistOpenedProjectSnapshot();
        }
        const currentProjectExecutionSnapshot =
          shouldPersistCurrentProject && currentProjectId
            ? persistCurrentProjectExecutionSnapshot(currentProjectId)
            : undefined;

        const persistedProjectEditorState =
          targetProjectId === currentProjectId
            ? currentProjectEditorSnapshot ?? projectEditorStateByProjectId[targetProjectId]
            : projectEditorStateByProjectId[targetProjectId];
        const restoreTarget = resolveProjectEditorRestoreTarget({
          project: projectInfo.project,
          persistedProjectEditorState,
          explicitGraphToLoad: projectInfo.graphToLoad,
          explicitGraphView: projectInfo.graphView,
          openedGraphId: projectInfo.openedGraph,
          legacyCanvasPositionsByGraph: lastSavedPositions,
        });

        const transition = createProjectLoadTransition({
          currentGraph,
          graphToLoad: restoreTarget.graph,
          navigationStack: restoreTarget.navigationStack,
          path: projectInfo.fsPath,
          project: projectInfo.project,
          viewport: restoreTarget.viewport,
        });
        const fallbackGraphId = transition.graph.metadata?.id;
        if (!fallbackGraphId) {
          throw new Error('Cannot load a project without a valid graph target.');
        }
        const fallbackGraphView =
          transition.navigationStack.stack[transition.navigationStack.index ?? 0] ??
          getFallbackGraphView(fallbackGraphId);
        const workspaceTarget = resolveProjectWorkspaceTarget({
          fallbackGraphView,
          project: projectInfo.project,
          restoreResourceTarget:
            targetProjectHasOpenTab &&
            projectInfo.graphToLoad == null &&
            projectInfo.graphView == null &&
            projectInfo.openedGraph == null,
          storedTarget: storedWorkspaceTarget,
        });

        if (projectInfo.markClean) {
          setSavedProjectContentDigests((previousDigests) =>
            markProjectClean(previousDigests, {
              project: projectInfo.project,
            }),
          );
          setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, targetProjectId, false));
          setProjectDataUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, targetProjectId, false));
        }

        setProject(transition.project);
        setNavigationStack(transition.navigationStack);
        cleanupNodeAtomFamilies(transition.cleanupNodeIds);
        setIsReadOnlyGraph(false);
        setHistoricalGraph(null);
        setWorkspaceTarget({ projectId: targetProjectId, target: workspaceTarget });
        setGraph(transition.graph);
        const persistedCanvasPositionsByGraph = resolvePersistedCanvasPositionsForLegacyCache({
          project: projectInfo.project,
          persistedProjectEditorState,
        });
        if (Object.keys(persistedCanvasPositionsByGraph).length > 0) {
          setLastSavedPositions((previousPositionsByGraph) => ({
            ...previousPositionsByGraph,
            ...persistedCanvasPositionsByGraph,
          }));
        }

        if (transition.viewport.type === 'saved') {
          setPosition(transition.viewport.position);
        } else if (transition.viewport.type === 'center') {
          centerViewOnGraph(transition.graph);
        } else {
          setPosition({ x: 0, y: 0, zoom: 1 });
        }
        const targetProjectExecutionSnapshot = store.get(projectExecutionSnapshotsState)[targetProjectId];
        restoreProjectExecutionSnapshot(
          targetProjectId === currentProjectId
            ? currentProjectExecutionSnapshot ?? targetProjectExecutionSnapshot
            : targetProjectExecutionSnapshot,
        );
        applyProjectExecutorMode(projectInfo.executorMode, { projectId: targetProjectId });
        await applyStaticData(projectInfo.data);
        setLoadedProject(transition.loadedProject);
        setTrivetState(createDefaultTrivetState(projectInfo.testSuites ?? []));
        return true;
      } catch (err) {
        hostCallbacks.onOpenError?.({
          error: err,
          operation: 'loadProject',
          path: projectInfo.fsPath,
          projectId: projectInfo.project.metadata.id,
          openedGraph: projectInfo.openedGraph,
        });
        handleError(err, 'Failed to load project', {
          metadata: {
            currentGraphId: currentGraph.metadata?.id,
            fsPath: projectInfo.fsPath,
            openedGraph: projectInfo.openedGraph,
            projectId: projectInfo.project.metadata.id,
          },
        });
        return false;
      }
    },

    switchGraph(
      savedGraph: typeof currentGraph,
      options: { graphView?: GraphViewContext; pushHistory?: boolean } = {},
    ) {
      persistCurrentGraphWorkspace();

      const transition = createGraphSwitchTransition({
        currentGraph,
        graphToLoad: savedGraph,
        lastSavedPositions: resolveCanvasPositionsForProject({
          project,
          persistedProjectEditorState: projectEditorStateByProjectId[project.metadata.id],
          legacyCanvasPositionsByGraph: lastSavedPositions,
        }),
        nextGraphView: options.graphView,
        previousNavigationStack: graphNavigationStack,
        pushHistory: options.pushHistory ?? true,
      });

      if (transition.cleanupNodeIds.length > 0) {
        cleanupNodeAtomFamilies(transition.cleanupNodeIds);
      }

      setGraph(transition.graph);
      setSelectedNodes(transition.selectedNodes);
      setIsReadOnlyGraph(false);
      setHistoricalGraph(null);
      const nextGraphId = transition.graph.metadata?.id;
      if (nextGraphId) {
        const graphView =
          options.graphView ??
          transition.navigationStack?.stack[transition.navigationStack.index ?? 0] ??
          getFallbackGraphView(nextGraphId);
        setWorkspaceTarget({
          projectId: project.metadata.id,
          target: createGraphWorkspaceTarget(graphView),
        });
      }

      if (transition.navigationStack) {
        setNavigationStack(transition.navigationStack);
      }

      if (transition.viewport.type === 'saved') {
        setPosition(transition.viewport.position);
      } else if (transition.viewport.type === 'center') {
        centerViewOnGraph(savedGraph);
      } else {
        setPosition({ x: 0, y: 0, zoom: 1 });
      }
    },

    switchToNodeLibrary(
      options: { selectedNodeIds?: readonly NodeId[]; editingPrefabId?: NodePrefabId | undefined } = {},
    ) {
      const { latestProject } = persistCurrentGraphWorkspace();

      setSelectedNodes([...(options.selectedNodeIds ?? [])]);
      setIsReadOnlyGraph(false);
      setHistoricalGraph(null);
      setWorkspaceTarget({
        projectId: latestProject.metadata.id,
        target: { editingPrefabId: options.editingPrefabId, type: 'nodeLibrary' },
      });
    },

    switchToUiGraph(uiGraphId: UiGraphId) {
      const { latestProject } = persistCurrentGraphWorkspace();

      setSelectedNodes([]);
      setIsReadOnlyGraph(false);
      setHistoricalGraph(null);
      setWorkspaceTarget({
        projectId: latestProject.metadata.id,
        target: { type: 'uiGraph', uiGraphId },
      });
    },

    buildProjectForSave() {
      const savedGraph = saveCurrentGraph();
      const projectToPersist = mergeCurrentGraphIntoProject(store.get(projectState), savedGraph);
      return withDerivedProjectPluginSpecs(projectToPersist, {
        appPluginStates: store.get(pluginsState),
        currentGraph: savedGraph,
        registry: store.get(projectNodeRegistryState),
      });
    },

    async saveProject(options: { forceSaveAs?: boolean } = {}) {
      const latestProject = store.get(projectState);
      const latestLoadedProject = store.get(loadedProjectState);
      const latestTestSuites = store.get(trivetState).testSuites;
      const savedGraph = saveCurrentGraph();
      const projectToPersist = withDerivedProjectPluginSpecs(mergeCurrentGraphIntoProject(latestProject, savedGraph), {
        appPluginStates: store.get(pluginsState),
        currentGraph: savedGraph,
        registry: store.get(projectNodeRegistryState),
      });
      const canSaveInPlace = canSaveProjectDataNoPrompt(ioProvider, latestLoadedProject.path);
      const shouldUseSaveAs =
        options.forceSaveAs || !latestLoadedProject.loaded || !latestLoadedProject.path || !canSaveInPlace;

      let saving: ToastId | undefined;
      let savedPath: string | null = null;
      const savingTimeout = setTimeout(() => {
        saving = toast.info('Saving project');
      }, 500);

      try {
        setProject(projectToPersist);
        persistCurrentProjectEditorSnapshot({
          project: projectToPersist,
        });
        await flushHybridStorageGroup('graph');
        await flushHybridStorageGroup('project');

        if (shouldUseSaveAs) {
          const filePath = await ioProvider.saveProjectData(projectToPersist, { testSuites: latestTestSuites });

          if (filePath) {
            savedPath = filePath;
            setLoadedProject({ loaded: true, path: filePath });
            setOpenedProjectSnapshots((snapshots) => {
              const nextSnapshots = { ...snapshots };
              delete nextSnapshots[projectToPersist.metadata.id];
              return nextSnapshots;
            });
            setProjects((prev) => addOpenedProject(prev, projectToPersist, { fsPath: filePath }));
            await flushHybridStorageGroup('graph');
            await flushHybridStorageGroup('project');
            toast.success('Project saved');
          }
        } else {
          const projectPath = latestLoadedProject.path!;
          await ioProvider.saveProjectDataNoPrompt(projectToPersist, { testSuites: latestTestSuites }, projectPath);
          savedPath = projectPath;
          setLoadedProject({ loaded: true, path: projectPath });
          setOpenedProjectSnapshots((snapshots) => {
            const nextSnapshots = { ...snapshots };
            delete nextSnapshots[projectToPersist.metadata.id];
            return nextSnapshots;
          });
          await flushHybridStorageGroup('graph');
          await flushHybridStorageGroup('project');
          toast.success('Project saved');
        }

        if (savedPath) {
          setSavedProjectContentDigests((previousDigests) =>
            markProjectClean(previousDigests, {
              project: projectToPersist,
            }),
          );
          setProjectUnsavedChanges((previousFlags) =>
            markProjectDirtyFlag(previousFlags, projectToPersist.metadata.id, false),
          );
          setProjectDataUnsavedChanges((previousFlags) =>
            markProjectDirtyFlag(previousFlags, projectToPersist.metadata.id, false),
          );
          hostCallbacks.onProjectSaved?.({
            project: projectToPersist,
            path: savedPath,
            saveAs: shouldUseSaveAs,
          });
        }
      } catch (err) {
        handleError(err, 'Failed to save project', {
          metadata: {
            forceSaveAs: options.forceSaveAs ?? false,
            projectId: projectToPersist.metadata.id,
            projectPath: latestLoadedProject.path,
            usedSaveAs: shouldUseSaveAs,
          },
        });
      } finally {
        clearTimeout(savingTimeout);
        if (saving != null) {
          toast.dismiss(saving);
        }
      }
    },
  };
}
