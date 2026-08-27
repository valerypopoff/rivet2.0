import { getError, type Project } from '@valerypopoff/rivet2-core';

import { postMessageToDashboard } from '../../shared/editor-bridge';
import { getWorkflowRecordingVirtualProjectPath } from '../../shared/workflow-recording-types';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  getWorkflowPublishedVersionPreviewVirtualProjectPath,
} from '../../shared/workflow-types';
import { deserializeProjectAsync } from '../overrides/utils/deserializeProject';
import { focusHostedEditorFrame } from './editorBridgeFocus';
import type {
  EditorCommandBridgeContext,
  SerializedEditorCommand,
} from './editorCommandBridgeContext';
import {
  fetchLoadedWorkflowRecording,
  getRecordingStartGraphId,
} from './useWorkflowRecordingBridge';
import {
  fetchHostedProjectFile,
  fetchWorkflowPublishedVersionPreview,
} from './workflowApi';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

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

export async function handleOpenRecordingCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'open-recording' }>,
): Promise<void> {
  const virtualProjectPath = getWorkflowRecordingVirtualProjectPath(command.recordingId);
  try {
    const loadedRecording = await fetchLoadedWorkflowRecording(command.recordingId);
    const replacedPath = command.replaceCurrent ? context.getLoadedProject().path : '';
    context.recording.recordingByProjectPathRef.current.set(virtualProjectPath, loadedRecording);
    const openResult = await context.getOpenProject()(virtualProjectPath, {
      replaceCurrent: Boolean(command.replaceCurrent),
      preferredGraphId: getRecordingStartGraphId(loadedRecording.recorder),
    });
    if (!openResult.opened || !openResult.projectId) {
      context.recording.recordingByProjectPathRef.current.delete(virtualProjectPath);
      if (context.getLoadedProject().path === virtualProjectPath) {
        context.clearLoadedRecording(context.getCurrentProject().metadata.id);
      }
      return;
    }
    if (replacedPath && replacedPath !== virtualProjectPath) {
      context.preview.clearPreviewProjectByPath(replacedPath);
      context.recording.recordingByProjectPathRef.current.delete(replacedPath);
    }
    context.recording.activateWorkflowRecording(loadedRecording, openResult.projectId);
    focusHostedEditorFrame();
    postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
  } catch (error) {
    context.recording.recordingByProjectPathRef.current.delete(virtualProjectPath);
    if (context.getLoadedProject().path === virtualProjectPath) {
      context.clearLoadedRecording(context.getCurrentProject().metadata.id);
    }
    const message = getError(error).message;
    console.error('Failed to open workflow recording:', error);
    postMessageToDashboard({ type: 'project-open-failed', path: command.recordingId, error: message });
  }
}

export async function handleOpenPublishedPreviewCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'open-published-version-preview' }>,
): Promise<void> {
  const virtualProjectPath = getWorkflowPublishedVersionPreviewVirtualProjectPath(
    command.relativePath,
    command.versionId,
  );
  try {
    const replacedPath = command.replaceCurrent ? context.getLoadedProject().path : '';
    const openResult = await context.getOpenProject()(virtualProjectPath, {
      replaceCurrent: Boolean(command.replaceCurrent),
    });
    if (!openResult.opened) {
      return;
    }
    if (replacedPath && replacedPath !== virtualProjectPath) {
      context.preview.clearPreviewProjectByPath(replacedPath);
      context.recording.recordingByProjectPathRef.current.delete(replacedPath);
    }
    context.clearLoadedRecording(openResult.projectId);
    focusHostedEditorFrame();
    postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
  } catch (error) {
    const message = getError(error).message;
    console.error('Failed to open published version preview:', error);
    postMessageToDashboard({ type: 'project-open-failed', path: virtualProjectPath, error: message });
  }
}

export async function handleCompareOpenProjectCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'compare-open-project-with' }>,
): Promise<void> {
  try {
    const activeProject = context.getCurrentProject();
    const activeProjectPath = context.getLoadedProject().path?.trim() ?? '';
    if (!activeProject.metadata.id || !activeProjectPath) {
      throw new Error('Open a project before starting compare mode.');
    }
    if (normalizeWorkflowPath(activeProjectPath) === normalizeWorkflowPath(command.path)) {
      throw new Error('Choose a different project to compare against.');
    }

    const referenceProject = await fetchProjectCompareReference(command.path);
    const started = await context.getWorkspace().startProjectCompare(
      referenceProject,
      command.referencePath ?? command.path,
      command.labels ? { labels: command.labels } : undefined,
    );
    if (!started) {
      throw new Error('Failed to start compare mode for the open project.');
    }
  } catch (error) {
    const message = getError(error).message;
    console.error('Failed to start project compare mode:', error);
    postMessageToDashboard({ type: 'project-compare-failed', path: command.path, error: message });
  }
}
