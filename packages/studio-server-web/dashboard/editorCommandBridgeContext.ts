import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationProjectFileData } from '../../app/src/io/IOProvider.js';

import type { RivetWorkspaceHost } from '../../app/src/host';
import type { OpenedProjectInfo, OpenedProjectsInfo } from '../../app/src/state/savedGraphs';
import type { DashboardToEditorCommand } from '../../studio-server-shared/editor-bridge';
import type { useOpenWorkflowProject } from './useOpenWorkflowProject';
import type { usePreviewProjectLifecycle } from './usePreviewProjectLifecycle';
import type { useWorkflowRecordingBridge } from './useWorkflowRecordingBridge';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

export type LoadedProjectInfo = {
  loaded: boolean;
  path: string | null;
};

export type SerializedEditorCommand = Extract<
  DashboardToEditorCommand,
  {
    type:
      | 'open-project'
      | 'open-recording'
      | 'open-published-version-preview'
      | 'refresh-open-project-from-disk'
      | 'compare-open-project-with'
      | 'workflow-paths-moved'
      | 'reconcile-workflow-project-bindings'
      | 'resolve-workflow-project-content-change';
  }
>;

export type EditorCommandBridgeContext = {
  clearLoadedRecording(projectId?: ProjectId): void;
  getCurrentProject(): Project;
  loadProjectData(path: string): Promise<{ project: Project; evaluation: EvaluationProjectFileData }>;
  getLoadedProject(): LoadedProjectInfo;
  getOpenProject(): ReturnType<typeof useOpenWorkflowProject>;
  getProjects(): OpenedProjectsInfo;
  getWorkspace(): RivetWorkspaceHost;
  markLoadedProjectClosed(): void;
  openedProjectPathAliases: Map<string, ProjectId>;
  preview: ReturnType<typeof usePreviewProjectLifecycle>;
  recording: ReturnType<typeof useWorkflowRecordingBridge>;
};

export function findOpenedProjectByPath(context: EditorCommandBridgeContext, path: string): OpenedProjectInfo | null {
  const normalizedPath = normalizeWorkflowPath(path);
  const projects = context.getProjects();
  const openedProjectId = projects.openedProjectsSortedIds.find(
    (projectId) => normalizeWorkflowPath(projects.openedProjects[projectId]?.fsPath ?? '') === normalizedPath,
  );
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
