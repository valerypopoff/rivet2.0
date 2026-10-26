import type { Dispatch, SetStateAction } from 'react';
import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectPathMove, WorkflowMoveResponse } from './types';
import { applyFolderMoveToTree, applyProjectMoveToTree } from './workflowTreeOps';
import { isRecoveredMutationResult } from './workflowNamespaceMutations';
import type { WorkflowTreeResponse } from './types';

export type LibraryMutationCompletion = (
  message: string,
  afterRead?: (tree: WorkflowTreeResponse | null) => void,
) => void;

export const requiresFreshNamespaceTree = (result: WorkflowMoveResponse): boolean =>
  result.project?.namespaceProtocol === 1 || Boolean(result.folder?.namespaceId) || isRecoveredMutationResult(result);

/** Shared result policy for drag/drop and inline rename. Authority still comes
 * from the synchronization owner's fresh, lifetime-bound reconciliation. */
export async function reconcileNamespaceMove(options: {
  result: WorkflowMoveResponse;
  sourceFolder?: WorkflowFolderItem | null;
  sourceProject?: WorkflowProjectItem;
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
  setFolders: Dispatch<SetStateAction<WorkflowFolderItem[]>>;
  setRootProjects: Dispatch<SetStateAction<WorkflowProjectItem[]>>;
  applyProjectPathMoves(moves: WorkflowProjectPathMove[]): Promise<void>;
  reconcileTree: LibraryMutationCompletion;
  afterRead?: (tree: WorkflowTreeResponse | null) => void;
}) {
  const { result } = options;
  // Receipt results acknowledge an earlier commit; another client may already
  // have moved/deleted it. Guarded operations always use the fresh-tree owner.
  const authoritative = requiresFreshNamespaceTree(result);
  const next = authoritative
    ? null
    : result.folder && options.sourceFolder
      ? applyFolderMoveToTree(options.folders, options.rootProjects, options.sourceFolder, result.folder)
      : result.project && options.sourceProject
        ? applyProjectMoveToTree(options.folders, options.rootProjects, options.sourceProject, result.project)
        : null;
  if (next) {
    options.setFolders(next.folders);
    options.setRootProjects(next.rootProjects);
  }
  // Modern responses are reconciled by immutable project ID. Applying legacy
  // path-only moves first could rebind a replacement tab that reused a path.
  try {
    if (!authoritative) await options.applyProjectPathMoves(result.movedProjectPaths);
  } catch (cause) {
    throw new Error('The change was saved on the server, but editor tabs could not follow it. Refresh the library.', {
      cause,
    });
  } finally {
    options.reconcileTree('The change was saved, but the library could not be refreshed.', options.afterRead);
  }
}
