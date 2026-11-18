import type { ProjectId } from '@valerypopoff/rivet2-core';
import { createEditorBundleComparison } from './editorBundleComparison';
import { getWorkflowPublishedVersionPreviewFromVirtualProjectPath } from '../../studio-server-shared/workflow-types';
import { beginDevelopmentCommand } from './developmentActivity';
import { useSetAtom, useStore } from 'jotai';
import { useEffect, useRef } from 'react';

import { useIOProvider, type RivetWorkspaceHost } from '../../app/src/host';
import { clearLoadedRecordingForPathState, rebindLoadedRecordingPathState } from '../../app/src/state/execution';
import {
  loadedProjectState,
  projectState,
  projectsState,
  projectUnsavedChangesState,
  type OpenedProjectsInfo,
} from '../../app/src/state/savedGraphs';
import type { DefaultExecutor } from '../../app/src/state/settings.js';
import type { OverlayKey } from '../../app/src/state/ui.js';
import {
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
  postMessageToDashboard,
} from '../../studio-server-shared/editor-bridge';
import {
  captureHostedProjectReconciliation,
  getHostedProjectConflictSnapshot,
  pruneHostedProjectRevisions,
  subscribeHostedProjectRevisions,
} from '../io/hostedProjectRevisionTracker';
import { isHostedVirtualProjectPath } from './openedProjectMetadata';
import {
  handleCompareOpenProjectCommand,
  handleOpenPublishedPreviewCommand,
  handleOpenRecordingCommand,
} from './editorDetachedProjectCommands';
import type { EditorCommandBridgeContext, SerializedEditorCommand } from './editorCommandBridgeContext';
import {
  handleDeleteWorkflowProjectCommand,
  handleReconcileWorkflowProjectBindingsCommand,
  handleResolveWorkflowProjectContentChangeCommand,
  handleWorkflowPathsMovedCommand,
} from './editorProjectLifecycleCommands';
import { handleOpenProjectCommand, handleRefreshOpenProjectCommand } from './editorProjectOpenCommands';
import { replayEditorDuplicateShortcut, replayEditorFindShortcut } from './useEditorBridgeInteractions';
import { shouldSkipHostedShortcutProjectSave } from './editorBridgeFocus';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import type { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import type { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';

export function useEditorCommandBridge({
  openProject,
  preview,
  projects,
  recording,
  openOverlay,
  selectedExecutor,
  workspaceHost,
}: {
  openProject: ReturnType<typeof useOpenWorkflowProject>;
  preview: ReturnType<typeof usePreviewProjectLifecycle>;
  projects: OpenedProjectsInfo;
  recording: ReturnType<typeof useWorkflowRecordingBridge>;
  openOverlay: OverlayKey | undefined;
  selectedExecutor: DefaultExecutor;
  workspaceHost: RivetWorkspaceHost;
}) {
  const setLoadedProject = useSetAtom(loadedProjectState);
  const store = useStore();
  const clearLoadedRecordingForPath = useSetAtom(clearLoadedRecordingForPathState);
  const rebindLoadedRecordingPath = useSetAtom(rebindLoadedRecordingPathState);
  const ioProvider = useIOProvider();
  const openOverlayRef = useRef(openOverlay);
  const selectedExecutorRef = useRef(selectedExecutor);
  const workspaceRef = useRef(workspaceHost);
  const openProjectRef = useRef(openProject);
  const serializedCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const openedProjectPathAliasesRef = useRef(new Map<string, ProjectId>());

  openOverlayRef.current = openOverlay;
  selectedExecutorRef.current = selectedExecutor;
  workspaceRef.current = workspaceHost;
  openProjectRef.current = openProject;

  const editableProjects = () => {
    const currentProjects = store.get(projectsState);
    return currentProjects.openedProjectsSortedIds.flatMap((projectId) => {
      const project = currentProjects.openedProjects[projectId];
      return project?.fsPath && !isHostedVirtualProjectPath(project.fsPath)
        ? [{ projectId, title: project.title }]
        : [];
    });
  };
  const publishHostedProjectConflicts = () =>
    postMessageToDashboard({
      type: 'workflow-project-conflicts',
      snapshot: getHostedProjectConflictSnapshot(editableProjects()),
    });

  useEffect(() => {
    const unsubscribe = subscribeHostedProjectRevisions(publishHostedProjectConflicts);
    publishHostedProjectConflicts();
    return unsubscribe;
  }, []);

  useEffect(() => {
    pruneHostedProjectRevisions(editableProjects().map((project) => project.projectId));
    publishHostedProjectConflicts();
  }, [projects]);

  useEffect(() => {
    const context: EditorCommandBridgeContext = {
      clearLoadedRecordingForPath: (projectPath) => {
        clearLoadedRecordingForPath(projectPath);
      },
      rebindLoadedRecordingPath: (fromPath, toPath) => {
        rebindLoadedRecordingPath({ fromPath, toPath });
      },
      // A queued command can finish before React renders its state updates.
      getCurrentProject: () => store.get(projectState),
      getSelectedExecutor: () => selectedExecutorRef.current,
      loadProjectData: async (path, options) => {
        const provider = ioProvider as {
          loadProjectDataNoPrompt?: EditorCommandBridgeContext['loadProjectData'];
        };
        if (typeof provider.loadProjectDataNoPrompt !== 'function') {
          throw new Error('The active IO provider does not support reloading projects by path.');
        }
        return provider.loadProjectDataNoPrompt(path, options);
      },
      getLoadedProject: () => store.get(loadedProjectState),
      getOpenProject: () => openProjectRef.current,
      getProjects: () => store.get(projectsState),
      getWorkspace: () => workspaceRef.current,
      markLoadedProjectClosed: () => setLoadedProject({ loaded: false, path: '' }),
      openedProjectPathAliases: openedProjectPathAliasesRef.current,
      preview,
      recording,
    };

    const comparison = createEditorBundleComparison(context);
    let historyOpen: { sessionId: string; controller: AbortController } | undefined;
    const runSerializedCommand = async (command: SerializedEditorCommand, signal?: AbortSignal): Promise<void> => {
      switch (command.type) {
        case 'bundle-comparison':
          return comparison.run(command);
        case 'capture-workflow-project-reconciliation':
          publishHostedProjectConflicts();
          postMessageToDashboard({
            type: 'workflow-project-reconciliation-captured',
            requestId: command.requestId,
            context: (() => {
              const openedIds = editableProjects().map((project) => project.projectId);
              const captured = captureHostedProjectReconciliation(openedIds);
              const flags = store.get(projectUnsavedChangesState);
              return {
                ...captured,
                editCheckComplete: captured.projects.length === openedIds.length,
                projects: captured.projects.map((project) => ({
                  ...project,
                  hasUnsavedChanges: Boolean(flags[project.projectId as ProjectId]),
                })),
              };
            })(),
          });
          return;
        case 'open-project':
          await handleOpenProjectCommand(context, command, { signal });
          return;
        case 'close-history-preview': {
          const projects = context.getProjects();
          for (const id of projects.openedProjectsSortedIds) {
            const scope = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(projects.openedProjects[id]?.fsPath ?? '');
            if (scope?.sessionId === command.sessionId) await context.getWorkspace().closeProject(id);
          }
          return;
        }
        case 'delete-workflow-project':
          await handleDeleteWorkflowProjectCommand(context, command);
          return;
        case 'refresh-open-project-from-disk':
          await handleRefreshOpenProjectCommand(context, command);
          return;
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

    const enqueueSerializedCommand = (command: SerializedEditorCommand, signal?: AbortSignal): void => {
      const finish = beginDevelopmentCommand();
      const queued = serializedCommandQueueRef.current
        .catch(() => undefined)
        .then(() => runSerializedCommand(command, signal))
        .finally(finish);
      serializedCommandQueueRef.current = queued.catch((error) => {
        console.error('Failed to process hosted editor command:', error);
      });
    };

    const handler = async (event: MessageEvent) => {
      if (!isValidBridgeOrigin(event, window.parent) || !isDashboardToEditorCommand(event.data)) {
        return;
      }

      switch (event.data.type) {
        case 'bundle-comparison':
          if (event.data.action === 'state') {
            await comparison.run(event.data);
            break;
          }
          comparison.admit(event.data);
          enqueueSerializedCommand(event.data);
          break;
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
        case 'open-project': {
          comparison.cancelPending();
          // Supersede snapshot reads on receipt, even while activation is queued.
          historyOpen?.controller.abort();
          const sessionId = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(event.data.path)?.sessionId;
          historyOpen = sessionId ? { sessionId, controller: new AbortController() } : undefined;
          enqueueSerializedCommand(event.data, historyOpen?.controller.signal);
          break;
        }
        case 'open-recording':
        case 'open-published-version-preview':
        case 'refresh-open-project-from-disk':
        case 'compare-open-project-with':
          comparison.cancelPending();
          enqueueSerializedCommand(event.data);
          break;
        case 'close-history-preview':
          if (historyOpen?.sessionId === event.data.sessionId) {
            historyOpen.controller.abort();
            historyOpen = undefined;
          }
          enqueueSerializedCommand(event.data);
          break;
        case 'workflow-paths-moved':
        case 'delete-workflow-project':
        case 'reconcile-workflow-project-bindings':
        case 'resolve-workflow-project-content-change':
        case 'capture-workflow-project-reconciliation':
          enqueueSerializedCommand(event.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
      historyOpen?.controller.abort();
      comparison.dispose();
    };
  }, [clearLoadedRecordingForPath, preview, rebindLoadedRecordingPath, recording, setLoadedProject]);
}
