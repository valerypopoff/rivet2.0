import { useCallback, useEffect, useState } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { flushWorkspaceRecovery, getWorkspaceRecoveryStorage } from '../state/storage.js';
import {
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  projectState,
  projectsState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import { graphState } from '../state/graph.js';
import { resolveProjectContentDirtyState } from '../utils/projectUnsavedChanges.js';
import { AppModalHeader } from './AppModalHeader.js';
import { startWorkspaceRecoveryRetry } from '../state/storage/workspaceRecoveryRetry.js';

const workspaceNeedsSaveState = atom((get) => {
  if (
    Object.values(get(projectUnsavedChangesState)).some(Boolean) ||
    Object.values(get(projectDataUnsavedChangesState)).some(Boolean)
  )
    return true;
  const project = get(projectState);
  if (!get(projectsState).openedProjects[project.metadata.id]) return false;
  const dirty = resolveProjectContentDirtyState(get(savedProjectContentDigestsState), {
    project,
    graph: get(graphState),
  });
  return !dirty.hasSavedDigest || dirty.isDirty;
});

/** Browser recovery is distinct from a successful project save. */
export function WorkspaceRecoveryStatus({
  initialError,
  onRetryInitialization,
  allowWorkspaceSelection = true,
}: {
  initialError?: string;
  onRetryInitialization?: () => void;
  allowWorkspaceSelection?: boolean;
}) {
  const recovery = getWorkspaceRecoveryStorage();
  const store = useStore();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [persistentFailure, setPersistentFailure] = useState(false);
  const [records, setRecords] = useState<Awaited<ReturnType<typeof recovery.listRecoveries>>>();
  const memoryOnly = !recovery.persistsAcrossReload;
  const unsavedWork = useAtomValue(workspaceNeedsSaveState);
  const needsAttention = initialError !== undefined || (unsavedWork && (memoryOnly || persistentFailure));
  const protectsUnsavedWork = useCallback(() => store.get(workspaceNeedsSaveState), [store]);

  useEffect(() => {
    setPersistentFailure(false);
    // Bootstrap failures must retry hydration, not checkpoint a partial/empty
    // workspace over the selected recovery. Live retries use current memory.
    if (initialError !== undefined) return;
    const retry = startWorkspaceRecoveryRetry(
      recovery,
      async () => {
        if (getWorkspaceRecoveryStorage() === recovery) await flushWorkspaceRecovery();
      },
      (failed) => {
        setPersistentFailure(failed);
        if (!failed && recovery.getHealth().status === 'saved' && recovery.getHealth().reloadAvailable)
          setError(undefined);
      },
    );
    const retryNow = () => retry.retryNow();
    const visibility = () => {
      if (document.visibilityState === 'visible') retry.retryNow();
    };
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      retry.stop();
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [recovery, initialError]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !recovery.retired &&
        (recovery.getHealth().status !== 'saved' || !recovery.getHealth().reloadAvailable) &&
        protectsUnsavedWork()
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const checkpoint = () => {
      if (document.visibilityState === 'hidden' && !initialError && !recovery.retired)
        void flushWorkspaceRecovery().catch(() => undefined);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', checkpoint);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', checkpoint);
    };
  }, [recovery, initialError, protectsUnsavedWork]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const message = initialError
    ? allowWorkspaceSelection
      ? 'Could not restore your previous workspace. Retry loading or choose a retained workspace.'
      : 'Could not load the editor. Retry loading when the connection or browser storage is available.'
    : memoryOnly
      ? 'Automatic recovery is unavailable in this browser. Save your projects before closing or reloading.'
      : 'Unsaved changes may not survive a reload. Save your projects before closing. We will keep retrying automatically.';

  return (
    <>
      {(needsAttention || (error !== undefined && (initialError !== undefined || unsavedWork))) && (
        <section
          aria-label="Workspace recovery"
          style={{
            position: 'fixed',
            right: 12,
            bottom: 12,
            zIndex: 1000,
            maxWidth: 440,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            background: 'var(--grey-dark)',
            color: 'var(--foreground)',
            border: '1px solid var(--grey)',
            boxShadow: '0 2px 8px #0004',
          }}
        >
          <div role="alert">{message}</div>
          {initialError && <p>{initialError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {initialError && onRetryInitialization && (
              <Button isDisabled={busy} onClick={onRetryInitialization}>
                Retry loading
              </Button>
            )}
            {!initialError && !memoryOnly && (
              <Button isDisabled={busy} onClick={() => void run(flushWorkspaceRecovery)}>
                {busy ? 'Saving recovery…' : 'Retry recovery'}
              </Button>
            )}
            {initialError && !memoryOnly && allowWorkspaceSelection && (
              <Button
                isDisabled={busy}
                onClick={() =>
                  void run(async () => {
                    setRecords(await recovery.listRecoveries());
                  })
                }
              >
                Recover workspace
              </Button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <ModalTransition>
        {records && (
          <Modal
            onClose={() => {
              if (!busy) setRecords(undefined);
            }}
            width="medium"
          >
            <AppModalHeader
              title="Recover a previous workspace"
              onClose={() => {
                if (!busy) setRecords(undefined);
              }}
            />
            <ModalBody>
              <p>
                Choose a checkpoint to reload. Current unsaved edits will be replaced. Original checkpoints are
                retained.
              </p>
              {records.length === 0 && <p>No previous checkpoints are available from this storage provider.</p>}
              {error && <p role="alert">{error}</p>}
              <div style={{ maxHeight: 240, overflow: 'auto' }}>
                {records.map((record) => (
                  <div key={record.key} style={{ marginBottom: 8 }}>
                    <Button
                      isDisabled={busy || record.invalid}
                      onClick={() => {
                        if (window.confirm('Replace this workspace with the selected recovery checkpoint?'))
                          void run(async () => {
                            await recovery.selectRecovery(record.key);
                            window.location.reload();
                          });
                      }}
                    >
                      {record.title} · {record.updatedAt ? new Date(record.updatedAt).toLocaleString() : ''}
                    </Button>
                  </div>
                ))}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                isDisabled={busy}
                onClick={() => {
                  if (window.confirm('Start an empty workspace? Existing recovery records will be retained.'))
                    void run(async () => {
                      await recovery.selectRecovery(null);
                      window.location.reload();
                    });
                }}
              >
                Start empty
              </Button>
              <Button isDisabled={busy} onClick={() => setRecords(undefined)}>
                Cancel
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </>
  );
}
