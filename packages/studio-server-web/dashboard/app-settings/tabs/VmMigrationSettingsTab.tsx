import { useEffect, useState } from 'react';
import TextField from '@atlaskit/textfield';

import {
  acknowledgeInterruptedVmMigration,
  enterVmMigrationMode,
  leaveVmMigrationMode,
  readVmMigrationSourceInventory,
  readVmMigrationStatus,
  reviewVmMigrationDeployment,
  startVmMigration,
  startVmMigrationPrecopy,
  testVmMigrationDatabase,
  testVmMigrationObjectStorage,
  type VmMigrationStatus,
  type VmMigrationSourceInventory,
  type VmMigrationDeploymentChecks,
  type VmMigrationTarget,
} from '../../appSettingsApi';

const emptyTarget: VmMigrationTarget = {
  databaseUrl: '',
  databaseSslMode: 'require',
  bucket: '',
  endpoint: '',
  region: '',
  prefix: 'workflows/',
  forcePathStyle: false,
  accessKeyId: '',
  secretAccessKey: '',
  settingsEncryptionKey: '',
  targetOffline: false,
  runtimePlatformCompatible: false,
};

export function VmMigrationSettingsTab() {
  const [target, setTarget] = useState<VmMigrationTarget>(emptyTarget);
  const [status, setStatus] = useState<VmMigrationStatus | null>(null);
  const [inventory, setInventory] = useState<VmMigrationSourceInventory | null>(null);
  const [databaseTested, setDatabaseTested] = useState(false);
  const [objectStorageTested, setObjectStorageTested] = useState(false);
  const [precopyStale, setPrecopyStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const [interruptedStopped, setInterruptedStopped] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [reviewChecks, setReviewChecks] = useState<VmMigrationDeploymentChecks>({
    backupCompleted: false,
    deploymentSettingsMatch: false,
    functionalRehearsalPassed: false,
    externalDependenciesReviewed: false,
    rollbackWindowUnderstood: false,
  });

  const update = <K extends keyof VmMigrationTarget>(key: K, value: VmMigrationTarget[K]) => {
    setTarget((current) => ({ ...current, [key]: value }));
    if (key === 'databaseUrl' || key === 'databaseSslMode') setDatabaseTested(false);
    if (['bucket', 'endpoint', 'region', 'prefix', 'forcePathStyle', 'accessKeyId', 'secretAccessKey'].includes(key)) {
      setObjectStorageTested(false);
    }
    if (status?.job?.precopyCompleted && key !== 'targetOffline' && key !== 'runtimePlatformCompatible') {
      setPrecopyStale(true);
    }
    setError(null);
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await readVmMigrationStatus();
        if (active) setStatus(next);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not read migration status.');
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await readVmMigrationStatus());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Migration action failed.');
    } finally {
      setBusy(false);
    }
  };

  const activeJob = ['precopying', 'copying', 'verifying'].includes(status?.job?.phase ?? '');
  const verified = status?.job?.phase === 'verified';
  const requiresGateClosure =
    verified ||
    (status?.job?.phase === 'failed' &&
      (status.job.finalCopyStarted === true ||
        (status.job.finalCopyStarted === undefined && status.job.precopyCompleted === true)));
  const tested = databaseTested && objectStorageTested;
  const canRun = Boolean(
    tested &&
      status?.maintenance &&
      status.drain?.ready &&
      status.job?.precopyCompleted &&
      !precopyStale &&
      target.targetOffline &&
      !activeJob &&
      !verified &&
      status.job?.phase !== 'interrupted',
  );

  return (
    <section
      className="project-settings-tab-panel app-settings-storage-panel"
      role="tabpanel"
      aria-label="VM to managed migration"
    >
      <h3>Move this VM to managed storage</h3>
      <p className="app-settings-field-help">
        Copy projects, publications, recordings, Evaluations, runtime libraries and App Settings to a separate
        PostgreSQL database and S3 bucket. This does not switch traffic or change this VM’s active storage. Keep the
        destination Rivet API and execution pods stopped until verification and deployment review finish.
      </p>
      {!status ? (
        <p className="app-settings-field-help">
          {error ? 'Migration is unavailable to this session.' : 'Checking migration availability…'}
        </p>
      ) : !status.available ? (
        <p>
          This tool requires a single-host server using local project folders, key or OAuth sign-in, and explicit
          migration enablement on the VM.
        </p>
      ) : (
        <>
          <section className="app-settings-section" aria-label="Migration source inventory">
            <h4>Review the source</h4>
            <p className="app-settings-field-help">
              Inspect the current VM before entering destination credentials. This preview does not replace the frozen
              copy's strict validation or a manual review of local dependencies.
            </p>
            <button
              type="button"
              disabled={busy || activeJob}
              onClick={() => void act(async () => setInventory(await readVmMigrationSourceInventory()))}
            >
              Inspect source
            </button>
            {inventory ? (
              <div role="status">
                <p>
                  {inventory.projects} projects, {inventory.folders} {inventory.folders === 1 ? 'folder' : 'folders'},{' '}
                  {inventory.recordingBundles} recording bundles, {inventory.savedSettingsDomains} saved settings
                  domains, {inventory.publishedEndpoints} published endpoints, {inventory.publishedWebApps} published
                  web apps, and {inventory.publishedVersions} retained published versions.
                </p>
                <p>Source database authority: {inventory.sourceDatabaseAuthority}.</p>
                {inventory.warnings.map((warning) => (
                  <p key={warning} className="app-settings-field-help">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
          <section className="app-settings-section" aria-label="Destination object storage">
            <h4>1. Object storage destination</h4>
            <div className="app-settings-field-grid">
              <label className="app-settings-field">
                <span className="app-settings-field-label">Bucket</span>
                <TextField value={target.bucket} onChange={(event) => update('bucket', event.currentTarget.value)} />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Endpoint</span>
                <TextField
                  value={target.endpoint}
                  placeholder="Blank for AWS"
                  onChange={(event) => update('endpoint', event.currentTarget.value)}
                />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Signing region</span>
                <TextField value={target.region} onChange={(event) => update('region', event.currentTarget.value)} />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Workflow prefix</span>
                <TextField value={target.prefix} onChange={(event) => update('prefix', event.currentTarget.value)} />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Access key ID</span>
                <TextField
                  value={target.accessKeyId}
                  onChange={(event) => update('accessKeyId', event.currentTarget.value)}
                />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Secret access key</span>
                <TextField
                  type="password"
                  value={target.secretAccessKey}
                  onChange={(event) => update('secretAccessKey', event.currentTarget.value)}
                />
              </label>
              <label className="app-settings-field">
                <input
                  type="checkbox"
                  checked={target.forcePathStyle}
                  onChange={(event) => update('forcePathStyle', event.currentTarget.checked)}
                />{' '}
                Use path-style addressing
              </label>
            </div>
            <button
              type="button"
              disabled={busy || activeJob}
              onClick={() =>
                void act(async () => {
                  await testVmMigrationObjectStorage(target);
                  setObjectStorageTested(true);
                })
              }
            >
              Test S3
            </button>
            {objectStorageTested ? <p role="status">S3 read, write and delete checks passed.</p> : null}
          </section>
          <section className="app-settings-section" aria-label="Destination PostgreSQL">
            <h4>2. Managed PostgreSQL destination</h4>
            <div className="app-settings-field-grid">
              <label className="app-settings-field">
                <span className="app-settings-field-label">Connection string</span>
                <TextField
                  type="password"
                  value={target.databaseUrl}
                  placeholder="postgresql://…"
                  onChange={(event) => update('databaseUrl', event.currentTarget.value)}
                />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">PostgreSQL SSL mode</span>
                <select
                  value={target.databaseSslMode}
                  onChange={(event) =>
                    update('databaseSslMode', event.currentTarget.value as VmMigrationTarget['databaseSslMode'])
                  }
                >
                  <option value="require">Require</option>
                  <option value="verify-full">Verify full</option>
                  <option value="disable">Disable</option>
                </select>
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Destination settings encryption key</span>
                <TextField
                  type="password"
                  value={target.settingsEncryptionKey}
                  onChange={(event) => update('settingsEncryptionKey', event.currentTarget.value)}
                />
                <span className="app-settings-field-help">
                  Must match the key configured for the destination deployment.
                </span>
              </label>
            </div>
            <p className="app-settings-field-help">
              Credentials stay in this browser session and are sent only for connection tests and the copy. They are not
              saved in this VM’s settings.
            </p>
            <button
              type="button"
              disabled={busy || activeJob}
              onClick={() =>
                void act(async () => {
                  await testVmMigrationDatabase(target);
                  setDatabaseTested(true);
                })
              }
            >
              Test PostgreSQL
            </button>
            {databaseTested ? <p role="status">PostgreSQL DDL, read and write checks passed.</p> : null}
          </section>
          <section className="app-settings-section" aria-label="Migration pre-copy">
            <h4>3. Pre-copy project and completed recording content</h4>
            <p className="app-settings-field-help">
              While this VM stays online, stage content-addressed project snapshots and completed recording artifacts in
              the destination bucket. The final copy rechecks current bytes after maintenance begins; changed or
              still-active content is uploaded normally.
            </p>
            <button
              type="button"
              disabled={
                busy ||
                !inventory ||
                !tested ||
                !target.targetOffline ||
                Boolean(status?.maintenance) ||
                activeJob ||
                verified
              }
              onClick={() =>
                void act(async () => {
                  await startVmMigrationPrecopy(target);
                  setPrecopyStale(false);
                })
              }
            >
              Pre-copy content
            </button>
            {status?.job?.phase === 'precopy_complete' ? <p role="status">Content pre-copy complete.</p> : null}
          </section>
          <section className="app-settings-section" aria-label="Migration maintenance">
            <h4>4. Pause this server and copy</h4>
            <p className="app-settings-field-help">
              Maintenance blocks new saves and runs, then waits for active work and recording writes to finish. Existing
              browser tabs can stay open, but editing and execution are unavailable.
            </p>
            {!status?.maintenance ? (
              <button
                type="button"
                disabled={busy || !tested || !status?.job?.precopyCompleted || precopyStale || restartRequired}
                onClick={() => void act(enterVmMigrationMode)}
              >
                Enter maintenance mode
              </button>
            ) : (
              <p role="status">
                Maintenance active since {status.maintenance.enteredAt}.{' '}
                {status.drain?.ready
                  ? 'Source is quiet.'
                  : `Waiting for: ${status.drain?.blockers.join(', ') || 'status'}`}
              </p>
            )}
            <label className="app-settings-field">
              <input
                type="checkbox"
                checked={target.targetOffline}
                onChange={(event) => update('targetOffline', event.currentTarget.checked)}
              />{' '}
              I confirm the destination API and execution pods are stopped.
            </label>
            <label className="app-settings-field">
              <input
                type="checkbox"
                checked={target.runtimePlatformCompatible}
                onChange={(event) => update('runtimePlatformCompatible', event.currentTarget.checked)}
              />{' '}
              I checked runtime-library OS, architecture, Node ABI and image compatibility.
            </label>
            <button type="button" disabled={busy || !canRun} onClick={() => void act(() => startVmMigration(target))}>
              Copy and verify all data
            </button>
            {status?.job ? (
              <div role="status">
                <p>
                  Migration {status.job.phase}. {status.job.message}
                </p>
                {status.job.progress?.completed ? (
                  <p>
                    {status.job.progress.completed} verified item receipts recorded
                    {status.job.progress.lastItem
                      ? `; last: ${status.job.progress.lastItem.domain} ${status.job.progress.lastItem.id}`
                      : ''}
                    . A retry still compares destination bytes; receipts alone never certify the copy.
                  </p>
                ) : null}
              </div>
            ) : null}
            {verified ? (
              <div role="status">
                <p>
                  Storage copy and verification passed. This is not deployment approval or a traffic cutover. Rehearse
                  the exact Kubernetes release before completing the review below. Do not resume VM writes unless you
                  intend to invalidate this copy.
                </p>
                {status.job?.report ? (
                  <div>
                    <p>
                      Verified {status.job.report.projects} projects, {status.job.report.folders}{' '}
                      {status.job.report.folders === 1 ? 'folder' : 'folders'}, {status.job.report.recordings}{' '}
                      recordings, {status.job.report.publishedEndpoints} published endpoints,{' '}
                      {status.job.report.publishedWebApps} published web apps,{' '}
                      {status.job.report.evaluationAndHealthRows} Evaluation and health rows,{' '}
                      {status.job.report.runtimeLibraryPackages} runtime-library packages, and{' '}
                      {status.job.report.appSettingsDomains} App Settings domains.
                    </p>
                    <ul>
                      {status.job.report.checked.map((check) => (
                        <li key={check}>{check}</li>
                      ))}
                    </ul>
                    <p>Functional graph executions and external integrations still require a controlled rehearsal.</p>
                  </div>
                ) : null}
              </div>
            ) : null}
            {verified ? (
              <section className="app-settings-section" aria-label="Migration deployment review">
                <h4>5. Deployment review and final comparison</h4>
                <p className="app-settings-field-help">
                  Rehearse with private routing and controlled inputs against an isolated clone of the verified
                  destination, not the copy reserved for cutover. Keep the real destination pods stopped, then re-enter
                  its credentials and test both connections. This review rechecks all stored data and the frozen VM
                  source. It records operator assertions; it does not change DNS or activate Kubernetes.
                </p>
                {(
                  [
                    ['backupCompleted', 'I verified recoverable VM and destination backups.'],
                    [
                      'deploymentSettingsMatch',
                      'I checked the exact Kubernetes images, PostgreSQL, S3 location, encryption key, routes and secrets.',
                    ],
                    [
                      'functionalRehearsalPassed',
                      'On an isolated clone, private endpoint, web app, recording replay and input search, Subgraph, Evaluation and runtime-library checks passed.',
                    ],
                    [
                      'externalDependenciesReviewed',
                      'I reviewed VM file paths, plugins, Code nodes and external integrations.',
                    ],
                    [
                      'rollbackWindowUnderstood',
                      'I understand rollback after Kubernetes accepts writes needs a coordinated restore or reverse migration.',
                    ],
                  ] as const
                ).map(([key, label]) => (
                  <label className="app-settings-field" key={key}>
                    <input
                      type="checkbox"
                      checked={reviewChecks[key]}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setReviewChecks((current) => ({ ...current, [key]: checked }));
                      }}
                    />{' '}
                    {label}
                  </label>
                ))}
                <button
                  type="button"
                  disabled={
                    busy ||
                    Boolean(status?.job?.deploymentReview) ||
                    !tested ||
                    !target.targetOffline ||
                    !target.runtimePlatformCompatible ||
                    !Object.values(reviewChecks).every(Boolean)
                  }
                  onClick={() => void act(() => reviewVmMigrationDeployment(target, reviewChecks))}
                >
                  Run final comparison and record review
                </button>
                {status?.job?.deploymentReview ? (
                  <p role="status">
                    Final comparison and operator review recorded at {status.job.deploymentReview.reviewedAt}. The VM
                    must remain paused until DevOps completes traffic cutover. This is not an automatic switch.
                  </p>
                ) : null}
              </section>
            ) : null}
            {status?.job?.phase === 'interrupted' ? (
              <div>
                <p>
                  Check the VM console and confirm the old importer process has stopped before retrying or leaving
                  maintenance.
                </p>
                <label className="app-settings-field">
                  <input
                    type="checkbox"
                    checked={interruptedStopped}
                    onChange={(event) => setInterruptedStopped(event.currentTarget.checked)}
                  />{' '}
                  I confirmed the previous importer process is stopped.
                </label>
                <button
                  type="button"
                  disabled={busy || !interruptedStopped}
                  onClick={() => void act(acknowledgeInterruptedVmMigration)}
                >
                  Acknowledge interrupted copy
                </button>
              </div>
            ) : null}
            {status?.maintenance && !activeJob && status?.job?.phase !== 'interrupted' ? (
              <div>
                {requiresGateClosure ? (
                  <p className="app-settings-field-help">
                    Before this VM resumes, stop the destination pods and test both saved destination connections again.
                    Rivet will close the destination startup gate first; if it cannot, the VM stays paused.
                  </p>
                ) : null}
                <label className="app-settings-field">
                  <input
                    type="checkbox"
                    checked={resumeConfirmed}
                    onChange={(event) => setResumeConfirmed(event.currentTarget.checked)}
                  />{' '}
                  I understand resuming this VM invalidates the copied destination.
                </label>
                <button
                  type="button"
                  disabled={busy || !resumeConfirmed || (requiresGateClosure && (!tested || !target.targetOffline))}
                  onClick={() =>
                    void act(async () => {
                      await leaveVmMigrationMode(requiresGateClosure ? target : undefined);
                      setRestartRequired(true);
                    })
                  }
                >
                  Leave maintenance mode
                </button>
              </div>
            ) : null}
            {restartRequired ? <p role="status">Restart the backend before serving runs again.</p> : null}
          </section>
        </>
      )}
      {error ? (
        <p className="project-settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
