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
const jobPhases: Record<ProjectBundleJobStatus['phase'], true> = {
  collecting: true,
  packaging: true,
  ready: true,
  failed: true,
  cancelled: true,
  interrupted: true,
};
const isNonNegativeInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
async function readJobStatus(response: Response, expectedId: string): Promise<ProjectBundleJobStatus> {
  const status = await parseJsonResponse<Partial<ProjectBundleJobStatus> | null>(response);
  if (
    !status ||
    typeof status !== 'object' ||
    Array.isArray(status) ||
    status.id !== expectedId ||
    typeof status.phase !== 'string' ||
    !Object.hasOwn(jobPhases, status.phase) ||
    !isNonNegativeInteger(status.projects) ||
    !isNonNegativeInteger(status.bytes) ||
    typeof status.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(status.expiresAt)) ||
    (status.versionPolicy !== undefined && status.versionPolicy !== 'latest' && status.versionPolicy !== 'published') ||
    (status.error !== undefined && typeof status.error !== 'string') ||
    (status.archiveBytes !== undefined && !isNonNegativeInteger(status.archiveBytes)) ||
    (status.archiveHash !== undefined && typeof status.archiveHash !== 'string')
  )
    throw new Error('The server returned invalid export status. The export may still be running.');
  return status as ProjectBundleJobStatus;
}
const active = (job: ProjectBundleJobStatus | null) => job?.phase === 'collecting' || job?.phase === 'packaging';
// A download click owns cleanup and start admission across modal instances.
// The recorded stage distinguishes a start's pre-admission 404 from cleanup.
type PendingDownloadRequest = { jobId: string; stage: 'cleanup' | 'start' };
const pendingDownloads = new Map<string, PendingDownloadRequest>();
const pendingDownloadListeners = new Set<() => void>();
function subscribeToPendingDownloads(listener: () => void) {
  pendingDownloadListeners.add(listener);
  return () => {
    pendingDownloadListeners.delete(listener);
  };
}
function setPendingDownload(bundleId: string, pending: PendingDownloadRequest | null) {
  if (pending) pendingDownloads.set(bundleId, pending);
  else pendingDownloads.delete(bundleId);
  for (const listener of pendingDownloadListeners) listener();
}

