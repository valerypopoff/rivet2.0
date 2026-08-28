import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import { type FC, useCallback, useEffect, useMemo } from 'react';

import { useExecutorSessionRuntime, type RivetWorkspaceHost } from '../../app/src/host';
import { graphRunningState } from '../../app/src/state/dataFlow';
import {
  executorSessionRevisionState,
  loadedRecordingState,
} from '../../app/src/state/execution';
import { openOrFocusGraphSearchState, searchingGraphState } from '../../app/src/state/graphBuilder';
import {
  loadedProjectState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
} from '../../app/src/state/savedGraphs';
import { selectedExecutorState } from '../../app/src/state/settings';
import { overlayOpenState } from '../../app/src/state/ui';
import { postMessageToDashboard } from '../../studio-server-shared/editor-bridge';
import { useEditorBridgeInteractions } from './useEditorBridgeInteractions';
import { useEditorCommandBridge } from './useEditorCommandBridge';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';

type EditorMessageBridgeProps = {
  savedProjectSignal: SavedProjectSignal | null;
  workspaceHost: RivetWorkspaceHost;
};

export type SavedProjectSignal = {
  projectId: ProjectId;
};

export const EditorMessageBridge: FC<EditorMessageBridgeProps> = ({ savedProjectSignal, workspaceHost }) => {
  const openProject = useOpenWorkflowProject(workspaceHost);
  const executorSessionRuntime = useExecutorSessionRuntime();
  const projects = useAtomValue(projectsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentProject = useAtomValue(projectState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const projectDataUnsavedChanges = useAtomValue(projectDataUnsavedChangesState);
  const graphRunning = useAtomValue(graphRunningState);
  useAtomValue(executorSessionRevisionState);
  const openOverlay = useAtomValue(overlayOpenState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const setSelectedExecutor = useSetAtom(selectedExecutorState);
  const setSearching = useSetAtom(searchingGraphState);
  const openedProjectPaths = useMemo(() => projects.openedProjectsSortedIds
    .map((projectId) => projects.openedProjects[projectId]?.fsPath)
    .filter((projectPath): projectPath is string => Boolean(projectPath)), [projects]);
  const preview = usePreviewProjectLifecycle({
    currentProjectId: currentProject.metadata.id as ProjectId | undefined,
    executorTargetType: executorSessionRuntime.getRuntimeState().target?.type,
    graphRunning,
    projectDataUnsavedChanges,
    projectUnsavedChanges,
    workspaceHost,
  });
  const selectBrowserExecutor = useCallback(() => setSelectedExecutor('browser'), [setSelectedExecutor]);
  const recording = useWorkflowRecordingBridge({
    currentProjectId: currentProject.metadata.id as ProjectId | undefined,
    loadedProjectPath: loadedProject.path,
    openedProjectPaths,
    selectBrowserExecutor,
    setLoadedRecording,
  });
  const openGraphSearch = useCallback(() => {
    setSearching(openOrFocusGraphSearchState);
  }, [setSearching]);

  useEditorBridgeInteractions({
    canOpenGraphSearch: openOverlay === undefined,
    onOpenGraphSearch: openGraphSearch,
  });
  useEditorCommandBridge({
    currentProject,
    loadedProject,
    openProject,
    preview,
    projects,
    recording,
    workspaceHost,
  });

  useEffect(() => {
    if (savedProjectSignal) {
      preview.promotePreviewProjectById(savedProjectSignal.projectId);
    }
  }, [preview.promotePreviewProjectById, savedProjectSignal]);

  useEffect(() => {
    postMessageToDashboard({ type: 'editor-ready' });
  }, []);

  useEffect(() => {
    const projectId = currentProject.metadata.id as ProjectId | undefined;
    const path = loadedProject.path ?? '';
    postMessageToDashboard({
      type: 'active-project-unsaved-changes-changed',
      path,
      hasUnsavedChanges: Boolean(
        projectId &&
        path &&
        (projectUnsavedChanges[projectId] === true || projectDataUnsavedChanges[projectId] === true),
      ),
    });
  }, [
    currentProject.metadata.id,
    loadedProject.path,
    projectDataUnsavedChanges,
    projectUnsavedChanges,
  ]);

  return null;
};
