import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { toast } from 'react-toastify';

import type {
  WorkflowProjectItem,
  WorkflowTreeChangeEvent,
  WorkflowTreeResponse,
  WorkflowTreeSyncState,
} from './types';
import {
  getWorkflowTreeClientId,
  openWorkflowTreeEventStream,
} from './workflowApi';
import { flattenProjects } from './workflowLibraryHelpers';

const REMOTE_TREE_REFRESH_RETRY_DELAY_MS = 2_000;

type PendingTreeChange = {
  kind: 'state' | 'change';
  state: WorkflowTreeSyncState;
  sourceClientId: string | null;
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
  const name = fileName.endsWith('.rivet-project')
    ? fileName.slice(0, -'.rivet-project'.length)
    : fileName;
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

  return [...tree.projects, ...flattenProjects(tree.folders)].find(
    (candidate) => candidate.projectMetadataId === project.projectMetadataId,
  ) ?? null;
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
  refreshFromRemoteChange: () => Promise<WorkflowTreeResponse | null>;
}) {
  const currentSyncRef = options.currentSyncRef;
  const interactionActiveRef = useRef(options.isLocalTreeInteractionActive);
  const openedProjectRef = options.openedProjectRef;
  const pendingChangeRef = useRef<PendingTreeChange | null>(null);
  const refreshInFlightRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const lastOpenProjectNoticeRef = useRef<string | null>(null);
  const drainRef = useRef<() => void>(() => {});

  interactionActiveRef.current = options.isLocalTreeInteractionActive;

  const showOpenProjectNotice = useCallback((
    before: OpenedProjectReference,
    tree: WorkflowTreeResponse,
    changeCameFromAnotherBrowser: boolean,
  ) => {
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
    toast.info(
      `${changeDescription} It remains open unchanged in the editor.`,
    );
  }, []);

  const drain = useCallback(() => {
    if (refreshInFlightRef.current || interactionActiveRef.current) {
      return;
    }

    const pending = pendingChangeRef.current;
    if (!pending || !isNewerTreeState(pending.state, currentSyncRef.current)) {
      pendingChangeRef.current = null;
      return;
    }

    pendingChangeRef.current = null;
    refreshInFlightRef.current = true;
    const openedProjectBeforeRefresh = openedProjectRef.current
      ?? createOpenedProjectReference(options.openedProjectPath);

    void options.refreshFromRemoteChange()
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

        if (openedProjectBeforeRefresh) {
          showOpenProjectNotice(
            openedProjectBeforeRefresh,
            tree,
            pending.kind === 'change' && pending.sourceClientId !== getWorkflowTreeClientId(),
          );
        }

        const nextPending = pendingChangeRef.current;
        if (nextPending && !isNewerTreeState(nextPending.state, tree.sync)) {
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
    if (!current || isNewerTreeState(pending.state, current.state)) {
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
    const stream = openWorkflowTreeEventStream({
      onState: (state) => enqueue({ kind: 'state', state, sourceClientId: null }),
      onChange: (event: WorkflowTreeChangeEvent) => {
        if (event.sourceClientId === getWorkflowTreeClientId()) {
          return;
        }
        enqueue({ kind: 'change', state: event, sourceClientId: event.sourceClientId });
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
