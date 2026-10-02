import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { isEqual } from 'lodash-es';
import {
  type DataId,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type Project,
  type ProjectId,
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
import { projectEditorStateByProjectIdState } from '../state/projectEditor.js';
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
import { evaluationsState, resetEvaluationsForProjectLoad } from '../state/evaluations.js';
import { useCenterViewOnGraph } from './useCenterViewOnGraph.js';
import { useSaveCurrentGraph } from './useSaveCurrentGraph.js';
import type { GraphViewContext } from '../domain/graphEditing/navigationActions.js';
import {
  createGraphSwitchTransition,
  createProjectLoadTransition,
  mergeCurrentGraphIntoProject,
  shouldPersistProjectBeforeLoad,
} from '../utils/workspaceTransitions.js';
import { handleError } from '../utils/errorHandling.js';
import { useStaticDataDatabase } from './useStaticDataDatabase.js';
import { resolveOpenedProjectSavePath, updateOpenedProjectMetadata } from '../utils/openedProjects.js';
import { resolveCanvasPositionsForProject, resolveProjectEditorRestoreTarget } from '../utils/projectEditorState.js';
import { flushHybridStorageGroup } from '../state/storage.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { canSaveProjectDataNoPrompt } from '../utils/projectSaveCapabilities.js';
import { pluginsState, projectNodeRegistryState } from '../state/plugins.js';
import { withDerivedProjectPluginSpecs } from '../utils/pluginUsage.js';
import { useProjectExecutionSnapshots } from './useProjectExecutionSnapshots.js';
import { getProjectContentDigest, markProjectClean, markProjectDirtyFlag } from '../utils/projectUnsavedChanges.js';
import { useApplyProjectExecutorMode } from './useProjectExecutorMode.js';
import type { ProjectExecutorMode } from '../utils/projectExecutorMode.js';
import { projectWorkspaceTargetsState, setProjectWorkspaceTargetState } from '../state/workspaceTarget.js';
import {
  createGraphWorkspaceTarget,
  getFallbackGraphView,
  getProjectWorkspaceLeavePolicy,
  resolveProjectWorkspaceTarget,
} from '../domain/workspace/projectWorkspaceTarget.js';
import { clearUiGraphPreviewSessions } from '../components/rivetWebApps/uiGraphPreviewSession.js';
import { selectedOpeningProjectTabIdState } from '../state/openingProjectTabs.js';
import { runDeduplicatedProjectSave } from '../utils/projectSaveCoordinator.js';
import { runStaticDataCacheOperation } from '../utils/staticDataCacheCoordinator.js';

export function useWorkspaceTransitions() {
  const ioProvider = useIOProvider();
  const hostCallbacks = useRivetAppHostCallbacks();
  const store = useStore();
  const database = useStaticDataDatabase();
  const [currentGraph, setGraph] = useAtom(graphState);
  const [project, setProject] = useAtom(projectState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const setProjectData = useSetAtom(projectDataState);
  const setEvaluationsState = useSetAtom(evaluationsState);
  const setNavigationStack = useSetAtom(graphNavigationStackState);
  const setIsReadOnlyGraph = useSetAtom(isReadOnlyGraphState);
  const setHistoricalGraph = useSetAtom(historicalGraphState);
  const setSelectedNodes = useSetAtom(selectedNodesState);
  const setPosition = useSetAtom(canvasPositionState);
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
  const evaluations = useAtomValue(evaluationsState);
  const { persistOpenedProjectSnapshot, persistCurrentProjectEditorSnapshot } = useCurrentProjectEditorSnapshot();

  const persistCurrentGraphWorkspace = () => {
    const project = store.get(projectState);
    const currentGraph = store.get(graphState);
    const currentTarget = store.get(projectWorkspaceTargetsState)[project.metadata.id];
    const leavePolicy = getProjectWorkspaceLeavePolicy(currentTarget);
    const currentGraphId = currentGraph.metadata?.id;

    if (project.metadata.id && leavePolicy.persistGraphViewport) {
      persistCurrentProjectEditorSnapshot({ currentGraphId });
    }

    const savedCurrentGraph = leavePolicy.commitLiveGraph ? saveCurrentGraph() : undefined;
    const latestProject = store.get(projectState);

    if (latestProject.metadata.id && savedCurrentGraph) {
      persistOpenedProjectSnapshot({ project: latestProject, graph: savedCurrentGraph });
    }

    return { latestProject, savedCurrentGraph };
  };

  async function applyStaticData(data: Project['data'] | undefined) {
    // Undefined is an empty payload here, not an invitation for the startup
    // cache reader to merge the previous project's database back into this one.
    setProjectData(data ?? {});
    const projectId = store.get(projectState).metadata.id;
    await runStaticDataCacheOperation(database, async () => {
      if (store.get(projectState).metadata.id !== projectId) return;
      try {
        await database.clear();
        // Edits may arrive while clearing. Hydrate the latest live payload, not
        // the older open input; queued edits then follow this operation.
        if (store.get(projectState).metadata.id !== projectId) return;
        for (const [id, value] of Object.entries(store.get(projectDataState) ?? {})) {
          await database.insert(id as DataId, value);
        }
      } catch (error) {
        // A failed clear must not be followed by inserts into another tab's
        // residual cache. Live project data remains available for saving.
        handleError(error, 'Failed to hydrate static data cache while loading project', {
          metadata: { projectId, projectPath: store.get(loadedProjectState).path },
          toastError: false,
        });
      }
    });
  }

  return {
    async loadProject(projectInfo: {
      project: Omit<Project, 'data'>;
      data?: Project['data'];
      fsPath?: string | null;
      openedGraph?: GraphId;
      evaluationData?: typeof evaluations.data;
      evaluationDatasets?: typeof evaluations.datasets;
      graphToLoad?: typeof currentGraph;
      graphView?: GraphViewContext;
      markClean?: boolean;
      executorMode?: ProjectExecutorMode;
      /** Register the tab/snapshot at the synchronous commit, before cache IO. */
      onLoaded?: () => void;
    }): Promise<boolean> {
      // Loading can follow asynchronous IO or a queued tab activation. React's
      // render closure may still describe the project that was active earlier.
      const project = store.get(projectState);
      const currentGraph = store.get(graphState);
      const legacyCanvasPositionsByGraph = store.get(lastCanvasPositionByGraphState);
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
            ? currentProjectEditorSnapshot ?? store.get(projectEditorStateByProjectIdState)[targetProjectId]
            : store.get(projectEditorStateByProjectIdState)[targetProjectId];
        const restoreTarget = resolveProjectEditorRestoreTarget({
          project: projectInfo.project,
          persistedProjectEditorState,
          explicitGraphToLoad: projectInfo.graphToLoad,
          explicitGraphView: projectInfo.graphView,
          openedGraphId: projectInfo.openedGraph,
          legacyCanvasPositionsByGraph,
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
        // Project identity and its path/Evaluation owner must change together.
        // Hydration yields to events such as a remote move; a delayed path
        // assignment would overwrite that newer path with the old load input.
        setLoadedProject(transition.loadedProject);
        setEvaluationsState((current) =>
          resetEvaluationsForProjectLoad(
            current,
            projectInfo.evaluationData,
            projectInfo.evaluationDatasets,
            targetProjectId,
          ),
        );
        if (!targetProjectHasOpenTab) {
          clearUiGraphPreviewSessions(targetProjectId);
        }
        projectInfo.onLoaded?.();
        // Payload authority is synchronous; the derived cache must not hold
        // later tab selections hostage to IndexedDB or a custom provider.
        void applyStaticData(projectInfo.data).catch((error) => {
          handleError(error, 'Failed to hydrate project cache', { toastError: false });
        });
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
      const project = store.get(projectState);
      const currentGraph = store.get(graphState);
      const graphNavigationStack = store.get(graphNavigationStackState);
      const legacyCanvasPositionsByGraph = store.get(lastCanvasPositionByGraphState);
      persistCurrentGraphWorkspace();

      const transition = createGraphSwitchTransition({
        currentGraph,
        graphToLoad: savedGraph,
        lastSavedPositions: resolveCanvasPositionsForProject({
          project,
          persistedProjectEditorState: store.get(projectEditorStateByProjectIdState)[project.metadata.id],
          legacyCanvasPositionsByGraph,
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

    saveProject(options: { forceSaveAs?: boolean } = {}): Promise<boolean> {
      const projectId = store.get(projectState).metadata.id as ProjectId | undefined;
      if (!projectId) {
        return Promise.resolve(false);
      }

      return runDeduplicatedProjectSave(store, projectId, async () => {
        const activeProjectIsOpen = store.get(projectsState).openedProjects[projectId] != null;
        const openingProjectTabSelected = store.get(selectedOpeningProjectTabIdState) != null;
        if (!activeProjectIsOpen || openingProjectTabSelected) {
          return false;
        }

        let saving: ToastId | undefined;
        let savingTimeout: ReturnType<typeof setTimeout> | undefined;
        let projectPath: string | null | undefined;
        let shouldUseSaveAs = options.forceSaveAs ?? false;

        try {
          const latestProject = store.get(projectState);
          if (latestProject.metadata.id !== projectId) {
            return false;
          }
          const latestLoadedProject = store.get(loadedProjectState);
          const projectsAtSaveStart = store.get(projectsState);
          const openedProjectPathAtSaveStart = projectsAtSaveStart.openedProjects[projectId]?.fsPath ?? null;
          const loadedProjectPathAtSaveStart = latestLoadedProject.path;
          const savePath = resolveOpenedProjectSavePath(projectsAtSaveStart, projectId, latestLoadedProject.path);
          projectPath = savePath;
          const savedGraph = saveCurrentGraph();
          const projectToPersist = withDerivedProjectPluginSpecs(
            mergeCurrentGraphIntoProject(latestProject, savedGraph),
            {
              appPluginStates: store.get(pluginsState),
              currentGraph: savedGraph,
              registry: store.get(projectNodeRegistryState),
            },
          );
          const projectDataToPersist = store.get(projectDataState);
          // Capture the payload together with graph content before any await.
          // Providers serialize this snapshot, not whichever tab is active later.
          const projectFileToPersist: Project = { ...projectToPersist, data: projectDataToPersist };
          const savedProjectDigest = getProjectContentDigest({ project: projectToPersist });
          const saveInPlaceProvider = canSaveProjectDataNoPrompt(ioProvider, savePath) ? ioProvider : undefined;
          shouldUseSaveAs = options.forceSaveAs || !latestLoadedProject.loaded || !savePath || !saveInPlaceProvider;

          let savedPath: string | null = null;
          savingTimeout = setTimeout(() => {
            saving = toast.info('Saving project');
          }, 500);

          setProject(projectToPersist);
          persistCurrentProjectEditorSnapshot({
            project: projectToPersist,
          });
          // Legacy evaluation resources may be about to disappear from the
          // project file/sidecar. Commit their one-way migration before any
          // project save can replace those legacy files.
          await flushHybridStorageGroup('evaluation-library');

          if (shouldUseSaveAs) {
            const filePath = await ioProvider.saveProjectData(projectFileToPersist);

            if (filePath) {
              savedPath = filePath;
            }
          } else {
            if (!saveInPlaceProvider || !savePath) {
              throw new Error('The active project cannot be saved in place.');
            }
            const canonicalSavePath = await saveInPlaceProvider.saveProjectDataNoPrompt(projectFileToPersist, savePath);
            savedPath = canonicalSavePath ?? savePath;
          }

          if (!savedPath) {
            return false;
          }
          if (ioProvider.projectSaveConfirmation === 'download-only') {
            toast.info('Project download requested. Confirm the downloaded file; edits remain marked unsaved.');
            return false;
          }

          const projectsAfterSave = store.get(projectsState);
          const openedProjectAfterSave = projectsAfterSave.openedProjects[projectId];
          const projectIsStillOpen = openedProjectAfterSave != null;
          const activeProjectAfterSave = store.get(projectState);
          const projectIsStillActive = activeProjectAfterSave.metadata.id === projectId;
          const loadedProjectAfterSave = store.get(loadedProjectState);
          const pathMatchesSaveBinding = (
            currentPath: string | null | undefined,
            originalPath: string | null | undefined,
          ) => currentPath === originalPath || currentPath === savedPath;
          const pathChangedWhileSaving =
            projectIsStillOpen &&
            (!pathMatchesSaveBinding(openedProjectAfterSave.fsPath, openedProjectPathAtSaveStart) ||
              (projectIsStillActive &&
                !pathMatchesSaveBinding(loadedProjectAfterSave.path, loadedProjectPathAtSaveStart)));

          const latestSnapshot = store.get(openedProjectSnapshotsState)[projectId];
          const latestProjectToCompare = projectIsStillActive
            ? mergeCurrentGraphIntoProject(activeProjectAfterSave, store.get(graphState))
            : latestSnapshot?.project;
          const latestProjectDataToCompare = projectIsStillActive ? store.get(projectDataState) : latestSnapshot?.data;
          const hasNewerProjectChanges =
            projectIsStillOpen &&
            (pathChangedWhileSaving ||
              latestProjectToCompare == null ||
              getProjectContentDigest({ project: latestProjectToCompare }) !== savedProjectDigest);
          const hasNewerProjectDataChanges =
            projectIsStillOpen &&
            (latestProjectToCompare == null || !isEqual(latestProjectDataToCompare, projectDataToPersist));
          const hasNewerUnsavedChanges = hasNewerProjectChanges || hasNewerProjectDataChanges;

          if (projectIsStillOpen) {
            setProjects((previousProjects) =>
              !pathMatchesSaveBinding(previousProjects.openedProjects[projectId]?.fsPath, openedProjectPathAtSaveStart)
                ? previousProjects
                : updateOpenedProjectMetadata(previousProjects, projectId, null, { fsPath: savedPath }),
            );

            if (projectIsStillActive) {
              setLoadedProject((previousLoadedProject) =>
                !pathMatchesSaveBinding(previousLoadedProject.path, loadedProjectPathAtSaveStart)
                  ? previousLoadedProject
                  : { loaded: true, path: savedPath },
              );
            }

            setOpenedProjectSnapshots((snapshots) => {
              const snapshot = snapshots[projectId];
              if (
                !snapshot ||
                !isEqual(snapshot.project, projectToPersist) ||
                !isEqual(snapshot.data, projectDataToPersist)
              ) {
                return snapshots;
              }

              const nextSnapshots = { ...snapshots };
              delete nextSnapshots[projectId];
              return nextSnapshots;
            });

            setSavedProjectContentDigests((previousDigests) =>
              markProjectClean(previousDigests, {
                project: projectToPersist,
              }),
            );
            setProjectUnsavedChanges((previousFlags) =>
              markProjectDirtyFlag(previousFlags, projectId, hasNewerProjectChanges),
            );
            setProjectDataUnsavedChanges((previousFlags) =>
              markProjectDirtyFlag(previousFlags, projectId, hasNewerProjectDataChanges),
            );
          }

          if (hasNewerUnsavedChanges) {
            toast.info('Saved an earlier version; newer changes remain unsaved.');
          } else {
            toast.success('Project saved');
          }

          try {
            void Promise.resolve(
              hostCallbacks.onProjectSaved?.({
                project: projectToPersist,
                hasNewerUnsavedChanges,
                pathChangedWhileSaving,
                path: savedPath,
                saveAs: shouldUseSaveAs,
              }),
            ).catch((callbackError) => {
              handleError(callbackError, 'Hosted onProjectSaved callback failed', {
                metadata: { projectId, projectPath: savedPath },
                toastError: false,
              });
            });
          } catch (callbackError) {
            handleError(callbackError, 'Hosted onProjectSaved callback failed', {
              metadata: { projectId, projectPath: savedPath },
              toastError: false,
            });
          }

          // The actual file is already saved. A browser checkpoint failure is
          // a separate recovery problem, never a false project-save failure.
          void flushHybridStorageGroup('project').catch((error) => {
            handleError(error, 'Project saved, but browser recovery is unavailable.', { toastError: false });
          });

          return true;
        } catch (err) {
          handleError(err, 'Failed to save project', {
            metadata: {
              forceSaveAs: options.forceSaveAs ?? false,
              projectId,
              projectPath,
              usedSaveAs: shouldUseSaveAs,
            },
          });
          return false;
        } finally {
          if (savingTimeout != null) {
            clearTimeout(savingTimeout);
          }
          if (saving != null) {
            toast.dismiss(saving);
          }
        }
      });
    },
  };
}
