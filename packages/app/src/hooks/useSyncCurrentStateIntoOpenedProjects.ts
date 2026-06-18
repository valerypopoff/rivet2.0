import { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { graphState } from '../state/graph';
import {
  loadedProjectState,
  projectDataState,
  projectState,
  projectsState,
  projectUnsavedChangesState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs';
import { selectedExecutorState } from '../state/settings.js';
import { addOpenedProject, resolveSyncedOpenedProjectFsPathOptions } from '../utils/openedProjects.js';
import { useExecutorSessionState } from './useExecutorSession.js';
import { projectExecutorModesEqual, resolveCurrentProjectExecutorMode } from '../utils/projectExecutorMode.js';
import {
  buildCurrentProjectContentSnapshot,
  getProjectContentDigest,
  markProjectClean,
  markProjectDirtyFlag,
} from '../utils/projectUnsavedChanges.js';

export function useSyncCurrentStateIntoOpenedProjects({ enabled = true }: { enabled?: boolean } = {}) {
  const setProjects = useSetAtom(projectsState);
  const currentProject = useAtomValue(projectState);
  const currentProjectData = useAtomValue(projectDataState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentGraph = useAtomValue(graphState);
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const executorSession = useExecutorSessionState();
  const executorTargetType = executorSession.target?.type;
  const executorTargetUrl = executorSession.target?.url;
  const executorTarget = useMemo(
    () =>
      executorTargetType != null && executorTargetUrl != null
        ? {
            type: executorTargetType,
            url: executorTargetUrl,
          }
        : null,
    [executorTargetType, executorTargetUrl],
  );
  const savedProjectContentDigests = useAtomValue(savedProjectContentDigestsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const currentExecutorMode = useMemo(
    () =>
      resolveCurrentProjectExecutorMode({
        selectedExecutor,
        target: executorTarget,
      }),
    [executorTarget, selectedExecutor],
  );
  const currentProjectWithData = useMemo(
    () => ({
      ...currentProject,
      data: currentProjectData,
    }),
    [currentProject, currentProjectData],
  );

  // Make sure current opened project is in opened projects
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!currentProject.metadata.id) {
      return;
    }

    setProjects((previousProjects) => {
      const existingProject = previousProjects.openedProjects[currentProject.metadata.id];
      const nextOpenedGraph = currentGraph?.metadata?.id;
      const fsPathOptions = resolveSyncedOpenedProjectFsPathOptions(
        previousProjects,
        currentProject.metadata.id,
        loadedProject.path,
      );
      const nextProjects = addOpenedProject(previousProjects, currentProjectWithData, {
        ...fsPathOptions,
        ...(nextOpenedGraph ? { openedGraph: nextOpenedGraph } : {}),
        executorMode: currentExecutorMode,
      });
      const nextProject = nextProjects.openedProjects[currentProject.metadata.id];

      if (
        existingProject?.title === currentProject.metadata.title &&
        existingProject?.fsPath === nextProject?.fsPath &&
        existingProject?.openedGraph === nextOpenedGraph &&
        projectExecutorModesEqual(existingProject?.executorMode, currentExecutorMode) &&
        previousProjects.openedProjectsSortedIds.includes(currentProject.metadata.id)
      ) {
        return previousProjects;
      }

      return nextProject ? nextProjects : previousProjects;
    });
  }, [
    currentExecutorMode,
    currentGraph?.metadata?.id,
    currentProject,
    currentProjectWithData,
    enabled,
    loadedProject.path,
    setProjects,
  ]);

  useEffect(() => {
    if (!enabled || !currentProject.metadata.id || !currentGraph) {
      return;
    }

    const savedDigest = savedProjectContentDigests[currentProject.metadata.id];
    if (!savedDigest) {
      const snapshot = buildCurrentProjectContentSnapshot({
        project: currentProject,
        graph: currentGraph,
      });
      setSavedProjectContentDigests((previousDigests) => markProjectClean(previousDigests, snapshot));

      setProjectUnsavedChanges((previousFlags) => {
        return markProjectDirtyFlag(previousFlags, currentProject.metadata.id, false);
      });
      return;
    }

    const snapshot = buildCurrentProjectContentSnapshot({
      project: currentProject,
      graph: currentGraph,
    });
    const currentDigest = getProjectContentDigest(snapshot);
    const isDirty = currentDigest !== savedDigest;

    setProjectUnsavedChanges((previousFlags) => {
      return markProjectDirtyFlag(previousFlags, currentProject.metadata.id, isDirty);
    });
  }, [
    currentGraph,
    currentProject,
    enabled,
    savedProjectContentDigests,
    setSavedProjectContentDigests,
    setProjectUnsavedChanges,
  ]);
}
