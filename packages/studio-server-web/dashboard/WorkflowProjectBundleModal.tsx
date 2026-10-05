import { useEffect, useRef, useState, type FC } from 'react';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import type { ProjectBundleJobStatus } from '../../studio-server-shared/project-bundle-types';
import type { WorkflowProjectDownloadVersion, WorkflowProjectItem } from './types';

const endpoint = '/api/workflows/project-bundles';
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Bundle request failed.');
  return data as T;
}
function request(url: string, options: RequestInit = {}) {
  const deadline = AbortSignal.timeout(20_000);
  return fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
}
const active = (job: ProjectBundleJobStatus | null) => job?.phase === 'collecting' || job?.phase === 'packaging';

export const WorkflowProjectBundleModal: FC<{ project: WorkflowProjectItem; isOpen: boolean; onClose(): void }> = ({
  project,
  isOpen,
  onClose,
}) => {
  const storageKey = `rivet-project-bundle:${project.id}`;
  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const currentJobId = useRef(jobId);
  const [job, setJob] = useState<ProjectBundleJobStatus | null>(null);
  const latestJob = useRef<ProjectBundleJobStatus | null>(null);
  const acceptStatus = (status: ProjectBundleJobStatus | null) => {
    if (status && status.id !== currentJobId.current) return;
    // A late POST acknowledgement must not regress a terminal result already read by polling.
    if (status && latestJob.current?.id === status.id && !active(latestJob.current) && active(status)) return;
    latestJob.current = status;
    setJob(status);
  };
  const [version, setVersion] = useState<WorkflowProjectDownloadVersion>(
    project.settings.status === 'unpublished' ? 'live' : 'published',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      try {
        const status = await responseJson<ProjectBundleJobStatus>(
          await request(`${endpoint}/${jobId}`, { cache: 'no-store', signal: abort.signal }),
        );
        if (abort.signal.aborted || currentJobId.current !== jobId) return;
        acceptStatus(status);
        setError(null);
        if (active(status)) timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (abort.signal.aborted || currentJobId.current !== jobId) return;
        setError(failure instanceof Error ? failure.message : 'Could not read export progress.');
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
    if (busy) return;
    setBusy(true);
    setError(null);
    acceptStatus(null);
    const id = crypto.randomUUID();
    remember(id); // Known before POST, so a lost acknowledgement is recoverable by GET.
    try {
      const status = await responseJson<ProjectBundleJobStatus>(
        await request(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relativePath: project.relativePath,
            version:
              project.settings.status === 'unpublished_changes'
                ? version
                : project.settings.status === 'unpublished'
                  ? 'live'
                  : 'published',
            requestId: id,
          }),
        }),
      );
      if (mounted.current) acceptStatus(status);
    } catch (failure) {
      if (mounted.current && !latestJob.current)
        setError(failure instanceof Error ? failure.message : 'Could not start export.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const dispose = async () => {
    if (!jobId || busy) return false;
    setBusy(true);
    try {
      const response = await request(`${endpoint}/${jobId}`, {
        method: 'DELETE',
        headers: { 'X-Rivet-Bundle-Intent': '1' },
      });
      if (!response.ok && response.status !== 404) await responseJson(response);
      if (mounted.current) {
        remember(null);
        acceptStatus(null);
        setError(null);
        return true;
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not cancel export.');
    } finally {
      if (mounted.current) setBusy(false);
    }
    return false;
  };
  const retry = async () => {
    if (await dispose()) await prepare();
  };
  if (!isOpen) return null;
  return (
    <ModalTransition>
      <ModalDialog
        testId="workflow-project-bundle-modal"
        label="Download with dependencies"
        width="medium"
        onClose={onClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell">
            <div className="project-settings-modal-header-row">
              <div className="project-settings-modal-title">Download with dependencies</div>
              <button
                type="button"
                className="project-settings-close-button"
                aria-label="Close bundle download"
                onClick={onClose}
              >
                ×
              </button>
            </div>
            <div className="project-settings-modal-content">
              <p>{project.name}</p>
              <p className="project-settings-help">
                Includes saved projects, their dependencies and datasets. Unsaved editor changes are excluded. Project
                files and datasets may contain sensitive values. Credentials and server settings are not copied
                separately.
              </p>
              {!jobId ? (
                <>
                  {project.settings.status === 'unpublished_changes' ? (
                    <label>
                      Root version{' '}
                      <select
                        aria-label="Bundle root version"
                        value={version}
                        onChange={(event) => setVersion(event.target.value as WorkflowProjectDownloadVersion)}
                      >
                        <option value="published">Published</option>
                        <option value="live">Saved latest (unpublished changes)</option>
                      </select>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="project-settings-primary-button button-size-l"
                    disabled={busy}
                    onClick={() => void prepare()}
                  >
                    Prepare bundle
                  </button>
                </>
              ) : (
                <>
                  <p role="status">
                    {job
                      ? `Export: ${job.phase}. ${job.projects} project snapshots; ${(job.bytes / 1048576).toFixed(2)} MiB captured.`
                      : 'Reading export progress…'}
                  </p>
                  {job?.error ? <p role="alert">{job.error}</p> : null}
                  {job?.phase === 'ready' ? (
                    <>
                      <a
                        className="project-settings-primary-button button-size-l"
                        href={`${endpoint}/${jobId}/download`}
                      >
                        Download bundle
                      </a>
                      <p className="project-settings-help">
                        Extract the ZIP and follow README.txt to run it with the Node package. Latest targets are frozen
                        at export time.
                      </p>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="project-settings-secondary-button button-size-l"
                    disabled={busy}
                    onClick={() => void (job && !active(job) && job.phase !== 'ready' ? retry() : dispose())}
                  >
                    {active(job) || !job
                      ? 'Cancel export'
                      : job.phase === 'ready'
                        ? 'Prepare another bundle'
                        : 'Retry export'}
                  </button>
                </>
              )}
              {error ? <p role="alert">{error} Progress will be checked again while this window is open.</p> : null}
              <p className="project-settings-help">
                Closing this window does not cancel preparation. Reopen this project’s download action to check its
                progress.
              </p>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
