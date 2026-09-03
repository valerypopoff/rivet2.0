import type { ProjectId } from '@valerypopoff/rivet2-core';

import { flushHybridStorageGroup } from '../../app/src/state/storage';
import {
  clearHostedProjectRevisionPath,
  remapHostedProjectRevisionPaths,
} from '../io/HostedIOProvider';
import {
  acceptHostedProjectRemoteRevision,
  getHostedProjectPendingRevision,
  observeHostedProjectRevision,
  pruneHostedProjectRevisions,
} from '../io/hostedProjectRevisionTracker';
import { clearOpenedProjectSession, remapOpenedProjectSessionPaths } from '../io/openedProjectSessionCache';
import { deleteHostedProjectContextState } from '../overrides/state/savedGraphs';
import {
  postMessageToDashboard,
  type DashboardToEditorCommand,
  type WorkflowProjectBindingReconciliation,
  type WorkflowProjectContentChange,
} from '../../studio-server-shared/editor-bridge';
import { clearHostedDatasetsForProject } from './hostedRivetProviders';
import type { EditorCommandBridgeContext, SerializedEditorCommand } from './editorCommandBridgeContext';
import { removeOpenedProjectPathAliasesForProject } from './editorCommandBridgeContext';
import {
  resolveHostedProjectMetadataUpdatesForPathMoves,
  resolveHostedProjectTitleFromPath,
  type HostedProjectMetadataUpdateForPathMove,
} from './openedProjectMetadata';
import { handleRefreshOpenProjectCommand } from './editorProjectOpenCommands';
import type { WorkflowProjectPathMove } from './types';
import type { WorkflowProjectEditorBinding } from '../../studio-server-shared/workflow-types';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

