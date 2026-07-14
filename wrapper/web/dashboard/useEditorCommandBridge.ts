import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';

import type { RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import { loadedRecordingState } from '../../../rivet/packages/app/src/state/execution';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  type OpenedProjectsInfo,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import {
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
} from '../../shared/editor-bridge';
import {
  handleCompareOpenProjectCommand,
  handleOpenPublishedPreviewCommand,
  handleOpenRecordingCommand,
} from './editorDetachedProjectCommands';
import type {
  EditorCommandBridgeContext,
  LoadedProjectInfo,
  SerializedEditorCommand,
} from './editorCommandBridgeContext';
import {
  handleDeleteWorkflowProjectCommand,
  handleWorkflowPathsMovedCommand,
} from './editorProjectLifecycleCommands';
import {
  handleOpenProjectCommand,
  handleRefreshOpenProjectCommand,
} from './editorProjectOpenCommands';
import {
  replayEditorDuplicateShortcut,
  replayEditorFindShortcut,
} from './useEditorBridgeInteractions';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import type { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import type { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';

export function useEditorCommandBridge({
  currentProject,
  loadedProject,
  openProject,
  preview,
  projects,
  recording,
  saveCurrentProject,
  workspaceHost,
}: {
  currentProject: Project;
  loadedProject: LoadedProjectInfo;
  openProject: ReturnType<typeof useOpenWorkflowProject>;
  preview: ReturnType<typeof usePreviewProjectLifecycle>;
  projects: OpenedProjectsInfo;
  recording: ReturnType<typeof useWorkflowRecordingBridge>;
  saveCurrentProject: () => Promise<void>;
  workspaceHost: RivetWorkspaceHost;
}) {
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const projectsRef = useRef(projects);
  const loadedProjectRef = useRef(loadedProject);
  const currentProjectRef = useRef(currentProject);
  const workspaceRef = useRef(workspaceHost);
  const openProjectRef = useRef(openProject);
  const saveCurrentProjectRef = useRef(saveCurrentProject);
  const serializedCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const openedProjectPathAliasesRef = useRef(new Map<string, ProjectId>());

  projectsRef.current = projects;
  loadedProjectRef.current = loadedProject;
  currentProjectRef.current = currentProject;
  workspaceRef.current = workspaceHost;
  openProjectRef.current = openProject;
  saveCurrentProjectRef.current = saveCurrentProject;

  useEffect(() => {
    const context: EditorCommandBridgeContext = {
      clearLoadedRecording: () => setLoadedRecording(null),
      getCurrentProject: () => currentProjectRef.current,
      getLoadedProject: () => loadedProjectRef.current,
      getOpenProject: () => openProjectRef.current,
      getProjects: () => projectsRef.current,
      getWorkspace: () => workspaceRef.current,
      markLoadedProjectClosed: () => setLoadedProject({ loaded: false, path: '' }),
      openedProjectPathAliases: openedProjectPathAliasesRef.current,
      preview,
      recording,
      removeOpenedProjectSnapshot: (projectId) => {
        setOpenedProjectSnapshots((snapshots) => {
          if (!snapshots[projectId]) {
            return snapshots;
          }
          const nextSnapshots = { ...snapshots };
          delete nextSnapshots[projectId];
          return nextSnapshots;
        });
      },
    };

    const runSerializedCommand = async (command: SerializedEditorCommand): Promise<void> => {
      switch (command.type) {
        case 'open-project':
          return handleOpenProjectCommand(context, command);
        case 'refresh-open-project-from-disk':
          return handleRefreshOpenProjectCommand(context, command);
        case 'open-recording':
          return handleOpenRecordingCommand(context, command);
        case 'open-published-version-preview':
          return handleOpenPublishedPreviewCommand(context, command);
        case 'compare-open-project-with':
          return handleCompareOpenProjectCommand(context, command);
        case 'workflow-paths-moved':
          return handleWorkflowPathsMovedCommand(context, command);
      }
    };

    const enqueueSerializedCommand = (command: SerializedEditorCommand): void => {
      const queued = serializedCommandQueueRef.current
        .catch(() => undefined)
        .then(() => runSerializedCommand(command));
      serializedCommandQueueRef.current = queued.catch((error) => {
        console.error('Failed to process hosted editor command:', error);
      });
    };

    const handler = async (event: MessageEvent) => {
      if (!isValidBridgeOrigin(event, window.parent) || !isDashboardToEditorCommand(event.data)) {
        return;
      }

      switch (event.data.type) {
        case 'save-project':
          await saveCurrentProjectRef.current();
          break;
        case 'trigger-editor-find-shortcut':
          replayEditorFindShortcut(event.data.modifier);
          break;
        case 'trigger-editor-duplicate-shortcut':
          replayEditorDuplicateShortcut(event.data.modifier);
          break;
        case 'delete-workflow-project':
          await handleDeleteWorkflowProjectCommand(context, event.data);
          break;
        case 'open-project':
        case 'open-recording':
        case 'open-published-version-preview':
        case 'refresh-open-project-from-disk':
        case 'compare-open-project-with':
        case 'workflow-paths-moved':
          enqueueSerializedCommand(event.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    preview,
    recording,
    setLoadedProject,
    setLoadedRecording,
    setOpenedProjectSnapshots,
  ]);
}
