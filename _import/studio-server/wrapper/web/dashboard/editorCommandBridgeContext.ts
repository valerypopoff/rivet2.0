import type { Project, ProjectId } from '@valerypopoff/rivet2-core';

import type { RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import type {
  OpenedProjectInfo,
  OpenedProjectsInfo,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import type { DashboardToEditorCommand } from '../../shared/editor-bridge';
import type { useOpenWorkflowProject } from './useOpenWorkflowProject';
import type { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import type { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

export type LoadedProjectInfo = {
  loaded: boolean;
  path: string | null;
};

export type SerializedEditorCommand = Extract<DashboardToEditorCommand, {
  type:
    | 'open-project'
    | 'open-recording'
    | 'open-published-version-preview'
    | 'refresh-open-project-from-disk'
    | 'compare-open-project-with'
    | 'workflow-paths-moved';
}>;

export type EditorCommandBridgeContext = {
  clearLoadedRecording(projectId?: ProjectId): void;
  getCurrentProject(): Project;
  getLoadedProject(): LoadedProjectInfo;
  getOpenProject(): ReturnType<typeof useOpenWorkflowProject>;
  getProjects(): OpenedProjectsInfo;
  getWorkspace(): RivetWorkspaceHost;
  markLoadedProjectClosed(): void;
  openedProjectPathAliases: Map<string, ProjectId>;
  preview: ReturnType<typeof usePreviewProjectLifecycle>;
  recording: ReturnType<typeof useWorkflowRecordingBridge>;
  removeOpenedProjectSnapshot(projectId: ProjectId): void;
};

export function findOpenedProjectByPath(
  context: EditorCommandBridgeContext,
  path: string,
): OpenedProjectInfo | null {
  const normalizedPath = normalizeWorkflowPath(path);
  const projects = context.getProjects();
  const openedProjectId = projects.openedProjectsSortedIds.find((projectId) =>
    normalizeWorkflowPath(projects.openedProjects[projectId]?.fsPath ?? '') === normalizedPath);
  const aliasedProjectId = context.openedProjectPathAliases.get(normalizedPath);

  return openedProjectId
    ? projects.openedProjects[openedProjectId] ?? null
    : aliasedProjectId
      ? projects.openedProjects[aliasedProjectId] ?? null
      : null;
}

export function rememberOpenedProjectPathAlias(
  context: EditorCommandBridgeContext,
  path: string,
  projectId: ProjectId,
): void {
  context.openedProjectPathAliases.set(normalizeWorkflowPath(path), projectId);
}

export function removeOpenedProjectPathAliasesForProject(
  context: EditorCommandBridgeContext,
  projectId: ProjectId,
): void {
  for (const [path, aliasedProjectId] of context.openedProjectPathAliases.entries()) {
    if (aliasedProjectId === projectId) {
      context.openedProjectPathAliases.delete(path);
    }
  }
}