function getHostedProjectPathMoveInputs(moves: WorkflowProjectPathMove[]) {
  const moveKeys = new Set<string>();
  return moves.flatMap((move) =>
    [
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
    }),
  );
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
      const movedPreviewPath = moves.find((move) => move.fromAbsolutePath === currentPreview.path)?.toAbsolutePath;
      if (movedPreviewPath) {
        context.preview.rememberPreviewProject({ ...currentPreview, path: movedPreviewPath });
      }
    }
    context.getWorkspace().moveProjectPaths(getHostedProjectPathMoveInputs(moves));

    let metadataUpdated = false;
    for (const update of metadataUpdatesByProjectId.values()) {
      try {
        const updated = await context
          .getWorkspace()
          .updateProjectMetadata(update.projectId, update.title ? { title: update.title } : {}, {
            path: update.path,
            persistedExternally: true,
            changeSource: 'external-wrapper-rename',
          });
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

/**
 * Rebind already-open editor tabs to the authoritative workflow-tree location.
 * The path is deliberately derived from the stable project id, not from a
 * matching filename, so a folder move, project rename, or a sequence of both
 * cannot turn a later in-place save into a new project.
 */
export async function handleReconcileWorkflowProjectBindingsCommand(
  context: EditorCommandBridgeContext,
  command: Extract<SerializedEditorCommand, { type: 'reconcile-workflow-project-bindings' }>,
): Promise<void> {
  const bindingsByProjectId = new Map<ProjectId, WorkflowProjectEditorBinding>();
  for (const binding of command.bindings) {
    bindingsByProjectId.set(binding.projectId as ProjectId, binding);
  }

  const projects = context.getProjects();
  const updates: Array<{
    projectId: ProjectId;
    binding: WorkflowProjectEditorBinding;
    fromPath: string | null;
    fromTitle: string;
  }> = [];
  const contentChanges: WorkflowProjectContentChange[] = [];

  pruneHostedProjectRevisions(projects.openedProjectsSortedIds);

  for (const projectId of projects.openedProjectsSortedIds) {
    const openedProject = projects.openedProjects[projectId];
    const binding = openedProject ? bindingsByProjectId.get(projectId) : undefined;
    if (!openedProject || !binding) {
      continue;
    }

    const pathChanged = normalizeWorkflowPath(openedProject.fsPath ?? '') !== normalizeWorkflowPath(binding.path);
    const titleChanged = openedProject.title !== binding.title;
    const structuralChange = pathChanged || titleChanged;
    const remoteChange = observeHostedProjectRevision({
      projectId,
      path: binding.path,
      revisionId: binding.revisionId,
      structuralChange,
    });
    if (remoteChange) {
      contentChanges.push({
        projectId,
        path: binding.path,
        title: binding.title,
        revisionId: remoteChange.revisionId,
      });
    }
    if (!structuralChange) {
      continue;
    }

    updates.push({
      projectId,
      binding,
      fromPath: openedProject.fsPath ?? null,
      fromTitle: openedProject.title,
    });
  }

  const moves = updates.flatMap(({ fromPath, binding }) =>
    fromPath && normalizeWorkflowPath(fromPath) !== normalizeWorkflowPath(binding.path)
      ? [{ fromAbsolutePath: fromPath, toAbsolutePath: binding.path }]
      : [],
  );
  const changes: WorkflowProjectBindingReconciliation[] = updates.flatMap((update) =>
    update.fromPath &&
    (normalizeWorkflowPath(update.fromPath) !== normalizeWorkflowPath(update.binding.path) ||
      update.fromTitle !== update.binding.title)
      ? [
          {
            projectId: update.projectId,
            fromPath: update.fromPath,
            toPath: update.binding.path,
            fromTitle: update.fromTitle,
            toTitle: update.binding.title,
          },
        ]
      : [],
  );

  try {
    if (moves.length > 0) {
      remapOpenedProjectSessionPaths(moves);
      remapHostedProjectRevisionPaths(moves);
      for (const move of moves) {
        const fromPath = normalizeWorkflowPath(move.fromAbsolutePath);
        const toPath = normalizeWorkflowPath(move.toAbsolutePath);
        const projectId = context.openedProjectPathAliases.get(fromPath);
        context.openedProjectPathAliases.delete(fromPath);
        if (projectId) {
          context.openedProjectPathAliases.set(toPath, projectId);
        }
      }
      const currentPreview = context.preview.previewProjectRef.current;
      if (currentPreview) {
        const movedPreviewPath = moves.find(
          (move) => normalizeWorkflowPath(move.fromAbsolutePath) === normalizeWorkflowPath(currentPreview.path),
        )?.toAbsolutePath;
        if (movedPreviewPath) {
          context.preview.rememberPreviewProject({ ...currentPreview, path: movedPreviewPath });
        }
      }
      context.getWorkspace().moveProjectPaths(getHostedProjectPathMoveInputs(moves));
    }

    let persistedProjectStateChanged = false;
    for (const update of updates) {
      context.openedProjectPathAliases.set(normalizeWorkflowPath(update.binding.path), update.projectId);
      const updated = await context.getWorkspace().updateProjectMetadata(
        update.projectId,
        { title: update.binding.title },
        {
          path: update.binding.path,
          persistedExternally: true,
          changeSource: 'external-wrapper-rename',
        },
      );
      persistedProjectStateChanged ||= updated;
    }
    if (persistedProjectStateChanged) {
      await flushHybridStorageGroup('project');
    }
  } finally {
    postMessageToDashboard({
      type: 'workflow-project-bindings-reconciled',
      changes,
      contentChanges,
      requestId: command.requestId,
    });
  }
}

export async function handleResolveWorkflowProjectContentChangeCommand(
  context: EditorCommandBridgeContext,
  command: Extract<DashboardToEditorCommand, { type: 'resolve-workflow-project-content-change' }>,
): Promise<void> {
  let resolved = false;
  let error: string | undefined;

  try {
    const openedProject = context.getProjects().openedProjects[command.projectId as ProjectId];
    if (!openedProject || normalizeWorkflowPath(openedProject.fsPath ?? '') !== normalizeWorkflowPath(command.path)) {
      throw new Error('The project is no longer open at this location.');
    }

    if (command.resolution === 'keep-local') {
      resolved = acceptHostedProjectRemoteRevision(command.projectId, command.path, command.revisionId);
      if (!resolved) {
        throw new Error('A newer remote version is available. Review the updated notification before saving.');
      }
    } else {
      if (getHostedProjectPendingRevision(command.projectId) !== command.revisionId) {
        throw new Error('A newer remote version is available. Review the updated notification before saving.');
      }
      const refreshed = await handleRefreshOpenProjectCommand(context, { type: 'refresh-open-project-from-disk', path: command.path });
      if (!refreshed) {
        throw new Error('Could not reload the latest saved project.');
      }
      const pendingAfterReload = getHostedProjectPendingRevision(command.projectId);
      if (pendingAfterReload === command.revisionId) {
        if (!acceptHostedProjectRemoteRevision(command.projectId, command.path, command.revisionId)) {
          throw new Error('A newer remote version is available. Review the updated notification before saving.');
        }
      } else if (pendingAfterReload) {
        throw new Error('A newer remote version is available. Review the updated notification before saving.');
      }
      resolved = true;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  postMessageToDashboard({
    type: 'workflow-project-content-change-resolved',
    projectId: command.projectId,
    revisionId: command.revisionId,
    resolution: command.resolution,
    resolved,
    ...(error ? { error } : {}),
    requestId: command.requestId,
  });
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
