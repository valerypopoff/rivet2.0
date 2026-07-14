import type { ProjectId } from '@valerypopoff/rivet2-core';

import { flushHybridStorageGroup } from '../../../rivet/packages/app/src/state/storage';
import {
  clearHostedProjectRevisionPath,
  remapHostedProjectRevisionPaths,
} from '../io/HostedIOProvider';
import {
  clearOpenedProjectSession,
  remapOpenedProjectSessionPaths,
} from '../io/openedProjectSessionCache';
import { deleteHostedProjectContextState } from '../overrides/state/savedGraphs';
import {
  postMessageToDashboard,
  type DashboardToEditorCommand,
} from '../../shared/editor-bridge';
import { clearHostedDatasetsForProject } from './hostedRivetProviders';
import type {
  EditorCommandBridgeContext,
  SerializedEditorCommand,
} from './editorCommandBridgeContext';
import { removeOpenedProjectPathAliasesForProject } from './editorCommandBridgeContext';
import {
  resolveHostedProjectMetadataUpdatesForPathMoves,
  resolveHostedProjectTitleFromPath,
  type HostedProjectMetadataUpdateForPathMove,
} from './openedProjectMetadata';
import type { WorkflowProjectPathMove } from './types';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

function getHostedProjectPathMoveInputs(moves: WorkflowProjectPathMove[]) {
  const moveKeys = new Set<string>();
  return moves.flatMap((move) => [
    { from: move.fromAbsolutePath, to: move.toAbsolutePath },
    {
      from: normalizeWorkflowPath(move.fromAbsolutePath),
      to: normalizeWorkflowPath(move.toAbsolutePath),
    },
  ].filter((candidate) => {
    const key = `${candidate.from}\n${candidate.to}`;
    if (moveKeys.has(key)) {
      return false;
    }
    moveKeys.add(key);
    return true;
  }));
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

export async function handleWorkflowPathsMovedCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'workflow-paths-moved' }>,
): Promise<void> {
  const moves: WorkflowProjectPathMove[] = command.moves;
  if (moves.length === 0) {
    postMessageToDashboard({ type: 'workflow-paths-moved-applied', requestId: command.requestId });
    return;
  }

  try {
    const metadataUpdatesByProjectId = new Map<ProjectId, HostedProjectMetadataUpdateForPathMove>();
    for (const update of resolveHostedProjectMetadataUpdatesForPathMoves(context.getProjects(), moves)) {
      metadataUpdatesByProjectId.set(update.projectId, update);
    }
    remapOpenedProjectSessionPaths(moves);
    remapHostedProjectRevisionPaths(moves);
    for (const move of moves) {
      const normalizedFromPath = normalizeWorkflowPath(move.fromAbsolutePath);
      const normalizedToPath = normalizeWorkflowPath(move.toAbsolutePath);
      const aliasedProjectId = context.openedProjectPathAliases.get(normalizedFromPath);
      context.openedProjectPathAliases.delete(normalizedFromPath);
      if (aliasedProjectId) {
        context.openedProjectPathAliases.set(normalizedToPath, aliasedProjectId);
        if (!metadataUpdatesByProjectId.has(aliasedProjectId)) {
          const previousTitle = resolveHostedProjectTitleFromPath(move.fromAbsolutePath);
          const nextTitle = resolveHostedProjectTitleFromPath(move.toAbsolutePath) ?? undefined;
          metadataUpdatesByProjectId.set(aliasedProjectId, {
            projectId: aliasedProjectId,
            path: move.toAbsolutePath,
            title: nextTitle && previousTitle !== nextTitle ? nextTitle : undefined,
          });
        }
      }
    }
    for (const update of metadataUpdatesByProjectId.values()) {
      context.openedProjectPathAliases.set(normalizeWorkflowPath(update.path), update.projectId);
    }
    const currentPreview = context.preview.previewProjectRef.current;
    if (currentPreview) {
      const movedPreviewPath = moves.find(
        (move) => move.fromAbsolutePath === currentPreview.path,
      )?.toAbsolutePath;
      if (movedPreviewPath) {
        context.preview.rememberPreviewProject({ ...currentPreview, path: movedPreviewPath });
      }
    }
    context.getWorkspace().moveProjectPaths(getHostedProjectPathMoveInputs(moves));

    let metadataUpdated = false;
    for (const update of metadataUpdatesByProjectId.values()) {
      try {
        const updated = await context.getWorkspace().updateProjectMetadata(
          update.projectId,
          update.title ? { title: update.title } : {},
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
  } finally {
    postMessageToDashboard({ type: 'workflow-paths-moved-applied', requestId: command.requestId });
  }
}

export async function handleDeleteWorkflowProjectCommand(
  context: EditorCommandBridgeContext,
  command: Extract<DashboardToEditorCommand, { type: 'delete-workflow-project' }>,
): Promise<void> {
  const deletedPath = command.path;
  const projects = context.getProjects();
  const deletedProjectId = projects.openedProjectsSortedIds.find(
    (projectId) => projects.openedProjects[projectId]?.fsPath === deletedPath,
  );
  const deletedProjectIds = new Set<ProjectId>();
  if (command.projectId) {
    deletedProjectIds.add(command.projectId as ProjectId);
  }
  if (deletedProjectId) {
    deletedProjectIds.add(deletedProjectId);
    if (context.preview.previewProjectRef.current?.projectId === deletedProjectId) {
      context.preview.clearPreviewProject(context.preview.previewProjectRef.current);
    }
    removeOpenedProjectPathAliasesForProject(context, deletedProjectId);
  }
  context.openedProjectPathAliases.delete(normalizeWorkflowPath(deletedPath));
  clearHostedProjectRevisionPath(deletedPath);

  let closed = false;
  if (deletedProjectId) {
    try {
      closed = await context.getWorkspace().closeProject(deletedProjectId);
    } catch (error) {
      console.error('Failed to close deleted workflow project:', error);
    }
  }
  await clearDeletedHostedProjectState(deletedProjectIds);
  if (!closed && context.getLoadedProject().path === deletedPath) {
    context.markLoadedProjectClosed();
  }
}