export const WorkflowProjectBundleModal: FC<{ bundle: WorkflowFolderItem; isOpen: boolean; onClose(): void }> = ({
  bundle,
  isOpen,
  onClose,
}) => {
  const bundleId = bundle.bundleId!;
  const storageKey = `rivet-container-bundle:${bundleId}`;
  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const pending = useSyncExternalStore(subscribeToPendingDownloads, () => pendingDownloads.get(bundleId));
  const currentJobId = useRef(jobId);
  const [job, setJob] = useState<ProjectBundleJobStatus | null>(null);
  const latestJob = useRef<ProjectBundleJobStatus | null>(null);
  const [version, setVersion] = useState<WorkflowProjectDownloadVersion>('live');
  const versionEdited = useRef(false);
  const acceptStatus = (status: ProjectBundleJobStatus) => {
    if (status.id !== currentJobId.current) return;
    // A late POST acknowledgement must not regress progress already read by polling.
    if (
      latestJob.current?.id === status.id &&
      ((!active(latestJob.current) && active(status)) ||
        (latestJob.current.phase === 'packaging' && status.phase === 'collecting'))
    )
      return;
    latestJob.current = status;
    setJob(status);
    if (!versionEdited.current && (status.versionPolicy === 'latest' || status.versionPolicy === 'published'))
      setVersion(status.versionPolicy === 'latest' ? 'live' : 'published');
  };
  const [error, setError] = useState<{ kind: 'progress' | 'start' | 'cleanup'; message: string } | null>(null);
  const pendingDownload = useRef<string | null>(null);
  const downloadLink = useRef<HTMLAnchorElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const adoptJob = (id: string) => {
    if (id === currentJobId.current) return;
    currentJobId.current = id;
    latestJob.current = null;
    if (mounted.current) {
      setJobId(id);
      setJob(null);
      setError(null);
    }
    try {
      sessionStorage.setItem(storageKey, id);
    } catch {
      /* Modal still works without reload resume. */
    }
  };
  useEffect(() => {
    // A click may advance from cleanup to a new start after its original modal
    // unmounts. The replacement instance follows that same reserved identity.
    if (pending?.stage === 'start') adoptJob(pending.jobId);
  }, [pending]);
  useEffect(() => {
    if (!isOpen || !jobId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const previousStatus = latestJob.current;
      const pendingRequest = pendingDownloads.get(bundleId);
      const awaitingAdmission = pendingRequest?.stage === 'start' && pendingRequest.jobId === jobId && !previousStatus;
      try {
        const status = await readJobStatus(
          await request(`${endpoint}/${jobId}`, { cache: 'no-store', signal: abort.signal }),
          jobId,
        );
        if (abort.signal.aborted || currentJobId.current !== jobId) return;
        acceptStatus(status);
        // Progress can reconcile a lost start acknowledgement, but cannot
        // prove that cleanup of the previous archive succeeded.
        setError((current) => (current?.kind === 'cleanup' ? current : null));
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
          current?.kind === 'cleanup' || current?.kind === 'start'
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
  useEffect(() => {
    if (!isOpen) {
      pendingDownload.current = null;
      return;
    }
    if (job?.phase === 'ready' && pendingDownload.current === job.id && !pending && downloadLink.current) {
      // The archive remains owned until a later click disposes it. Following
      // the native link retains streaming and the server's active-reader lease.
      pendingDownload.current = null;
      downloadLink.current.click();
    }
  }, [job, isOpen, pending]);
  const download = async () => {
    if (pendingDownloads.has(bundleId) || (active(latestJob.current) && !error)) return;
    const previousId = currentJobId.current;
    const selectedVersion = version === 'live' ? 'latest' : 'published';
    let stage: PendingDownloadRequest['stage'] = previousId ? 'cleanup' : 'start';
    const id = crypto.randomUUID();
    setPendingDownload(bundleId, { jobId: previousId ?? id, stage });
    pendingDownload.current = id;
    setError(null);
    try {
      if (previousId) {
        const response = await request(`${endpoint}/${previousId}`, {
          method: 'DELETE',
          headers: { 'X-Rivet-Bundle-Intent': '1' },
        });
        if (response.status !== 204 && response.status !== 404) {
          await parseJsonResponse(response);
          throw new Error('Could not start the download. Please try again.');
        }
      }
      stage = 'start';
      setPendingDownload(bundleId, { jobId: id, stage });
      adoptJob(id); // A lost acknowledgement is reconciled by this exact ID.
      const status = await readJobStatus(
        await request(`${endpoint}/container`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' },
          body: JSON.stringify({ bundleId, version: selectedVersion, requestId: id }),
        }),
        id,
      );
      if (mounted.current) {
        acceptStatus(status);
        setError(null);
      }
    } catch (failure) {
      if (mounted.current && (stage === 'cleanup' || !latestJob.current))
        setError({
          kind: stage,
          message: failure instanceof Error ? failure.message : 'Could not download the bundle.',
        });
    } finally {
      setPendingDownload(bundleId, null);
    }
  };
  const waiting = !!pending || (!error && (active(job) || (!!jobId && !job)));
  const jobError =
    job && !active(job) && job.phase !== 'ready'
      ? job.error ?? 'Could not download the bundle. Please try again.'
      : null;
  const title = `Download bundle "${bundle.name}"`;
  if (!isOpen) return null;
  return (
    <ModalTransition>
      <ModalDialog testId="workflow-project-bundle-modal" label={title} onClose={onClose}>
        <ModalBody>
          <div className="project-settings-modal-shell workflow-project-bundle-shell">
            <div className="project-settings-modal-header-row">
              <div className="project-settings-modal-title workflow-project-bundle-title" title={title}>
                {title}
              </div>
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
              <div className="workflow-project-bundle-version">
                <span>Versions for all projects</span>
                <SegmentedControl label="Bundle versions">
                  <SegmentedControlButton
                    selected={version === 'live'}
                    disabled={waiting}
                    onClick={() => {
                      versionEdited.current = true;
                      setVersion('live');
                    }}
                  >
                    Saved latest
                  </SegmentedControlButton>
                  <SegmentedControlButton
                    selected={version === 'published'}
                    disabled={waiting}
                    onClick={() => {
                      versionEdited.current = true;
                      setVersion('published');
                    }}
                  >
                    Published if available (saved latest if no published version)
                  </SegmentedControlButton>
                </SegmentedControl>
              </div>
              {error || jobError ? (
                <p className="workflow-project-bundle-error" role="alert">
                  {error?.message ?? jobError}
                </p>
              ) : null}
            </div>
            <div className="workflow-project-bundle-footer">
              <p className="project-settings-help workflow-project-bundle-footer-help">
                Includes bundle members and dependencies outside the bundle.
              </p>
              <Button
                appearance="primary"
                className="workflow-project-bundle-action workflow-project-bundle-primary button-size-l"
                isDisabled={waiting}
                aria-busy={waiting}
                iconBefore={
                  waiting ? <span className="workflow-project-bundle-spinner" aria-hidden="true" /> : undefined
                }
                onClick={() => void download()}
              >
                Download bundle
              </Button>
              {job?.phase === 'ready' ? (
                <a ref={downloadLink} href={`${endpoint}/${job.id}/download`} hidden aria-hidden="true" tabIndex={-1} />
              ) : null}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
