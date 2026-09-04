import { getError } from '@valerypopoff/rivet2-core';

import {
  postMessageToDashboard,
  type DashboardToEditorCommand,
} from '../../studio-server-shared/editor-bridge';
import { primeOpenedProjectSession } from '../io/openedProjectSessionCache';
import { focusHostedEditorFrame } from './editorBridgeFocus';
import {
  findOpenedProjectByPath,
  rememberOpenedProjectPathAlias,
  type EditorCommandBridgeContext,
  type SerializedEditorCommand,
} from './editorCommandBridgeContext';
import {
  getHostedProjectRevisionState,
  restoreHostedProjectRevisionState,
} from '../io/hostedProjectRevisionTracker';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

function resolveOpeningProjectTitle(
  command: Extract<DashboardToEditorCommand, { type: 'open-project' }>,
): string {
  const commandTitle = command.title?.trim();
  if (commandTitle) {
    return commandTitle;
  }

  const fileName = command.path.split(/[\\/]/).pop()?.trim();
  return fileName?.replace(/\.rivet-project$/i, '').trim() || 'Project';
}

function waitForOpeningProjectTabFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function closeReplaceablePreviewProject(
  context: EditorCommandBridgeContext,
  nextPath: string,
): Promise<void> {
  const currentPreview = context.preview.previewProjectRef.current;
  if (!currentPreview || normalizeWorkflowPath(currentPreview.path) === normalizeWorkflowPath(nextPath)) {
    return;
  }
  if (!context.preview.previewProjectIsSafelyReplaceable(currentPreview)) {
    context.preview.promotePreviewProject(currentPreview);
    return;
  }

  try {
    const closed = await context.getWorkspace().closeProject(currentPreview.projectId);
    if (closed) {
      context.preview.clearPreviewProject(currentPreview);
    } else {
      context.preview.promotePreviewProject(currentPreview);
    }
  } catch (error) {
    console.error('Failed to close previous preview project:', error);
    context.preview.promotePreviewProject(currentPreview);
  }
}

export async function handleOpenProjectCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'open-project' }>,
): Promise<void> {
  let openingTabId: string | undefined;
  try {
    const existingOpenedProject = findOpenedProjectByPath(context, command.path);
    const existingPreview = context.preview.previewProjectRef.current;
    const targetIsExistingPreview = (
      existingPreview !== null &&
      normalizeWorkflowPath(existingPreview.path) === normalizeWorkflowPath(command.path)
    );
    const shouldUsePreviewSlot = (
      command.preview === true && (existingOpenedProject === null || targetIsExistingPreview)
    );
    const shouldReplaceActivePreview = Boolean(
      shouldUsePreviewSlot &&
      existingPreview &&
      !targetIsExistingPreview &&
      context.getCurrentProject().metadata.id === existingPreview.projectId &&
      context.preview.previewProjectIsSafelyReplaceable(existingPreview)
    );

    if (shouldUsePreviewSlot && !shouldReplaceActivePreview) {
      await closeReplaceablePreviewProject(context, command.path);
    }

    const replaceCurrent = Boolean(command.replaceCurrent || shouldReplaceActivePreview);
    const replacedPath = replaceCurrent ? context.getLoadedProject().path : '';
    const canStartOpeningTabBeforeLoad = (
      !existingOpenedProject &&
      command.reloadFromDisk !== true &&
      (!replaceCurrent || shouldReplaceActivePreview)
    );
    if (canStartOpeningTabBeforeLoad) {
      const openingTab = await context.getWorkspace().startOpeningProjectTab(
        { path: command.path, title: resolveOpeningProjectTitle(command) },
        {
          replaceCurrent,
          tabUi: shouldUsePreviewSlot ? { preview: true } : undefined,
        },
      );
      if (openingTab) {
        openingTabId = openingTab.openingTabId;
        await waitForOpeningProjectTabFrame();
      }
    }

    const openResult = await context.getOpenProject()(command.path, {
      replaceCurrent,
      openingTabId,
      openedProjectId: existingOpenedProject?.projectId,
      reloadFromDisk: Boolean(command.reloadFromDisk),
      skipReplaceConfirmation: shouldReplaceActivePreview,
      previewTab: shouldUsePreviewSlot,
    });
    if (!openResult.opened) {
      if (openingTabId) {
        try {
          await context.getWorkspace().cancelOpeningProjectTab(openingTabId);
        } catch (cancelError) {
          console.warn('Failed to cancel project opening tab after skipped open:', cancelError);
        }
      }
      return;
    }

    if (shouldUsePreviewSlot) {
      const openedProject = openResult.projectId
        ? { projectId: openResult.projectId }
        : findOpenedProjectByPath(context, command.path);
      if (openedProject?.projectId) {
        rememberOpenedProjectPathAlias(context, command.path, openedProject.projectId);
        context.preview.rememberPreviewProject({ path: command.path, projectId: openedProject.projectId });
      } else {
        console.warn('Opened preview project without a project id; leaving it persistent.', command.path);
      }
    } else {
      if (openResult.projectId) {
        rememberOpenedProjectPathAlias(context, command.path, openResult.projectId);
      }
      context.preview.promotePreviewProjectByPath(command.path);
    }

    if (replacedPath && replacedPath !== command.path) {
      context.preview.clearPreviewProjectByPath(replacedPath);
      context.recording.recordingByProjectPathRef.current.delete(replacedPath);
    }
    context.clearLoadedRecording(openResult.projectId);
    focusHostedEditorFrame();
    postMessageToDashboard({ type: 'project-opened', path: command.path, requestId: command.requestId });
  } catch (error) {
    if (openingTabId) {
      try {
        await context.getWorkspace().cancelOpeningProjectTab(openingTabId);
      } catch (cancelError) {
        console.warn('Failed to cancel project opening tab after open failure:', cancelError);
      }
    }
    const message = getError(error).message;
    console.error('Failed to open workflow project:', error);
    postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
  }
}

export async function handleRefreshOpenProjectCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'refresh-open-project-from-disk' }>,
): Promise<boolean> {
  const openedProject = findOpenedProjectByPath(context, command.path);
  if (!openedProject) {
    return false;
  }
  const revisionStateBeforeRefresh = getHostedProjectRevisionState(openedProject.projectId);
  if (normalizeWorkflowPath(context.getLoadedProject().path) !== normalizeWorkflowPath(command.path)) {
    let replacementSucceeded = false;
    try {
      const loaded = await context.loadProjectData(command.path);
      if (loaded.project.metadata.id !== openedProject.projectId) {
        throw new Error('Reloaded project has a different project ID.');
      }
      const { data, ...project } = loaded.project;
      const replaced = await context.getWorkspace().replaceProjectSnapshot(openedProject.projectId, {
        project,
        data,
        path: command.path,
        openedGraph: openedProject.openedGraph,
        evaluationData: loaded.evaluation.evaluationData,
        evaluationDatasets: loaded.evaluation.evaluationDatasets,
      });
      if (!replaced) {
        throw new Error('Rivet could not refresh the inactive project tab.');
      }
      replacementSucceeded = true;
      primeOpenedProjectSession(openedProject.projectId, {
        fsPath: command.path,
        evaluation: loaded.evaluation,
      });
      context.clearLoadedRecording(openedProject.projectId);
      return true;
    } catch (error) {
      if (!replacementSucceeded) {
        restoreHostedProjectRevisionState(openedProject.projectId, revisionStateBeforeRefresh);
      }
      const message = getError(error).message;
      console.error('Failed to refresh inactive workflow project from storage:', error);
      postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
      return false;
    }
  }

  let replacementSucceeded = false;
  try {
    const openResult = await context.getOpenProject()(command.path, {
      replaceCurrent: true,
      openedProjectId: openedProject.projectId,
      reloadFromDisk: true,
      previewTab: false,
    });
    if (!openResult.opened) {
      throw new Error('Rivet could not reload the restored project.');
    }
    replacementSucceeded = true;
    if (openResult.projectId) {
      rememberOpenedProjectPathAlias(context, command.path, openResult.projectId);
    }
    context.preview.promotePreviewProjectByPath(command.path);
    context.clearLoadedRecording(openResult.projectId);
    postMessageToDashboard({ type: 'project-opened', path: command.path });
    return true;
  } catch (error) {
    if (!replacementSucceeded) {
      restoreHostedProjectRevisionState(openedProject.projectId, revisionStateBeforeRefresh);
    }
    const message = getError(error).message;
    console.error('Failed to refresh workflow project from storage:', error);
    postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
    return false;
  }
}
