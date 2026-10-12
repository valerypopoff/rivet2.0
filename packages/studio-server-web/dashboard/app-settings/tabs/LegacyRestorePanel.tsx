import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import { RIVET_API_BASE_URL } from '../../../../studio-server-shared/hosted-env';

type Operation = {
  id: string;
  phase: string;
  destructive: boolean;
  archiveDigest?: string;
  message: string;
  backupCreatedAt?: string;
  projects?: number;
  recordings?: number;
  destinationProjects?: number;
  destinationRecordings?: number;
};
type Status = { available: boolean; reason?: string; operation?: Operation | null };
const headers = { 'X-Rivet-Migration-Intent': '1' };

export function LegacyRestorePanel() {
  const [status, setStatus] = useState<Status>();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutating = useRef(false);
  const endpoint = `${RIVET_API_BASE_URL}/legacy-restore`;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const captured = generation.current;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      try {
        const response = await fetch(endpoint, {
          credentials: 'include',
          signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Restore status is temporarily unavailable. Reconnecting…');
        const value = (await response.json()) as Status;
        if (mounted.current && captured === generation.current && !mutating.current) {
          setStatus(value);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted && mounted.current && captured === generation.current && !mutating.current)
          setError(signal.aborted ? 'Restore status timed out. Reconnecting…' : (error as Error).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);
  const request = async (action: string, body: BodyInit, type: string) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setBusy(true);
    setError('');
    // Uploads use the server's one-hour receive window; small control requests must not freeze status recovery.
    const signal = action === 'upload' ? undefined : AbortSignal.timeout(60_000);
    try {
      const response = await fetch(`${endpoint}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...headers, 'Content-Type': type },
        body,
        signal,
      });
      const value = (await response.json()) as Status & { error?: string };
      if (!response.ok) throw new Error(value.error || 'Restore request could not be accepted.');
      if (mounted.current) {
        setStatus({ available: true, ...value });
        setConfirmation('');
      }
      if (action === 'start' && !new URLSearchParams(window.location.search).has('restore-legacy-backup'))
        window.location.assign('/?restore-legacy-backup');
    } catch (error) {
      if (mounted.current)
        setError(
          signal?.aborted
            ? 'The request timed out. It may already be accepted; reconnecting to restore status.'
            : (error as Error).message,
        );
    } finally {
      generation.current++;
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const operation = status?.operation;
  useEffect(() => {
    if (
      operation &&
      (['draining', 'clearing', 'importing', 'verifying', 'restarting'].includes(operation.phase) ||
        (operation.phase === 'failed' && operation.destructive)) &&
      !new URLSearchParams(window.location.search).has('restore-legacy-backup')
    )
      window.location.assign('/?restore-legacy-backup');
  }, [operation?.phase, operation?.destructive]);
  const action = (name: string) =>
    void request(
      name,
      JSON.stringify({
        id: operation?.id,
        ...(name === 'start' ? { archiveDigest: operation?.archiveDigest, confirmation } : {}),
      }),
      'application/json',
    );
  return (
    <section className="app-settings-section" aria-label="Restore legacy backup">
      <h3>Restore legacy backup</h3>
      <p>
        This replaces this Rivet installation’s application data with a legacy backup. Database/S3 connections,
        deployment secrets and current administrator access are preserved. Unrelated data is never deleted.
      </p>
      {!status ? (
        <p>Checking restore availability…</p>
      ) : !status.available ? (
        <p>{status.reason}</p>
      ) : (
        <>
          <p>
            Use the original gzip tar archive. UI environment variables, workflows and published endpoint paths are
            restored. Imported schedules stay disabled. No manual migration commands are needed.
          </p>
          {(!operation || ['completed', 'cancelled'].includes(operation.phase)) && (
            <label>
              Select legacy backup{' '}
              <input
                aria-label="Legacy backup archive"
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void request('upload', file, 'application/gzip');
                }}
              />
            </label>
          )}
          {busy && <p role="status">Sending restore request…</p>}
          {operation && (
            <div aria-live="polite">
              <p>{operation.message}</p>
              {operation.backupCreatedAt && (
                <p>
                  Backup: {new Date(operation.backupCreatedAt).toLocaleString()} · {operation.projects} projects ·{' '}
                  {operation.recordings} recordings
                </p>
              )}
              {operation.phase === 'awaiting-confirmation' && (
                <>
                  {operation.destinationProjects !== undefined && (
                    <p>
                      To replace: {operation.destinationProjects} current projects · {operation.destinationRecordings}{' '}
                      current recordings.
                    </p>
                  )}
                  <p>
                    Current application data will be permanently deleted. There is no automatic backup or merge. Only
                    catalog-referenced objects are removed; unreferenced objects and historical S3 versions are
                    preserved. Runtime-library archives are retained because they may be shared; their catalog is
                    replaced.
                  </p>
                  <TextField
                    aria-label="Restore confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.currentTarget.value)}
                    placeholder="RESTORE LEGACY BACKUP"
                    isDisabled={busy}
                  />
                  <Button
                    appearance="danger"
                    isDisabled={busy || confirmation !== 'RESTORE LEGACY BACKUP'}
                    onClick={() => action('start')}
                  >
                    Restore legacy backup
                  </Button>
                </>
              )}
              {operation.phase === 'failed' && operation.destructive && (
                <Button isDisabled={busy} onClick={() => action('retry')}>
                  Retry restore
                </Button>
              )}
              {!operation.destructive &&
                ['validating', 'awaiting-confirmation', 'failed'].includes(operation.phase) && (
                  <Button isDisabled={busy} onClick={() => action('cancel')}>
                    Cancel restore
                  </Button>
                )}
              {operation.phase === 'completed' && (
                <p>
                  <a href="/">Return to projects</a>
                </p>
              )}
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
