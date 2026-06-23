import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { ExecutionRecorder, getError, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  type OpenedProjectsInfo,
  type OpenedProjectInfo,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { deleteHostedProjectContextState } from '../overrides/state/savedGraphs';
import {
  executorSessionRevisionState,
  loadedRecordingState,
} from '../../../rivet/packages/app/src/state/execution';
import { graphRunningState } from '../../../rivet/packages/app/src/state/dataFlow';
import { selectedExecutorState } from '../../../rivet/packages/app/src/state/settings';
import {
  openOrFocusGraphSearchState,
  searchingGraphState,
} from '../../../rivet/packages/app/src/state/graphBuilder';
import { overlayOpenState } from '../../../rivet/packages/app/src/state/ui';
import { flushHybridStorageGroup } from '../../../rivet/packages/app/src/state/storage';
import { useExecutorSessionRuntime, type RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import type { WorkflowProjectPathMove } from './types';
import {
  type DashboardToEditorCommand,
  type EditorShortcutModifier,
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
  postMessageToDashboard,
} from '../../shared/editor-bridge';
import {
  getWorkflowRecordingIdFromVirtualProjectPath,
  getWorkflowRecordingVirtualProjectPath,
} from '../../shared/workflow-recording-types';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  getWorkflowPublishedVersionPreviewVirtualProjectPath,
} from '../../shared/workflow-types';
import { resolveHostedProjectMetadataUpdatesForPathMoves } from './openedProjectMetadata';
import {
  fetchHostedProjectFile,
  fetchWorkflowPublishedVersionPreview,
  fetchWorkflowRecordingArtifactText,
} from './workflowApi';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';
import { clearOpenedProjectSession, remapOpenedProjectSessionPaths } from '../io/openedProjectSessionCache';
import { clearHostedProjectRevisionPath, remapHostedProjectRevisionPaths } from '../io/HostedIOProvider';
import { deserializeProjectAsync } from '../overrides/utils/deserializeProject';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import {
  focusHostedEditorCanvas,
  focusHostedEditorFrame,
  isEditorFindShortcutEvent,
  isEditableElement,
  isSaveShortcutEvent,
} from './editorBridgeFocus';
import { clearHostedDatasetsForProject } from './hostedRivetProviders';

const GRAPH_SEARCH_INPUT_SELECTOR = '.search input[placeholder="Search..."]';
const FULLSCREEN_OUTPUT_SEARCH_INPUT_SELECTOR = '[data-testid="fullscreen-output-modal"] .search-input';
const MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS = [
  FULLSCREEN_OUTPUT_SEARCH_INPUT_SELECTOR,
  '.context-menu-search input[placeholder="Search..."]:not(:disabled)',
  '.plugin-search input[placeholder="Search..."]',
  GRAPH_SEARCH_INPUT_SELECTOR,
];

function isVisibleEnabledInput(input: HTMLInputElement): boolean {
  return !input.disabled && input.getClientRects().length > 0;
}

function isMountedEditorSearchInput(element: Element | null | undefined): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS.some((selector) => element.matches(selector)) &&
    isVisibleEnabledInput(element)
  );
}

function getRecordingStartGraphId(recorder: ExecutionRecorder): string | undefined {
  for (const event of recorder.events) {
    if (event.type === 'start') {
      return event.data.startGraph;
    }

    if (event.type === 'graphStart') {
      return event.data.graphId;
    }
  }

  return undefined;
}

async function clearDeletedHostedProjectState(projectIds: Iterable<ProjectId>): Promise<void> {
  for (const projectId of projectIds) {
    deleteHostedProjectContextState(projectId);

    try {
      await clearHostedDatasetsForProject(projectId);
    } catch (error) {
      console.error('Failed to clear hosted datasets for deleted project:', error);
    }

    clearOpenedProjectSession(projectId);
  }
}

function createEditorFindKeyboardEvent(modifier: EditorShortcutModifier): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyF',
    ctrlKey: modifier === 'ctrl',
    key: 'f',
    metaKey: modifier === 'meta',
  });
}

