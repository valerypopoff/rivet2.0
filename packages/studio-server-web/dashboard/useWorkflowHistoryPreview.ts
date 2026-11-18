import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'react-toastify';
import type { DashboardToEditorCommand } from '../../studio-server-shared/editor-bridge';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  getWorkflowPublishedVersionPreviewVirtualProjectPath,
  type WorkflowHistoryPreview,
} from '../../studio-server-shared/workflow-types';
import type { EditorBridgeSession } from './editorBridgeSession';
import type { WorkflowProjectOpenOptions } from './types';
import { fetchWorkflowHistoryPreview } from './workflowApi';

export type HistoryPreviewSession = {
  id: string;
  relativePath: string;
  versionId: string;
  ownerId: string;
  preview: WorkflowHistoryPreview;
};

export function useWorkflowHistoryPreview({
  editorSession,
  postEditorCommand,
  openProject,
  pendingOpenPath,
  cancelPendingOpen,
}: {
  editorSession: EditorBridgeSession;
  postEditorCommand(command: DashboardToEditorCommand): void;
  openProject(path: string, options?: WorkflowProjectOpenOptions): void;
  pendingOpenPath: RefObject<string | null>;
  cancelPendingOpen(path: string): void;
}) {
  const [session, setSession] = useState<HistoryPreviewSession | null>(null);
  const sessionRef = useRef<HistoryPreviewSession | null>(null);
  const pending = useRef<AbortController | null>(null);

  const cancelPending = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const openArtifact = useCallback((artifactId: string, graphId?: string) => {
    const current = sessionRef.current;
    const project = current?.preview.projects.find((item) => item.artifactId === artifactId);
    if (!current || !project) return;
    const path = getWorkflowPublishedVersionPreviewVirtualProjectPath(current.relativePath, current.versionId, {
      ownerId: current.ownerId,
      artifactId,
      sessionId: current.id,
    });
    openProject(path, { title: project.name, preferredGraphId: graphId, recordGraphHistory: Boolean(graphId) });
  }, [openProject]);

  const openSubgraph = useCallback((path: string, graphId: string) => {
    const reference = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(path);
    if (reference?.artifactId && reference.sessionId === sessionRef.current?.id) {
      openArtifact(reference.artifactId, graphId);
    }
  }, [openArtifact]);

  const exit = useCallback(() => {
    cancelPending();
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (!current) return;

    const path = pendingOpenPath.current;
    const reference = path && getWorkflowPublishedVersionPreviewFromVirtualProjectPath(path);
    if (path && reference && reference.sessionId === current.id) cancelPendingOpen(path);
    postEditorCommand({ type: 'close-history-preview', sessionId: current.id });
  }, [cancelPending, pendingOpenPath, cancelPendingOpen, postEditorCommand]);

  const open = useCallback(
    (relativePath: string, versionId: string, options?: { replaceCurrent?: boolean }) => {
      if (options?.replaceCurrent) {
        cancelPending();
        postEditorCommand({ type: 'open-published-version-preview', relativePath, versionId, replaceCurrent: true });
        return;
      }
      exit();
      const controller = new AbortController();
      pending.current = controller;
      void fetchWorkflowHistoryPreview(relativePath, versionId, { signal: controller.signal })
        .then((preview) => {
          if (controller.signal.aborted) return;
          const root = preview.projects.find((item) => item.artifactId === preview.rootArtifactId);
          if (!root) throw new Error('The endpoint revision is unavailable.');
          const next = { id: editorSession.nextId('history-preview'), relativePath, versionId, ownerId: root.projectId, preview };
          sessionRef.current = next;
          setSession(next);
          openArtifact(root.artifactId);
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) toast.error(error.message);
        })
        .finally(() => {
          if (pending.current === controller) pending.current = null;
        });
    },
    [cancelPending, editorSession, exit, openArtifact, postEditorCommand],
  );

  return { session, open, openArtifact, openSubgraph, exit, cancelPending };
}
