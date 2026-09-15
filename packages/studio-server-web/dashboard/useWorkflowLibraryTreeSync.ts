import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { toast } from 'react-toastify';

import type {
  WorkflowProjectItem,
  WorkflowTreeChangeEvent,
  WorkflowTreeResponse,
  WorkflowTreeSyncState,
} from './types';
import type {
  WorkflowProjectBindingReconciliation,
  WorkflowProjectBindingReconciliationResult,
  HostedProjectReconciliationContext,
} from '../../studio-server-shared/editor-bridge';
import type { WorkflowProjectEditorBinding } from '../../studio-server-shared/workflow-types';
import { isHostedVirtualProjectPath } from './openedProjectMetadata';
import { getWorkflowTreeClientId, openWorkflowTreeEventStream } from './workflowApi';
import { flattenProjects, normalizeWorkflowPath } from './workflowLibraryHelpers';

const REMOTE_TREE_REFRESH_RETRY_DELAY_MS = 2_000;

type PendingTreeChange = {
  state: WorkflowTreeSyncState;
  force: boolean;
};

type OpenedProjectReference = Pick<WorkflowProjectItem, 'absolutePath' | 'name' | 'projectMetadataId'>;

function isNewerTreeState(next: WorkflowTreeSyncState, current: WorkflowTreeSyncState | null): boolean {
  return current == null || next.epoch !== current.epoch || next.revision > current.revision;
}

function createOpenedProjectReference(absolutePath: string): OpenedProjectReference | null {
  const trimmedPath = absolutePath.trim();
  if (!trimmedPath) {
    return null;
  }

  const fileName = trimmedPath.split(/[\\/]/).at(-1) ?? trimmedPath;
  const name = fileName.endsWith('.rivet-project') ? fileName.slice(0, -'.rivet-project'.length) : fileName;
  return { absolutePath: trimmedPath, name };
}

function isProjectStillInTree(project: OpenedProjectReference, tree: WorkflowTreeResponse): boolean {
  return [...tree.projects, ...flattenProjects(tree.folders)].some(
    (candidate) => candidate.absolutePath === project.absolutePath,
  );
}

function findMovedProject(project: OpenedProjectReference, tree: WorkflowTreeResponse): WorkflowProjectItem | null {
  if (!project.projectMetadataId) {
    return null;
  }

  return (
    [...tree.projects, ...flattenProjects(tree.folders)].find(
      (candidate) => candidate.projectMetadataId === project.projectMetadataId,
    ) ?? null
  );
}

function getWorkflowProjectEditorBindings(tree: WorkflowTreeResponse): WorkflowProjectEditorBinding[] {
  return [...tree.projects, ...flattenProjects(tree.folders)].flatMap((project) =>
    project.projectMetadataId
      ? [
          {
            projectId: project.projectMetadataId,
            path: project.absolutePath,
            title: project.name,
            revisionId: project.revisionId,
          },
        ]
      : [],
  );
}

/**
 * Keeps the dashboard's tree current across browser sessions without treating
 * a tree mutation as permission to reload a user's open editor document.
 */