function createEditorDuplicateKeyboardEvent(modifier: EditorShortcutModifier): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyD',
    ctrlKey: modifier === 'ctrl',
    key: 'd',
    metaKey: modifier === 'meta',
  });
}

function replayEditorFindShortcut(modifier: EditorShortcutModifier): void {
  window.dispatchEvent(createEditorFindKeyboardEvent(modifier));
}

function replayEditorDuplicateShortcut(modifier: EditorShortcutModifier): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  (target ?? window).dispatchEvent(createEditorDuplicateKeyboardEvent(modifier));
}

function focusMountedEditorSearchInput(): boolean {
  for (const selector of MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS) {
    const input = document.querySelector<HTMLInputElement>(selector);

    if (!input || !isVisibleEnabledInput(input)) {
      continue;
    }

    input.focus({ preventScroll: true });
    input.select();
    return true;
  }

  return false;
}

type LoadedWorkflowRecording = {
  path: string;
  recorder: ExecutionRecorder;
};

type PreviewWorkflowProject = {
  path: string;
  projectId: ProjectId;
};

function resolveOpeningProjectTitle(command: Extract<DashboardToEditorCommand, { type: 'open-project' }>): string {
  const commandTitle = command.title?.trim();
  if (commandTitle) {
    return commandTitle;
  }

  const fileName = command.path.split(/[\\/]/).pop()?.trim();
  const titleFromFileName = fileName?.replace(/\.rivet-project$/i, '').trim();
  return titleFromFileName || 'Project';
}

function waitForOpeningProjectTabFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function fetchLoadedWorkflowRecording(recordingId: string): Promise<LoadedWorkflowRecording> {
  const serializedRecording = await fetchWorkflowRecordingArtifactText(recordingId, 'recording');

  return {
    path: `${recordingId}.rivet-recording`,
    recorder: ExecutionRecorder.deserializeFromString(serializedRecording),
  };
}

