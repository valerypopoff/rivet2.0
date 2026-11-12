import { useEffect, useRef, useState, useSyncExternalStore, type FC } from 'react';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import Button from '@atlaskit/button';
import type { ProjectBundleJobStatus } from '../../studio-server-shared/project-bundle-types';
import type { WorkflowProjectDownloadVersion, WorkflowFolderItem } from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { parseJsonResponse } from './apiRequest';
import './WorkflowProjectBundleModal.css';

const endpoint = '/api/workflows/project-bundles';
function request(url: string, options: RequestInit = {}) {
  const deadline = AbortSignal.timeout(20_000);
  return fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
}
const active = (job: ProjectBundleJobStatus | null) => job?.phase === 'collecting' || job?.phase === 'packaging';
// Start requests can outlive a modal instance when the user switches bundles.
// Entries exist only until their original request settles (including timeout).
const pendingStarts = new Set<string>();
const pendingStartListeners = new Set<() => void>();
function subscribeToPendingStarts(listener: () => void) {
  pendingStartListeners.add(listener);
  return () => {
    pendingStartListeners.delete(listener);
  };
}
function setStartPending(id: string, pending: boolean) {
  if (pending) pendingStarts.add(id);
  else pendingStarts.delete(id);
  for (const listener of pendingStartListeners) listener();
}