export function useWorkflowLibraryTreeSync(options: {
  currentSyncRef: MutableRefObject<WorkflowTreeSyncState | null>;
  isLocalTreeInteractionActive: boolean;
  openedProjectPath: string;
  openedProjectRef: MutableRefObject<WorkflowProjectItem | null>;
  editorReady: boolean;
  reconciliationSequence: number;
  captureReconciliation: () => Promise<HostedProjectReconciliationContext | null>;
  refreshFromRemoteChange: () => Promise<WorkflowTreeResponse | null>;
  reconcileProjectBindings: (
    bindings: WorkflowProjectEditorBinding[],
    context: HostedProjectReconciliationContext,
  ) => Promise<WorkflowProjectBindingReconciliationResult>;
}) {
  const currentSyncRef = options.currentSyncRef;
  const interactionActiveRef = useRef(options.isLocalTreeInteractionActive);
  const openedProjectRef = options.openedProjectRef;
  const pendingChangeRef = useRef<PendingTreeChange | null>(null);
  const refreshInFlightRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const receivedInitialStateRef = useRef(false);
  const lastOpenProjectNoticeRef = useRef<string | null>(null);
  const drainRef = useRef<() => void>(() => {});
  const lifetimeRef = useRef(0);

  interactionActiveRef.current = options.isLocalTreeInteractionActive;

  const showOpenProjectNotice = useCallback(
    (
      before: OpenedProjectReference,
      tree: WorkflowTreeResponse,
      reconciledChanges: WorkflowProjectBindingReconciliation[],
    ) => {
      const reconciledChange = reconciledChanges.find(
        (change) =>
          (before.projectMetadataId && change.projectId === before.projectMetadataId) ||
          normalizeWorkflowPath(change.fromPath) === normalizeWorkflowPath(before.absolutePath),
      );
      if (reconciledChange) {
        const noticeKey = `${reconciledChange.projectId}:${reconciledChange.toPath}`;
        if (lastOpenProjectNoticeRef.current === noticeKey) {
          return;
        }
        lastOpenProjectNoticeRef.current = noticeKey;

        const isRename = reconciledChange.fromTitle !== reconciledChange.toTitle;
        toast.info(
          isRename
            ? `"${reconciledChange.fromTitle}" was renamed to "${reconciledChange.toTitle}" on the server. Your editor tab now follows the renamed project.`
            : `"${reconciledChange.toTitle}" was moved on the server. Your editor tab now follows the new location.`,
        );
        return;
      }

      if (isProjectStillInTree(before, tree)) {
        if (lastOpenProjectNoticeRef.current === before.absolutePath) {
          lastOpenProjectNoticeRef.current = null;
        }
        return;
      }

      const movedProject = findMovedProject(before, tree);
      const noticeKey = movedProject?.projectMetadataId
        ? `${movedProject.projectMetadataId}:${movedProject.absolutePath}`
        : before.absolutePath;
      if (lastOpenProjectNoticeRef.current === noticeKey) {
        return;
      }
      lastOpenProjectNoticeRef.current = noticeKey;

      const changeDescription = movedProject
        ? `"${before.name}" was moved or renamed on the server.`
        : `"${before.name}" no longer appears in the project tree.`;
      toast.info(`${changeDescription} It remains open unchanged in the editor.`);
    },
    [],
  );

  const drain = useCallback(() => {
    if (refreshInFlightRef.current || interactionActiveRef.current || !options.editorReady) {
      return;
    }

    const pending = pendingChangeRef.current;
    if (!pending || (!pending.force && !isNewerTreeState(pending.state, currentSyncRef.current))) {
      pendingChangeRef.current = null;
      return;
    }

    pendingChangeRef.current = null;
    refreshInFlightRef.current = true;
    // Replays and published-version previews are detached, read-only editor
    // documents. They are deliberately absent from the workflow tree, so a
    // normal remote tree change must not be described as their deletion.
    const openedProjectBeforeRefresh = !isHostedVirtualProjectPath(options.openedProjectPath)
      ? openedProjectRef.current ?? createOpenedProjectReference(options.openedProjectPath)
      : null;

    const retry = () => {
      if (lifetimeRef.current !== lifetime) return;
      pendingChangeRef.current ??= { ...pending, force: true };
      if (retryTimerRef.current == null) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          drainRef.current();
        }, REMOTE_TREE_REFRESH_RETRY_DELAY_MS);
      }
    };
    const lifetime = lifetimeRef.current;
    void options
      .captureReconciliation()
      .then(async (context) => {
        if (lifetimeRef.current !== lifetime) return;
        if (!context) {
          retry();
          return;
        }
        const tree = await options.refreshFromRemoteChange();
        if (lifetimeRef.current !== lifetime) return;
        if (!tree) {
          retry();
          return;
        }
        return options
          .reconcileProjectBindings(getWorkflowProjectEditorBindings(tree), context)
          .then((reconciled) => {
            if (lifetimeRef.current !== lifetime) return;
            if (reconciled.status === 'retry') retry();
            // A remote mutation can affect an inactive tab too. Surface each
            // actual ID-based rebind once rather than only inspecting the
            // currently active project reference.
            for (const reconciledChange of reconciled.changes) {
              showOpenProjectNotice(
                {
                  absolutePath: reconciledChange.fromPath,
                  name: reconciledChange.fromTitle,
                  projectMetadataId: reconciledChange.projectId,
                },
                tree,
                [reconciledChange],
              );
            }
            if (openedProjectBeforeRefresh && reconciled.status === 'applied') {
              showOpenProjectNotice(
                openedProjectBeforeRefresh,
                tree,
                reconciled.changes,
              );
            }
          })
          .catch((error) => {
            console.error('Failed to reconcile open workflow project bindings:', error);
            retry();
          });
      })
      .then(() => {
        const nextPending = pendingChangeRef.current;
        if (nextPending && !nextPending.force && !isNewerTreeState(nextPending.state, currentSyncRef.current)) {
          pendingChangeRef.current = null;
        }
      })
      .catch(() => retry())
      .finally(() => {
        if (lifetimeRef.current !== lifetime) return;
        refreshInFlightRef.current = false;
        if (pendingChangeRef.current && retryTimerRef.current == null) {
          drainRef.current();
        }
      });
  }, [currentSyncRef, openedProjectRef, options, showOpenProjectNotice]);

  drainRef.current = drain;

  const enqueue = useCallback((pending: PendingTreeChange) => {
    const current = pendingChangeRef.current;
    if (!current || isNewerTreeState(pending.state, current.state) || (pending.force && !current.force)) {
      pendingChangeRef.current = pending;
    }
    drainRef.current();
  }, []);

  useEffect(() => {
    if (!options.isLocalTreeInteractionActive) {
      drainRef.current();
    }
  }, [options.isLocalTreeInteractionActive]);

  useEffect(() => {
    const currentState = currentSyncRef.current;
    if (options.editorReady && currentState) {
      // Tree events can arrive before the iframe finishes its bridge handshake.
      // Replaying the current authoritative state here ensures an open tab is
      // still rebound instead of leaving a stale path until another mutation.
      enqueue({ state: currentState, force: true });
    }
  }, [currentSyncRef, enqueue, options.editorReady, options.reconciliationSequence]);

  useEffect(() => {
    lifetimeRef.current++;
    refreshInFlightRef.current = false;
    const stream = openWorkflowTreeEventStream({
      onState: (state) => {
        const force = !receivedInitialStateRef.current;
        receivedInitialStateRef.current = true;
        enqueue({ state, force });
      },
      onChange: (event: WorkflowTreeChangeEvent) => {
        if (event.sourceClientId === getWorkflowTreeClientId()) {
          return;
        }
        // The latest tree fetch may already have advanced the sync marker while
        // a local tree gesture was active. Keep this remote event as a forced
        // reconciliation so that update cannot be silently skipped.
        enqueue({ state: event, force: true });
      },
    });

    return () => {
      lifetimeRef.current++;
      stream?.close();
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [enqueue]);
}
