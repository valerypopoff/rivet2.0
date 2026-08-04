import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import { type FC, useCallback, useEffect, useMemo, useRef } from 'react';

import { useExecutorSessionRuntime, type RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import { graphRunningState } from '../../../rivet/packages/app/src/state/dataFlow';
import {
  executorSessionRevisionState,
  loadedRecordingState,
} from '../../../rivet/packages/app/src/state/execution';
import { openOrFocusGraphSearchState, searchingGraphState } from '../../../rivet/packages/app/src/state/graphBuilder';
import {
  loadedProjectState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { selectedExecutorState } from '../../../rivet/packages/app/src/state/settings';
import { overlayOpenState } from '../../../rivet/packages/app/src/state/ui';
import { postMessageToDashboard } from '../../shared/editor-bridge';
import { useEditorBridgeInteractions } from './useEditorBridgeInteractions';
import { useEditorCommandBridge } from './useEditorCommandBridge';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';

type EditorMessageBridgeProps = {
  workspaceHost: RivetWorkspaceHost;
};

export const EditorMessageBridge: FC<EditorMessageBridgeProps> = ({ workspaceHost }) => {
  const openProject = useOpenWorkflowProject(workspaceHost);
  const { saveProject } = useSaveProject();
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
  const loadedProjectRef = useRef(loadedProject);
  const saveProjectRef = useRef(saveProject);
  loadedProjectRef.current = loadedProject;
  saveProjectRef.current = saveProject;

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
  const saveCurrentProject = useCallback(async () => {
    await saveProjectRef.current();
    preview.promotePreviewProjectByPath(loadedProjectRef.current.path);
  }, [preview.promotePreviewProjectByPath]);
  const openGraphSearch = useCallback(() => {
    setSearching(openOrFocusGraphSearchState);
  }, [setSearching]);

  useEditorBridgeInteractions({
    canOpenGraphSearch: openOverlay === undefined,
    onOpenGraphSearch: openGraphSearch,
    onSave: saveCurrentProject,
  });
  useEditorCommandBridge({
    currentProject,
    loadedProject,
    openProject,
    preview,
    projects,
    recording,
    saveCurrentProject,
    workspaceHost,
  });

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
