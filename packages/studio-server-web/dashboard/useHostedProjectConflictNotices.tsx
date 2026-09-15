import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import type {
  HostedProjectConflictSnapshot,
  WorkflowProjectContentChange,
} from '../../studio-server-shared/editor-bridge';

export function acceptConflictSnapshot(
  editorInstanceId: string | null,
  current: HostedProjectConflictSnapshot | null,
  next: HostedProjectConflictSnapshot,
): HostedProjectConflictSnapshot | null {
  if (
    next.editorInstanceId !== editorInstanceId ||
    (current?.editorInstanceId === editorInstanceId && next.sequence <= current.sequence)
  )
    return current;
  return next;
}

type Resolve = (change: WorkflowProjectContentChange, resolution: 'reload' | 'keep-local') => Promise<boolean>;

function ProjectConflictNotice({ change, resolve }: { change: WorkflowProjectContentChange; resolve: Resolve }) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const choose = async (resolution: 'reload' | 'keep-local') => {
    if (resolving) return;
    setResolving(true);
    setError(null);
    try {
      if (!(await resolve(change, resolution)) && active.current) {
        setError('Could not apply this choice. Review the current warning and try again.');
      }
    } catch {
      if (active.current) setError('Could not apply this choice. Please try again.');
    } finally {
      if (active.current) setResolving(false);
    }
  };
  return (
    <div className="workflow-remote-project-change-notice">
      <div className="workflow-remote-project-change-message">
        The saved version of “{change.title}” differs from the version open in this tab. Reload discards this tab’s
        changes and opens the saved version. Keep mine allows your next Save to overwrite the version shown in this
        warning.
      </div>
      <div className="workflow-remote-project-change-actions">
        <button
          type="button"
          className="workflow-remote-project-change-reload"
          disabled={resolving}
          onClick={() => void choose('reload')}
        >
          Reload and discard mine
        </button>
        <button
          type="button"
          className="workflow-remote-project-change-keep"
          disabled={resolving}
          onClick={() => void choose('keep-local')}
        >
          Keep mine
        </button>
      </div>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

/** Only complete, versioned editor snapshots own the notification lifetime. */
export function useHostedProjectConflictNotices(
  snapshot: HostedProjectConflictSnapshot | null,
  resolve: Resolve,
): void {
  const notices = useRef(new Map<string, WorkflowProjectContentChange>());
  useEffect(() => {
    const changes = snapshot?.contentChanges ?? [];
    const wanted = new Set(changes.map((change) => change.projectId));
    for (const projectId of notices.current.keys()) {
      if (!wanted.has(projectId)) {
        toast.dismiss(`workflow-project-content-change:${projectId}`);
        notices.current.delete(projectId);
      }
    }
    for (const change of changes) {
      const previous = notices.current.get(change.projectId);
      if (
        previous?.changeId === change.changeId &&
        previous.title === change.title &&
        previous.path === change.path &&
        previous.revisionId === change.revisionId
      ) continue;
      notices.current.set(change.projectId, change);
      const toastId = `workflow-project-content-change:${change.projectId}`;
      const render = <ProjectConflictNotice key={change.changeId} change={change} resolve={resolve} />;
      if (toast.isActive(toastId)) toast.update(toastId, { render });
      else toast.info(render, { toastId, autoClose: false, closeButton: false, closeOnClick: false, draggable: false });
    }
  }, [snapshot, resolve]);
  useEffect(
    () => () => {
      for (const projectId of notices.current.keys()) toast.dismiss(`workflow-project-content-change:${projectId}`);
      notices.current.clear();
    },
    [],
  );
}