export const WorkflowProjectBundleModal: FC<{ bundle: WorkflowFolderItem; isOpen: boolean; onClose(): void }> = ({
  bundle,
  isOpen,
  onClose,
}) => {
  const storageKey = `rivet-container-bundle:${bundle.bundleId}`;
  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const startPending = useSyncExternalStore(subscribeToPendingStarts, () => !!jobId && pendingStarts.has(jobId));
  const currentJobId = useRef(jobId);
  const [job, setJob] = useState<ProjectBundleJobStatus | null>(null);
  const latestJob = useRef<ProjectBundleJobStatus | null>(null);
  const acceptStatus = (status: ProjectBundleJobStatus | null) => {
    if (status && status.id !== currentJobId.current) return;
    // A late POST acknowledgement must not regress progress already read by polling.
    if (
      status &&
      latestJob.current?.id === status.id &&
      ((!active(latestJob.current) && active(status)) ||
        (latestJob.current.phase === 'packaging' && status.phase === 'collecting'))
    )
      return;
    latestJob.current = status;
    setJob(status);
    if (status?.versionPolicy === 'latest' || status?.versionPolicy === 'published')
      setVersion(status.versionPolicy === 'latest' ? 'live' : 'published');
  };
  const [version, setVersion] = useState<WorkflowProjectDownloadVersion>('live');
  const [error, setError] = useState<{ kind: 'progress' | 'prepare' | 'cancel'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remember = (id: string | null) => {
    currentJobId.current = id;
    setJobId(id);
    try {
      if (id) sessionStorage.setItem(storageKey, id);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Modal still works without reload resume. */
    }
  };
  useEffect(() => {
    if (!isOpen || !jobId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const previousStatus = latestJob.current;
      const awaitingAdmission = pendingStarts.has(jobId) && !previousStatus;
      try {
        const status = await parseJsonResponse<ProjectBundleJobStatus>(
          await request(`${endpoint}/${jobId}`, { cache: 'no-store', signal: abort.signal }),
        );
        if (abort.signal.aborted || currentJobId.current !== jobId) return;
        acceptStatus(status);
        // Progress can reconcile a lost start acknowledgement, but cannot
        // prove that an independently requested cancellation succeeded.
        setError((current) => (current?.kind === 'cancel' ? current : null));
        if (active(latestJob.current)) timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (abort.signal.aborted || currentJobId.current !== jobId) return;
        // A start acknowledgement can arrive while this older status read is
        // failing. Keep its newer status instead of displaying a stale error.
        if (latestJob.current !== previousStatus) {
          if (active(latestJob.current)) timer = setTimeout(() => void poll(), 1000);
          return;
        }
        // The client reserves its ID before POST; the server registers it
        // asynchronously. A pre-admission 404 is pending, not a failed export.
        if (awaitingAdmission && failure instanceof Error && 'status' in failure && failure.status === 404) {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        setError((current) =>
          current?.kind === 'cancel' || current?.kind === 'prepare'
            ? current
            : {
                kind: 'progress',
                message: failure instanceof Error ? failure.message : 'Could not read export progress.',
              },
        );
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [jobId, isOpen]);
  const prepare = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    acceptStatus(null);
    const id = crypto.randomUUID();
    setStartPending(id, true);
    remember(id); // Known before POST, so a lost acknowledgement is recoverable by GET.
    try {
      const status = await parseJsonResponse<ProjectBundleJobStatus>(
        await request(`${endpoint}/container`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' },
          body: JSON.stringify({
            bundleId: bundle.bundleId,
            version: version === 'live' ? 'latest' : 'published',
            requestId: id,
          }),
        }),
      );
      if (mounted.current) {
        acceptStatus(status);
        setError((current) => (current?.kind === 'cancel' ? current : null));
      }
    } catch (failure) {
      if (mounted.current && !latestJob.current)
        setError({ kind: 'prepare', message: failure instanceof Error ? failure.message : 'Could not start export.' });
    } finally {
      setStartPending(id, false);
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const dispose = async () => {
    if (!jobId || actionInFlight.current || pendingStarts.has(jobId)) return false;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await request(`${endpoint}/${jobId}`, {
        method: 'DELETE',
        headers: { 'X-Rivet-Bundle-Intent': '1' },
      });
      if (!response.ok && response.status !== 404) await parseJsonResponse(response);
      if (mounted.current) {
        remember(null);
        acceptStatus(null);
        setError(null);
        return true;
      }
    } catch (failure) {
      if (mounted.current)
        setError({ kind: 'cancel', message: failure instanceof Error ? failure.message : 'Could not cancel export.' });
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
    return false;
  };
  const retry = async () => {
    if (await dispose()) await prepare();
  };
  const preparing = active(job) || (!!jobId && !job && !error);
  if (!isOpen) return null;
  return (
    <ModalTransition>
      <ModalDialog testId="workflow-project-bundle-modal" label="Download bundle" onClose={onClose}>
        <ModalBody>
          <div className="project-settings-modal-shell workflow-project-bundle-shell">
            <div className="project-settings-modal-header-row">
              <div className="project-settings-modal-title">Download bundle</div>
              <button
                type="button"
                className="project-settings-close-button"
                aria-label="Close bundle download"
                onClick={onClose}
              >
                ×
              </button>
            </div>
            <div className="project-settings-modal-content workflow-project-bundle-content">
              <section className="workflow-project-bundle-card" aria-labelledby="bundle-project-heading">
                <h3 id="bundle-project-heading">{bundle.name}</h3>
                <p className="project-settings-help">
                  Includes bundle members and dependencies outside the bundle. Unsaved editor changes are excluded.
                </p>
                {!jobId ? (
                  <div className="workflow-project-bundle-version">
                    <span>Versions for all projects</span>
                    <SegmentedControl label="Bundle versions">
                      <SegmentedControlButton
                        selected={version === 'published'}
                        disabled={busy}
                        onClick={() => setVersion('published')}
                      >
                        Published
                      </SegmentedControlButton>
                      <SegmentedControlButton
                        selected={version === 'live'}
                        disabled={busy}
                        onClick={() => setVersion('live')}
                      >
                        Saved latest
                      </SegmentedControlButton>
                    </SegmentedControl>
                  </div>
                ) : null}
              </section>
              {jobId ? (
                <section className="workflow-project-bundle-card" aria-label="Export progress">
                  <p
                    className="project-settings-help workflow-project-bundle-progress"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {preparing ? <span className="workflow-project-bundle-spinner" aria-hidden="true" /> : null}
                    <span>
                      {job
                        ? `Export: ${job.phase}. ${job.projects} project snapshots; ${(job.bytes / 1048576).toFixed(2)} MiB captured.`
                        : 'Reading export progress…'}
                    </span>
                  </p>
                  {job?.error ? (
                    <p className="workflow-project-bundle-error" role="alert">
                      {job.error}
                    </p>
                  ) : null}
                </section>
              ) : null}
              {error ? (
                <p className="workflow-project-bundle-error" role="alert">
                  {error.message}
                  {error.kind !== 'cancel' ? ' Progress will be checked again while this window is open.' : null}
                </p>
              ) : null}
              {preparing ? (
                <p className="project-settings-help">
                  Closing this window does not cancel preparation. Reopen this bundle’s download action to check its
                  progress.
                </p>
              ) : null}
            </div>
            <div className="workflow-project-bundle-footer">
              {!jobId ? (
                <Button
                  appearance="primary"
                  className="workflow-project-bundle-action workflow-project-bundle-primary button-size-l"
                  isDisabled={busy}
                  onClick={() => void prepare()}
                >
                  Prepare bundle
                </Button>
              ) : job?.phase === 'ready' ? (
                <Button
                  appearance="primary"
                  className="workflow-project-bundle-action workflow-project-bundle-primary button-size-l"
                  href={`${endpoint}/${jobId}/download`}
                >
                  Download bundle
                </Button>
              ) : (
                <Button
                  appearance="subtle"
                  className="workflow-project-bundle-action button-size-l"
                  isDisabled={busy || startPending}
                  onClick={() => void (job && !active(job) ? retry() : dispose())}
                >
                  {active(job) || !job ? 'Cancel export' : 'Retry export'}
                </Button>
              )}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
