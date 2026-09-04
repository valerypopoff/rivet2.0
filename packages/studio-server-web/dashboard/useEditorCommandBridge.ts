import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';

import { useIOProvider, type RivetWorkspaceHost } from '../../app/src/host';
import { loadedRecordingState } from '../../app/src/state/execution';
import {
  loadedProjectState,
  type OpenedProjectsInfo,
} from '../../app/src/state/savedGraphs';
import type { DefaultExecutor } from '../../app/src/state/settings.js';
import type { OverlayKey } from '../../app/src/state/ui.js';
import { isDashboardToEditorCommand, isValidBridgeOrigin } from '../../studio-server-shared/editor-bridge';
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
  handleReconcileWorkflowProjectBindingsCommand,
  handleResolveWorkflowProjectContentChangeCommand,
  handleWorkflowPathsMovedCommand,
} from './editorProjectLifecycleCommands';
import { handleOpenProjectCommand, handleRefreshOpenProjectCommand } from './editorProjectOpenCommands';
import {
  replayEditorDuplicateShortcut,
  replayEditorFindShortcut,
} from './useEditorBridgeInteractions';
import { shouldSkipHostedShortcutProjectSave } from './editorBridgeFocus';
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
  openOverlay,
  selectedExecutor,
  workspaceHost,
}: {
  currentProject: Project;
  loadedProject: LoadedProjectInfo;
  openProject: ReturnType<typeof useOpenWorkflowProject>;
  preview: ReturnType<typeof usePreviewProjectLifecycle>;
  projects: OpenedProjectsInfo;
  recording: ReturnType<typeof useWorkflowRecordingBridge>;
  openOverlay: OverlayKey | undefined;
  selectedExecutor: DefaultExecutor;
  workspaceHost: RivetWorkspaceHost;
}) {
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const ioProvider = useIOProvider();
  const projectsRef = useRef(projects);
  const loadedProjectRef = useRef(loadedProject);
  const currentProjectRef = useRef(currentProject);
  const openOverlayRef = useRef(openOverlay);
  const selectedExecutorRef = useRef(selectedExecutor);
  const workspaceRef = useRef(workspaceHost);
  const openProjectRef = useRef(openProject);
  const serializedCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const openedProjectPathAliasesRef = useRef(new Map<string, ProjectId>());

  projectsRef.current = projects;
  loadedProjectRef.current = loadedProject;
  currentProjectRef.current = currentProject;
  openOverlayRef.current = openOverlay;
  selectedExecutorRef.current = selectedExecutor;
  workspaceRef.current = workspaceHost;
  openProjectRef.current = openProject;

  useEffect(() => {
    const context: EditorCommandBridgeContext = {
      clearLoadedRecording: (projectId) => {
        setLoadedRecording((loadedRecording) =>
          projectId != null && loadedRecording?.projectId === projectId ? null : loadedRecording,
        );
      },
      getCurrentProject: () => currentProjectRef.current,
      getSelectedExecutor: () => selectedExecutorRef.current,
      loadProjectData: async (path) => {
        const provider = ioProvider as {
          loadProjectDataNoPrompt?: (path: string) => ReturnType<typeof ioProvider.loadProjectData>;
        };
        if (typeof provider.loadProjectDataNoPrompt !== 'function') {
          throw new Error('The active IO provider does not support reloading projects by path.');
        }
        return provider.loadProjectDataNoPrompt(path);
      },
      getLoadedProject: () => loadedProjectRef.current,
      getOpenProject: () => openProjectRef.current,
      getProjects: () => projectsRef.current,
      getWorkspace: () => workspaceRef.current,
      markLoadedProjectClosed: () => setLoadedProject({ loaded: false, path: '' }),
      openedProjectPathAliases: openedProjectPathAliasesRef.current,
      preview,
      recording,
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
        case 'reconcile-workflow-project-bindings':
          return handleReconcileWorkflowProjectBindingsCommand(context, command);
        case 'resolve-workflow-project-content-change':
          return handleResolveWorkflowProjectContentChangeCommand(context, command);
      }
    };

    const enqueueSerializedCommand = (command: SerializedEditorCommand): void => {
      const queued = serializedCommandQueueRef.current.catch(() => undefined).then(() => runSerializedCommand(command));
      serializedCommandQueueRef.current = queued.catch((error) => {
        console.error('Failed to process hosted editor command:', error);
      });
    };

    const handler = async (event: MessageEvent) => {
      if (!isValidBridgeOrigin(event, window.parent) || !isDashboardToEditorCommand(event.data)) {
        return;
      }

      switch (event.data.type) {
        case 'save-project': {
          // Evaluation definitions are independently persisted shared
          // resources. A dashboard-level shortcut must not rewrite the open
          // project while that workspace owns the interaction.
          if (shouldSkipHostedShortcutProjectSave(event.data.source, openOverlayRef.current)) {
            break;
          }
          try {
            await workspaceRef.current.saveCurrentProject();
          } catch (error) {
            console.error('Failed to save the current hosted project:', error);
          }
          break;
        }
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
        case 'reconcile-workflow-project-bindings':
        case 'resolve-workflow-project-content-change':
          enqueueSerializedCommand(event.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [preview, recording, setLoadedProject, setLoadedRecording]);
}
