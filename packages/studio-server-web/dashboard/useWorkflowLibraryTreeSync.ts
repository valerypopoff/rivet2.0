import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { toast } from 'react-toastify';

import type {
  WorkflowProjectItem,
  WorkflowTreeChangeEvent,
  WorkflowTreeResponse,
  WorkflowTreeSyncState,
} from './types';
import type { WorkflowProjectBindingReconciliation } from '../../studio-server-shared/editor-bridge';
import type { WorkflowProjectEditorBinding } from '../../studio-server-shared/workflow-types';
import { getWorkflowTreeClientId, openWorkflowTreeEventStream } from './workflowApi';
import { flattenProjects, normalizeWorkflowPath } from './workflowLibraryHelpers';

const REMOTE_TREE_REFRESH_RETRY_DELAY_MS = 2_000;

type PendingTreeChange = {
  kind: 'state' | 'change';
  state: WorkflowTreeSyncState;
  sourceClientId: string | null;
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
  refreshFromRemoteChange: () => Promise<WorkflowTreeResponse | null>;
  reconcileProjectBindings: (
    bindings: WorkflowProjectEditorBinding[],
  ) => Promise<WorkflowProjectBindingReconciliation[]>;
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

  interactionActiveRef.current = options.isLocalTreeInteractionActive;

  const showOpenProjectNotice = useCallback(
    (
      before: OpenedProjectReference,
      tree: WorkflowTreeResponse,
      reconciledChanges: WorkflowProjectBindingReconciliation[],
      changeCameFromAnotherBrowser: boolean,
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
        const actor = changeCameFromAnotherBrowser
          ? 'by another administrator'
          : 'while this dashboard was reconnecting';
        toast.info(
          isRename
            ? `"${reconciledChange.fromTitle}" was renamed to "${reconciledChange.toTitle}" ${actor}. Your editor tab now follows the renamed project.`
            : `"${reconciledChange.toTitle}" was moved ${actor}. Your editor tab now follows the new location.`,
        );
        return;
      }

      if (isProjectStillInTree(before, tree)) {
        if (lastOpenProjectNoticeRef.current === before.absolutePath) {
          lastOpenProjectNoticeRef.current = null;
        }
        return;
      }

      const noticeKey = before.absolutePath;
      if (lastOpenProjectNoticeRef.current === noticeKey) {
        return;
      }
      lastOpenProjectNoticeRef.current = noticeKey;

      const movedProject = findMovedProject(before, tree);
      const changeDescription = changeCameFromAnotherBrowser
        ? movedProject
          ? `"${before.name}" was moved or renamed by another administrator.`
          : `"${before.name}" was removed by another administrator.`
        : movedProject
          ? `"${before.name}" was moved or renamed while this dashboard was reconnecting.`
          : `"${before.name}" no longer appears in the project tree after reconnecting.`;
      toast.info(`${changeDescription} It remains open unchanged in the editor.`);
    },
    [],
  );

  const drain = useCallback(() => {
    if (refreshInFlightRef.current || interactionActiveRef.current) {
      return;
    }

    const pending = pendingChangeRef.current;
    if (!pending || (!pending.force && !isNewerTreeState(pending.state, currentSyncRef.current))) {
      pendingChangeRef.current = null;
      return;
    }

    pendingChangeRef.current = null;
    refreshInFlightRef.current = true;
    const openedProjectBeforeRefresh =
      openedProjectRef.current ?? createOpenedProjectReference(options.openedProjectPath);

    void options
      .refreshFromRemoteChange()
      .then((tree) => {
        if (!tree) {
          pendingChangeRef.current = pending;
          if (retryTimerRef.current == null) {
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              drainRef.current();
            }, REMOTE_TREE_REFRESH_RETRY_DELAY_MS);
          }
          return;
        }

        return options
          .reconcileProjectBindings(getWorkflowProjectEditorBindings(tree))
          .then((reconciledChanges) => {
            // A remote mutation can affect an inactive tab too. Surface each
            // actual ID-based rebind once rather than only inspecting the
            // currently active project reference.
            for (const reconciledChange of reconciledChanges) {
              showOpenProjectNotice(
                {
                  absolutePath: reconciledChange.fromPath,
                  name: reconciledChange.fromTitle,
                  projectMetadataId: reconciledChange.projectId,
                },
                tree,
                [reconciledChange],
                pending.kind === 'change' && pending.sourceClientId !== getWorkflowTreeClientId(),
              );
            }
            if (openedProjectBeforeRefresh) {
              showOpenProjectNotice(
                openedProjectBeforeRefresh,
                tree,
                reconciledChanges,
                pending.kind === 'change' && pending.sourceClientId !== getWorkflowTreeClientId(),
              );
            }
          })
          .catch((error) => {
            console.error('Failed to reconcile open workflow project bindings:', error);
          });
      })
      .then(() => {
        const nextPending = pendingChangeRef.current;
        if (nextPending && !nextPending.force && !isNewerTreeState(nextPending.state, currentSyncRef.current)) {
          pendingChangeRef.current = null;
        }
      })
      .finally(() => {
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
      enqueue({ kind: 'state', state: currentState, sourceClientId: null, force: true });
    }
  }, [currentSyncRef, enqueue, options.editorReady]);

  useEffect(() => {
    const stream = openWorkflowTreeEventStream({
      onState: (state) => {
        const force = !receivedInitialStateRef.current;
        receivedInitialStateRef.current = true;
        enqueue({ kind: 'state', state, sourceClientId: null, force });
      },
      onChange: (event: WorkflowTreeChangeEvent) => {
        if (event.sourceClientId === getWorkflowTreeClientId()) {
          return;
        }
        // The latest tree fetch may already have advanced the sync marker while
        // a local tree gesture was active. Keep this remote event as a forced
        // reconciliation so that update cannot be silently skipped.
        enqueue({ kind: 'change', state: event, sourceClientId: event.sourceClientId, force: true });
      },
    });

    return () => {
      stream?.close();
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [enqueue]);
}