async function fetchProjectCompareReference(path: string): Promise<Project> {
  const previewReference = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(path);
  if (previewReference) {
    const preview = await fetchWorkflowPublishedVersionPreview(
      previewReference.relativePath,
      previewReference.versionId,
    );
    return deserializeProjectAsync(preview.contents, path);
  }

  const loadedProjectFile = await fetchHostedProjectFile(path);
  return deserializeProjectAsync(loadedProjectFile.contents, path);
}

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
  const executorTargetType = executorSessionRuntime.getRuntimeState().target?.type;
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const setSelectedExecutor = useSetAtom(selectedExecutorState);
  const openOverlay = useAtomValue(overlayOpenState);
  const setSearching = useSetAtom(searchingGraphState);
  const [previewProject, setPreviewProject] = useState<PreviewWorkflowProject | null>(null);
  const projectsRef = useRef<OpenedProjectsInfo>(projects);
  const loadedProjectRef = useRef(loadedProject);
  const currentProjectRef = useRef(currentProject);
  const projectUnsavedChangesRef = useRef(projectUnsavedChanges);
  const projectDataUnsavedChangesRef = useRef(projectDataUnsavedChanges);
  const previewProjectRef = useRef<PreviewWorkflowProject | null>(previewProject);
  const workspaceRef = useRef(workspaceHost);
  const openProjectRef = useRef(openProject);
  const saveProjectRef = useRef(saveProject);
  const serializedCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingByProjectPathRef = useRef(new Map<string, LoadedWorkflowRecording>());
  projectsRef.current = projects;
  loadedProjectRef.current = loadedProject;
  currentProjectRef.current = currentProject;
  projectUnsavedChangesRef.current = projectUnsavedChanges;
  projectDataUnsavedChangesRef.current = projectDataUnsavedChanges;
  previewProjectRef.current = previewProject;
  workspaceRef.current = workspaceHost;
  openProjectRef.current = openProject;
  saveProjectRef.current = saveProject;

  const rememberPreviewProject = useCallback((project: PreviewWorkflowProject) => {
    previewProjectRef.current = project;
    setPreviewProject(project);
  }, []);

  const clearPreviewProject = useCallback((expectedProject?: PreviewWorkflowProject | null) => {
    if (
      expectedProject &&
      previewProjectRef.current &&
      previewProjectRef.current.projectId !== expectedProject.projectId
    ) {
      return;
    }

    previewProjectRef.current = null;
    setPreviewProject((currentProjectPreview) => {
      if (
        expectedProject &&
        currentProjectPreview &&
        currentProjectPreview.projectId !== expectedProject.projectId
      ) {
        return currentProjectPreview;
      }

      return null;
    });
  }, []);

  const promotePreviewProject = useCallback((expectedProject?: PreviewWorkflowProject | null) => {
    const currentPreview = previewProjectRef.current;
    if (
      expectedProject &&
      currentPreview &&
      currentPreview.projectId !== expectedProject.projectId
    ) {
      return;
    }

    const promotedProject = expectedProject ?? currentPreview;
    clearPreviewProject(expectedProject ?? undefined);

    if (!promotedProject) {
      return;
    }

    void workspaceRef.current
      .setProjectTabUiState(promotedProject.projectId, { preview: false })
      .then((updated) => {
        if (!updated) {
          console.warn('Promoted preview project was no longer open:', promotedProject.path);
        }
      })
      .catch((error) => {
        console.error('Failed to promote preview project tab:', error);
      });
  }, [clearPreviewProject]);

  const previewProjectIsSafelyReplaceable = useCallback((project: PreviewWorkflowProject): boolean => {
    return (
      projectUnsavedChangesRef.current[project.projectId] === false &&
      projectDataUnsavedChangesRef.current[project.projectId] === false
    );
  }, []);

  const promotePreviewProjectByPath = useCallback((path: string | null | undefined) => {
    const preview = previewProjectRef.current;
    if (!preview || !path || normalizeWorkflowPath(preview.path) !== normalizeWorkflowPath(path)) {
      return;
    }

    promotePreviewProject(preview);
  }, [promotePreviewProject]);

  const clearPreviewProjectByPath = useCallback((path: string | null | undefined) => {
    const preview = previewProjectRef.current;
    if (!preview || !path || normalizeWorkflowPath(preview.path) !== normalizeWorkflowPath(path)) {
      return;
    }

    clearPreviewProject(preview);
  }, [clearPreviewProject]);

  const saveCurrentProject = async () => {
    await saveProjectRef.current();
    promotePreviewProjectByPath(loadedProjectRef.current.path);
  };

  const startProjectCompare = useCallback(async (
    command: Extract<DashboardToEditorCommand, { type: 'compare-open-project-with' }>,
  ) => {
    const activeProject = currentProjectRef.current;
    const activeProjectPath = loadedProjectRef.current.path?.trim() ?? '';
    if (!activeProject.metadata.id || !activeProjectPath) {
      throw new Error('Open a project before starting compare mode.');
    }

    if (normalizeWorkflowPath(activeProjectPath) === normalizeWorkflowPath(command.path)) {
      throw new Error('Choose a different project to compare against.');
    }

    const referenceProject = await fetchProjectCompareReference(command.path);
    const compareOptions = command.labels ? { labels: command.labels } : undefined;
    const started = await workspaceRef.current.startProjectCompare(
      referenceProject,
      command.referencePath ?? command.path,
      compareOptions,
    );

    if (!started) {
      throw new Error('Failed to start compare mode for the open project.');
    }
  }, []);

  const activateWorkflowRecording = useCallback((loadedRecording: LoadedWorkflowRecording) => {
    // Current Rivet routes run-button clicks through selectedExecutorState.
    // The default executor is only a startup preference, so replay must switch
    // the live executor to browser before the user clicks Play Recording.
    setSelectedExecutor('browser');
    setLoadedRecording(loadedRecording);
  }, [setLoadedRecording, setSelectedExecutor]);

  useEffect(() => {
    let cancelled = false;
    const projectPath = loadedProject.path;

    if (!projectPath) {
      setLoadedRecording(null);
      return;
    }

    const cachedRecording = recordingByProjectPathRef.current.get(projectPath);
    if (cachedRecording) {
      activateWorkflowRecording(cachedRecording);
      return;
    }

    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(projectPath);
    if (!recordingId) {
      setLoadedRecording(null);
      return;
    }

    setLoadedRecording(null);
    void fetchLoadedWorkflowRecording(recordingId)
      .then((loadedRecording) => {
        if (cancelled) {
          return;
        }

        recordingByProjectPathRef.current.set(projectPath, loadedRecording);
        activateWorkflowRecording(loadedRecording);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error('Failed to restore workflow recording:', error);
        setLoadedRecording(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activateWorkflowRecording, loadedProject.path, setLoadedRecording]);

  useEffect(() => {
    postMessageToDashboard({ type: 'editor-ready' });
  }, []);

  useEffect(() => {
    if (!previewProject) {
      return;
    }

    if (
      projectUnsavedChanges[previewProject.projectId] === true ||
      projectDataUnsavedChanges[previewProject.projectId] === true
    ) {
      promotePreviewProject(previewProject);
    }
  }, [previewProject, projectUnsavedChanges, projectDataUnsavedChanges, promotePreviewProject]);

  useEffect(() => {
    if (!graphRunning || !previewProject) {
      return;
    }

    if (currentProject.metadata.id === previewProject.projectId) {
      promotePreviewProject(previewProject);
    }
  }, [currentProject.metadata.id, graphRunning, previewProject, promotePreviewProject]);

  useEffect(() => {
    if (executorTargetType !== 'external-debugger' || !previewProject) {
      return;
    }

    if (currentProject.metadata.id === previewProject.projectId) {
      promotePreviewProject(previewProject);
    }
  }, [currentProject.metadata.id, executorTargetType, previewProject, promotePreviewProject]);

  useEffect(() => {
    const projectId = currentProject.metadata.id as ProjectId | undefined;
    const path = loadedProject.path ?? '';
    const hasUnsavedChanges = Boolean(
      projectId &&
      path &&
      (projectUnsavedChanges[projectId] === true || projectDataUnsavedChanges[projectId] === true),
    );

    postMessageToDashboard({
      type: 'active-project-unsaved-changes-changed',
      path,
      hasUnsavedChanges,
    });
  }, [
    currentProject.metadata.id,
    loadedProject.path,
    projectUnsavedChanges,
    projectDataUnsavedChanges,
  ]);

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isSaveShortcutEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      await saveCurrentProject();
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isEditorFindShortcutEvent(event)) {
        return;
      }

      const targetElement = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement;
      const shortcutStartedInEditorSearch =
        isMountedEditorSearchInput(targetElement) || isMountedEditorSearchInput(activeElement);
      if (
        !shortcutStartedInEditorSearch &&
        (isEditableElement(targetElement) || isEditableElement(activeElement))
      ) {
        return;
      }

      if (focusMountedEditorSearchInput()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (openOverlay !== undefined) {
        return;
      }

      setSearching(openOrFocusGraphSearchState);
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, [openOverlay, setSearching]);

  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (!event.target.closest('.node-canvas')) {
        return;
      }

      focusHostedEditorFrame();
      focusHostedEditorCanvas(event.target);
    };

    document.addEventListener('pointerdown', handler, true);
    return () => {
      document.removeEventListener('pointerdown', handler, true);
    };
  }, []);

  useEffect(() => {
    type SerializedEditorCommand = Extract<DashboardToEditorCommand, {
      type:
        | 'open-project'
        | 'open-recording'
        | 'open-published-version-preview'
        | 'refresh-open-project-from-disk'
        | 'compare-open-project-with';
    }>;

    const findOpenedProjectByPath = (path: string): OpenedProjectInfo | null => {
      const normalizedPath = normalizeWorkflowPath(path);
      const openedProjects = projectsRef.current.openedProjects;
      const openedProjectId = projectsRef.current.openedProjectsSortedIds.find((projectId) =>
        normalizeWorkflowPath(openedProjects[projectId]?.fsPath ?? '') === normalizedPath);

      return openedProjectId ? openedProjects[openedProjectId] ?? null : null;
    };

    const closeReplaceablePreviewProject = async (nextPath: string): Promise<void> => {
      const preview = previewProjectRef.current;
      if (!preview || normalizeWorkflowPath(preview.path) === normalizeWorkflowPath(nextPath)) {
        return;
      }

      if (!previewProjectIsSafelyReplaceable(preview)) {
        promotePreviewProject(preview);
        return;
      }

      try {
        const closed = await workspaceRef.current.closeProject(preview.projectId);
        if (closed) {
          clearPreviewProject(preview);
          return;
        }

        promotePreviewProject(preview);
      } catch (error) {
        console.error('Failed to close previous preview project:', error);
        promotePreviewProject(preview);
      }
    };

    const runSerializedCommand = async (command: SerializedEditorCommand): Promise<void> => {
      switch (command.type) {
        case 'open-project': {
          let openingTabId: string | undefined;
          try {
            const existingOpenedProject = findOpenedProjectByPath(command.path);
            const existingPreview = previewProjectRef.current;
            const targetIsExistingPreview =
              existingPreview !== null &&
              normalizeWorkflowPath(existingPreview.path) === normalizeWorkflowPath(command.path);
            const shouldUsePreviewSlot =
              command.preview === true && (existingOpenedProject === null || targetIsExistingPreview);
            const shouldReplaceActivePreview =
              shouldUsePreviewSlot &&
              existingPreview !== null &&
              !targetIsExistingPreview &&
              currentProjectRef.current.metadata.id === existingPreview.projectId &&
              previewProjectIsSafelyReplaceable(existingPreview);

            if (shouldUsePreviewSlot && !shouldReplaceActivePreview) {
              await closeReplaceablePreviewProject(command.path);
            }

            const replaceCurrent = Boolean(command.replaceCurrent || shouldReplaceActivePreview);
            const replacedPath = replaceCurrent ? loadedProjectRef.current.path : '';
            const canStartOpeningTabBeforeLoad =
              !existingOpenedProject &&
              command.reloadFromDisk !== true &&
              (!replaceCurrent || shouldReplaceActivePreview);
            if (canStartOpeningTabBeforeLoad) {
              const openingTab = await workspaceRef.current.startOpeningProjectTab(
                {
                  path: command.path,
                  title: resolveOpeningProjectTitle(command),
                },
                {
                  replaceCurrent,
                  tabUi: shouldUsePreviewSlot
                    ? {
                        preview: true,
                      }
                    : undefined,
                },
              );

              if (openingTab) {
                openingTabId = openingTab.openingTabId;
                await waitForOpeningProjectTabFrame();
              }
            }

            const openResult = await openProjectRef.current(command.path, {
              replaceCurrent,
              openingTabId,
              reloadFromDisk: Boolean(command.reloadFromDisk),
              skipReplaceConfirmation: shouldReplaceActivePreview,
              previewTab: shouldUsePreviewSlot,
            });
            if (!openResult.opened) {
              if (openingTabId) {
                try {
                  await workspaceRef.current.cancelOpeningProjectTab(openingTabId);
                } catch (cancelError) {
                  console.warn('Failed to cancel project opening tab after skipped open:', cancelError);
                }
              }

              break;
            }

            if (shouldUsePreviewSlot) {
              const openedProject = openResult.projectId
                ? { projectId: openResult.projectId }
                : findOpenedProjectByPath(command.path);
              if (openedProject?.projectId) {
                rememberPreviewProject({
                  path: command.path,
                  projectId: openedProject.projectId,
                });
              } else {
                console.warn('Opened preview project without a project id; leaving it persistent.', command.path);
              }
            } else {
              promotePreviewProjectByPath(command.path);
            }

            if (replacedPath && replacedPath !== command.path) {
              clearPreviewProjectByPath(replacedPath);
              recordingByProjectPathRef.current.delete(replacedPath);
            }
            setLoadedRecording(null);
            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: command.path });
          } catch (error) {
            if (openingTabId) {
              try {
                await workspaceRef.current.cancelOpeningProjectTab(openingTabId);
              } catch (cancelError) {
                console.warn('Failed to cancel project opening tab after open failure:', cancelError);
              }
            }

            const message = getError(error).message;
            console.error('Failed to open workflow project:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
          }

          break;
        }

        case 'refresh-open-project-from-disk': {
          const openedProject = findOpenedProjectByPath(command.path);
          if (!openedProject) {
            break;
          }

          clearOpenedProjectSession(openedProject.projectId);

          if (normalizeWorkflowPath(loadedProjectRef.current.path) !== normalizeWorkflowPath(command.path)) {
            setOpenedProjectSnapshots((snapshots) => {
              if (!snapshots[openedProject.projectId]) {
                return snapshots;
              }

              const nextSnapshots = { ...snapshots };
              delete nextSnapshots[openedProject.projectId];
              return nextSnapshots;
            });
            break;
          }

          try {
            const openResult = await openProjectRef.current(command.path, {
              replaceCurrent: true,
              reloadFromDisk: true,
              previewTab: false,
            });
            if (!openResult.opened) {
              throw new Error('Rivet could not reload the restored project.');
            }

            promotePreviewProjectByPath(command.path);
            setLoadedRecording(null);
            postMessageToDashboard({ type: 'project-opened', path: command.path });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to refresh workflow project from storage:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
          }

          break;
        }

        case 'open-recording':
          const virtualProjectPath = getWorkflowRecordingVirtualProjectPath(command.recordingId);
          try {
            const loadedRecording = await fetchLoadedWorkflowRecording(command.recordingId);
            const preferredGraphId = getRecordingStartGraphId(loadedRecording.recorder);
            const replacedPath = command.replaceCurrent ? loadedProjectRef.current.path : '';

            recordingByProjectPathRef.current.set(virtualProjectPath, loadedRecording);
            const openResult = await openProjectRef.current(virtualProjectPath, {
              replaceCurrent: Boolean(command.replaceCurrent),
              preferredGraphId,
            });
            if (!openResult.opened) {
              recordingByProjectPathRef.current.delete(virtualProjectPath);
              if (loadedProjectRef.current.path === virtualProjectPath) {
                setLoadedRecording(null);
              }
              break;
            }

            if (replacedPath && replacedPath !== virtualProjectPath) {
              clearPreviewProjectByPath(replacedPath);
              recordingByProjectPathRef.current.delete(replacedPath);
            }
            activateWorkflowRecording(loadedRecording);

            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
          } catch (error) {
            recordingByProjectPathRef.current.delete(virtualProjectPath);
            if (loadedProjectRef.current.path === virtualProjectPath) {
              setLoadedRecording(null);
            }

            const message = getError(error).message;
            console.error('Failed to open workflow recording:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: command.recordingId, error: message });
          }

          break;

        case 'open-published-version-preview': {
          const virtualProjectPath = getWorkflowPublishedVersionPreviewVirtualProjectPath(
            command.relativePath,
            command.versionId,
          );
          try {
            const replacedPath = command.replaceCurrent ? loadedProjectRef.current.path : '';
            const openResult = await openProjectRef.current(virtualProjectPath, {
              replaceCurrent: Boolean(command.replaceCurrent),
            });
            if (!openResult.opened) {
              break;
            }

            if (replacedPath && replacedPath !== virtualProjectPath) {
              clearPreviewProjectByPath(replacedPath);
              recordingByProjectPathRef.current.delete(replacedPath);
            }
            setLoadedRecording(null);
            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to open published version preview:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: virtualProjectPath, error: message });
          }

          break;
        }

        case 'compare-open-project-with': {
          try {
            await startProjectCompare(command);
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to start project compare mode:', error);
            postMessageToDashboard({
              type: 'project-compare-failed',
              path: command.path,
              error: message,
            });
          }

          break;
        }
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
      if (!isValidBridgeOrigin(event, window.parent)) {
        return;
      }

      if (!isDashboardToEditorCommand(event.data)) {
        return;
      }

      switch (event.data.type) {
        case 'save-project': {
          await saveCurrentProject();
          break;
        }

        case 'trigger-editor-find-shortcut': {
          replayEditorFindShortcut(event.data.modifier);
          break;
        }

        case 'trigger-editor-duplicate-shortcut': {
          replayEditorDuplicateShortcut(event.data.modifier);
          break;
        }

        case 'delete-workflow-project': {
          const deletedPath = event.data.path;
          const latestProjects = projectsRef.current;
          const openedProjects = latestProjects.openedProjects;
          const openedProjectIds = latestProjects.openedProjectsSortedIds.filter((projectId) => openedProjects[projectId] != null);
          const deletedProjectId = openedProjectIds.find((projectId) => openedProjects[projectId]?.fsPath === deletedPath);
          const deletedProjectIds = new Set<ProjectId>();
          if (event.data.projectId) {
            deletedProjectIds.add(event.data.projectId as ProjectId);
          }
          if (deletedProjectId) {
            deletedProjectIds.add(deletedProjectId);
          }
          if (deletedProjectId && previewProjectRef.current?.projectId === deletedProjectId) {
            clearPreviewProject(previewProjectRef.current);
          }
          clearHostedProjectRevisionPath(deletedPath);

          let closed = false;
          if (deletedProjectId) {
            try {
              closed = await workspaceRef.current.closeProject(deletedProjectId);
            } catch (error) {
              console.error('Failed to close deleted workflow project:', error);
            }
          }

          await clearDeletedHostedProjectState(deletedProjectIds);

          if (!closed && loadedProjectRef.current.path === deletedPath) {
            setLoadedProject({ loaded: false, path: '' });
          }

          break;
        }

        case 'workflow-paths-moved': {
          const moves: WorkflowProjectPathMove[] = event.data.moves;
          if (moves.length === 0) {
            break;
          }

          const metadataUpdates = resolveHostedProjectMetadataUpdatesForPathMoves(projectsRef.current, moves);
          remapOpenedProjectSessionPaths(moves);
          remapHostedProjectRevisionPaths(moves);
          const preview = previewProjectRef.current;
          if (preview) {
            const movedPreviewPath = moves.find((move) => move.fromAbsolutePath === preview.path)?.toAbsolutePath;
            if (movedPreviewPath) {
              rememberPreviewProject({
                ...preview,
                path: movedPreviewPath,
              });
            }
          }
          workspaceRef.current.moveProjectPaths(
            moves.map((move) => ({
              from: move.fromAbsolutePath,
              to: move.toAbsolutePath,
            })),
          );

          let metadataUpdated = false;
          for (const update of metadataUpdates) {
            try {
              const updated = await workspaceRef.current.updateProjectMetadata(
                update.projectId,
                { title: update.title },
                {
                  path: update.path,
                  persistedExternally: true,
                  changeSource: 'external-wrapper-rename',
                },
              );
              metadataUpdated ||= updated;
            } catch (error) {
              console.error('Failed to update renamed hosted project metadata:', error);
            }
          }

          if (metadataUpdated) {
            await flushHybridStorageGroup('project');
          }

          break;
        }

        case 'open-project':
        case 'open-recording':
        case 'open-published-version-preview':
        case 'refresh-open-project-from-disk':
        case 'compare-open-project-with':
          enqueueSerializedCommand(event.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    setLoadedProject,
    setOpenedProjectSnapshots,
    activateWorkflowRecording,
    clearPreviewProjectByPath,
    clearPreviewProject,
    previewProjectIsSafelyReplaceable,
    promotePreviewProject,
    promotePreviewProjectByPath,
    rememberPreviewProject,
    setLoadedRecording,
    startProjectCompare,
  ]);

  return null;
};
