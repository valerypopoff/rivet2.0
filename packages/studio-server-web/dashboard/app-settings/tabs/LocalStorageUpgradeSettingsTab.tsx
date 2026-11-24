import { useId, type ReactNode } from 'react';
import { LoadingButton } from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import { LOCAL_UPGRADE_FAILURE_REASONS } from '@valerypopoff/rivet-studio-server-shared/local-upgrade-types';
import { DuplicateProjectRepairPanel } from './DuplicateProjectRepairPanel';
import { BooleanSetting } from '../SettingsControls';
import type { UpgradeAction } from './localStorageUpgradeModel';
import { useLocalStorageUpgradeController } from './useLocalStorageUpgradeController';
import './LocalStorageUpgradeSettingsTab.css';

const actionProgress = {
  prepare: 'Preparing persistent control storage, then restarting the backend…',
  restart: 'Restarting both backend processes. This panel reconnects automatically; writes stay fenced…',
  inspect: 'Inspecting source data and checking capacity…',
  pause: 'Pausing new writes and waiting for active work to drain…',
  fingerprint: 'Reading the frozen source fingerprint…',
  backup: 'Creating the backup archive and checking an isolated restore. Writes remain paused…',
  repair: 'Verifying a repair backup and updating project identities. Writes remain paused…',
  copy: 'Copy and verification are in progress. Original data remains unchanged.',
  activate: 'Checking the certified candidate and selecting SQLite for paused validation…',
  'return-to-legacy': 'Checking the retained source and selecting the legacy backend…',
  validate: 'Validating the selected runtime. Keep writes paused until validation finishes.',
  resume: 'Recording write resumption. The combined backend will need a restart…',
  'finish-resume': 'Completing durable write resumption. The combined backend will need a restart…',
  cancel: 'Restoring legacy operation. The combined backend will need a restart…',
  report: 'Preparing the verification report download…',
} as const satisfies Record<UpgradeAction, string>;

function UpgradeActionButton({
  action,
  loading,
  disabled,
  primary = false,
  description,
  onClick,
  children,
}: {
  action: UpgradeAction;
  loading: boolean;
  disabled: boolean;
  primary?: boolean;
  description?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <>
      <LoadingButton
        appearance={primary ? 'primary' : 'default'}
        className="local-upgrade-action button-size-l"
        isLoading={loading}
        aria-busy={loading}
        aria-describedby={description ? descriptionId : undefined}
        isDisabled={disabled}
        onClick={onClick}
      >
        {children}
      </LoadingButton>
      {description && (
        <p id={descriptionId} className="app-settings-field-help">
          {description}
        </p>
      )}
      {loading && (
        <p role="status" className="app-settings-field-help">
          {actionProgress[action]}
        </p>
      )}
    </>
  );
}

export function LocalStorageUpgradeSettingsTab() {
  const { state, derived, actions } = useLocalStorageUpgradeController();
  const {
    status,
    projectDiagnostic,
    inventory,
    awaitingRestart,
    error,
    statusError,
    backupReference,
    backupFingerprint,
    downloadStarted,
  } = state;
  const {
    busy,
    transition,
    preparation,
    repairAnalysis,
    guided,
    needsPreparation,
    resumed,
    repairRunning,
    activeAction,
    copying,
    disabled,
    quiet,
    initial,
    validating,
    restartRequired,
    selectedRuntimeReady,
    automatedBackup,
    usesAutomatedBackup,
    sourceFingerprint,
    backupRestored,
    retryJob,
    previousCopy,
    settingsEncryptionRequired,
    keyBackedUp,
    resumeConfirmed,
    currentValidationFailure,
    runtimeValidationPassed,
    controlDisabled,
    hasBackupEvidence,
    preparationReference,
    preparationDiagnosticToken,
    copyDiagnosticToken,
    repairDownloadUrl,
  } = derived;
  return (
    <section role="tabpanel" aria-label="Local storage upgrade" className="local-storage-upgrade-panel">
      <h3>Local storage upgrade</h3>
      <p className="app-settings-field-help">
        Copy local metadata into SQLite. Project, recording and package payloads remain immutable local files. Your old
        files stay intact.
      </p>
      <p className="app-settings-field-help app-settings-inline-note">
        Activation pauses all writes. You can return to legacy until you explicitly resume SQLite writes. After
        resuming, recovery requires a coordinated backup restore—not a switch back.
      </p>
      {statusError && (
        <p role="alert" className="project-settings-error">
          {statusError}
        </p>
      )}
      {awaitingRestart && (
        <p role="status" className="app-settings-field-help">
          Backend restart is in progress. This panel reconnects automatically; do not refresh or run console commands.
        </p>
      )}
      {error && error !== currentValidationFailure && (
        <p role="alert" className="project-settings-error">
          {error}
        </p>
      )}
      {preparation?.revision === transition?.revision &&
        preparation?.error &&
        ['failed', 'interrupted'].includes(preparation.phase) && (
          <p role="alert" className="project-settings-error">
            {preparation.error}
            {preparation.failure?.reason && ` ${LOCAL_UPGRADE_FAILURE_REASONS[preparation.failure.reason]}`}
            {preparationReference &&
              /^[a-f0-9]{16}$/.test(preparationReference) &&
              ` Project reference: ${preparationReference}.`}
            {projectDiagnostic?.token === preparationDiagnosticToken &&
              projectDiagnostic.paths.length > 0 &&
              ` Affected project: ${projectDiagnostic.paths.join(', ')}.`}
          </p>
        )}
      {status?.preparationStatusUnreadable && (
        <p role="alert" className="project-settings-error">
          Preparation status could not be read. No preparation result can authorize further steps; existing storage
          recovery remains available.
        </p>
      )}
      {status && (
        <p className="app-settings-field-help">
          Running backend: {status.runningBackend}. Selected phase: {transition?.phase ?? 'not configured'}.
        </p>
      )}
      {status?.repairStatusUnreadable && (
        <p role="alert" className="project-settings-error">
          Repair status could not be read. Storage actions remain blocked; do not remove repair or maintenance files.
        </p>
      )}
      {status?.duplicateRepairAvailable && initial && !transition?.generationId && (
        <DuplicateProjectRepairPanel
          key={repairAnalysis?.token ?? 'no-analysis'}
          analysis={repairAnalysis}
          repair={status.repair}
          disabled={controlDisabled.repair}
          running={activeAction === 'repair' || repairRunning}
          onInspect={actions.inspectDuplicates}
          onRepair={actions.repairDuplicates}
          onRecover={actions.recoverDuplicates}
          downloadUrl={repairDownloadUrl}
        />
      )}
      {status?.operation && !busy && (
        <p role="status" className="app-settings-field-help">
          A local storage operation is still running on the server. Other actions stay locked until it finishes.
        </p>
      )}
      {settingsEncryptionRequired && status?.available && status.copyConfigurationReady === false && (
        <p role="alert" className="app-settings-field-help app-settings-inline-note">
          Copying is blocked: configure RIVET_LOCAL_METADATA_ENCRYPTION_KEY with at least 32 securely generated
          characters, recreate the backend and back up the key separately. If this upgrade already has a candidate,
          restore its original key; do not generate a replacement. Restarting the same container does not load changed
          environment values. Recovery and legacy controls remain available.
        </p>
      )}
      {needsPreparation && (
        <section className="app-settings-section" aria-label="Server preparation">
          <h4 className="app-settings-section-title">Prepare this server</h4>
          <p className="app-settings-field-help">
            The server prepares private, persistent control storage automatically. Both backend processes restart. This
            does not migrate data or pause writes. Local settings are stored without encryption; no encryption key or
            .env configuration is needed.
          </p>
          <UpgradeActionButton
            action="prepare"
            loading={activeAction === 'prepare'}
            disabled={controlDisabled.prepare}
            onClick={actions.prepareServer}
          >
            Prepare server for migration
          </UpgradeActionButton>
        </section>
      )}
      {!status?.available && !needsPreparation && !statusError && !error && (
        <p className="app-settings-field-help">
          This feature is disabled by default and requires a provisioned persistent control volume and operator
          authentication.
        </p>
      )}
      <section
        className="app-settings-section"
        aria-label="Source inspection and maintenance"
        hidden={!!needsPreparation}
      >
        <h4 className="app-settings-section-title">{guided ? '1. Pause and back up' : '1. Inspect and pause'}</h4>
        {guided && initial && !status?.maintenance && (
          <UpgradeActionButton
            action={
              preparation?.phase === 'running' && preparation.kind === 'pause-backup' ? preparation.stage : 'pause'
            }
            primary
            loading={activeAction === 'pause'}
            disabled={controlDisabled.storage}
            onClick={actions.pauseAndBackup}
          >
            Pause writes and create verified backup
          </UpgradeActionButton>
        )}
        <details open={!guided}>
          <summary>Advanced</summary>
          <div className="local-upgrade-details-body">
            <p className="app-settings-field-help">
              {guided
                ? 'Optional individual controls. The main pause-and-backup button performs these steps and starts backup creation for you.'
                : 'Use these individual controls to inspect and pause the source before creating a backup.'}
            </p>
            <UpgradeActionButton
              action="inspect"
              description="Checks source folders, inventory, warnings and disk/memory capacity without changing data or pausing writes."
              loading={activeAction === 'inspect'}
              disabled={controlDisabled.inspect}
              onClick={actions.inspectSource}
            >
              Inspect source
            </UpgradeActionButton>
            {inventory && (
              <div className="local-upgrade-inventory app-settings-field-help">
                {inventory.inventory ? (
                  <p>
                    {inventory.inventory.projects} projects, {inventory.inventory.folders} folders,{' '}
                    {inventory.inventory.recordingBundles} recordings, {inventory.inventory.publishedVersions} published
                    versions, {inventory.inventory.publishedWebApps} web apps.
                  </p>
                ) : (
                  <p>Source inventory was not loaded because capacity preflight failed.</p>
                )}
                <dl className="local-upgrade-source-roots">
                  {Object.entries(inventory.source).map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                {inventory.inventory?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                <p>{inventory.backupRequired}</p>
                {inventory.capacity && (
                  <p>
                    Copy payload estimate: {Math.ceil(inventory.capacity.payloadBytes / 1048576)} MiB. Required
                    candidate disk space: {Math.ceil(inventory.capacity.requiredBytes / 1048576)} MiB.{' '}
                    {inventory.capacity.measurementComplete === false &&
                      'Payload size is a lower bound; measurement stopped at an oversized bundle. '}
                    {inventory.capacity.estimatedWorkingBytes !== undefined &&
                      `Estimated extra working memory: ${Math.ceil(inventory.capacity.estimatedWorkingBytes / 1048576)} MiB. `}
                    {inventory.capacity.fits
                      ? 'Capacity preflight passed.'
                      : 'Capacity preflight failed; copying is blocked. Each decoded project/history or recording bundle has a memory budget.'}
                    {inventory.capacity.reasons?.length
                      ? ` Blocking checks: ${inventory.capacity.reasons.join(', ')}.`
                      : ''}
                  </p>
                )}
              </div>
            )}
            <UpgradeActionButton
              action="pause"
              description="Blocks new writes and runs, then waits for active work to finish. Does not create a backup."
              loading={activeAction === 'pause' || (initial && !!status?.maintenance && status.drain?.ready === false)}
              disabled={controlDisabled.pause}
              onClick={actions.pauseWrites}
            >
              Pause writes and drain
            </UpgradeActionButton>
            {status?.maintenance && (
              <p className="app-settings-field-help">
                {status.drain?.ready
                  ? initial
                    ? 'Source is quiet. Take and restore your backup before copying.'
                    : 'Writes are paused. Continue with the selected backend’s activation, validation or recovery below.'
                  : `Waiting for: ${status.drain?.blockers.join(', ') || 'active work'}.`}
              </p>
            )}
          </div>
        </details>
        {guided && status?.maintenance && (
          <p role="status" className="app-settings-field-help">
            {quiet
              ? 'Source is quiet. Create or download the verified backup below.'
              : `Waiting for: ${status.drain?.blockers.join(', ') || 'active work'}.`}
          </p>
        )}
      </section>
      <section className="app-settings-section" aria-label="Backup certification and copy" hidden={!!needsPreparation}>
        <h4 className="app-settings-section-title">{guided ? '2. Download and copy' : '2. Back up and copy'}</h4>
        {quiet && initial && (
          <fieldset disabled={disabled} className="local-upgrade-backup-form">
            <legend className="app-settings-field-label">Create and download a verified backup</legend>
            <p className="app-settings-field-help">
              Create a backup of all four roots while paused. The server restores the archive into a separate scratch
              directory and checks that it matches the frozen source. Download and save it outside this VM before
              copying. The archive contains unencrypted private settings and credentials: store it securely.
              {settingsEncryptionRequired &&
                ' This older server also requires a separate encryption-key backup. Never paste the key here.'}
            </p>
            <UpgradeActionButton
              action="backup"
              loading={activeAction === 'backup'}
              disabled={controlDisabled.storage}
              onClick={actions.createBackup}
            >
              {status?.backup ? 'Create a new verified backup' : 'Create verified backup'}
            </UpgradeActionButton>
            {status?.backupStatusUnreadable && (
              <p role="alert" className="project-settings-error">
                The previous backup status could not be read. It cannot certify copying. Create a new verified backup or
                supply independently restored backup evidence; legacy recovery remains available.
              </p>
            )}
            {['failed', 'interrupted'].includes(status?.backup?.phase ?? '') && (
              <p role="alert" className="project-settings-error">
                Backup creation or restore verification did not finish. No backup has been certified. Check available
                disk space and source integrity, then create a new backup; writes remain paused.
              </p>
            )}
            {automatedBackup && (
              <>
                <p role="status" className="app-settings-field-help">
                  Backup archive restored and verified on this server ({Math.ceil(automatedBackup.bytes / 1048576)}{' '}
                  MiB). This is not yet confirmation of an off-VM backup.
                </p>
                <LoadingButton
                  className="local-upgrade-action button-size-l"
                  isDisabled={disabled}
                  onClick={() => actions.downloadBackup()}
                >
                  Download verified backup
                </LoadingButton>
                {settingsEncryptionRequired && (
                  <LoadingButton
                    className="local-upgrade-action button-size-l"
                    isDisabled={controlDisabled.keyDownload}
                    onClick={() => actions.downloadBackup(true)}
                  >
                    Download encryption key separately
                  </LoadingButton>
                )}
                {downloadStarted && (
                  <p role="status" className="app-settings-field-help">
                    Check your browser downloads. Only confirm below after the files have finished downloading and are
                    stored securely outside the VM.
                  </p>
                )}
              </>
            )}
            <details open={!guided}>
              <summary>Advanced: independently restored backup evidence</summary>
              <div className="local-upgrade-details-body">
                <p className="app-settings-field-help">
                  The evidence below is filled automatically for a verified browser backup. If you already restored a
                  backup elsewhere, you can instead enter its reference and independently computed fingerprint.
                </p>
                <UpgradeActionButton
                  action="fingerprint"
                  loading={activeAction === 'fingerprint'}
                  disabled={controlDisabled.storage}
                  onClick={actions.readFingerprint}
                >
                  Read frozen source fingerprint
                </UpgradeActionButton>
                {sourceFingerprint && (
                  <div className="app-settings-field local-upgrade-fingerprint">
                    <span className="app-settings-field-label">Frozen source:</span>
                    <code>{sourceFingerprint}</code>
                  </div>
                )}
                <div className="app-settings-field-grid">
                  <label className="app-settings-field">
                    <span className="app-settings-field-label">Backup reference</span>
                    <TextField
                      aria-label="Backup reference"
                      value={backupReference}
                      isDisabled={disabled}
                      onChange={(event) => actions.editBackupReference(event.currentTarget.value)}
                      maxLength={512}
                    />
                  </label>
                  <label className="app-settings-field">
                    <span className="app-settings-field-label">Restored backup fingerprint</span>
                    <TextField
                      aria-label="Restored backup fingerprint"
                      value={backupFingerprint}
                      isDisabled={disabled}
                      onChange={(event) => actions.editBackupFingerprint(event.currentTarget.value)}
                      maxLength={64}
                    />
                  </label>
                </div>
              </div>
            </details>
            <div className="app-settings-field-grid">
              <BooleanSetting
                checked={backupRestored}
                disabled={controlDisabled.backupConfirmation}
                onChange={actions.confirmBackupRestored}
                label={
                  usesAutomatedBackup
                    ? 'I saved the verified backup download securely outside this VM.'
                    : 'I restored a separate backup of all four source roots.'
                }
              />
              {settingsEncryptionRequired && (
                <BooleanSetting
                  checked={keyBackedUp}
                  disabled={controlDisabled.backupConfirmation}
                  onChange={actions.confirmKeyBackedUp}
                  label="I backed up the local settings encryption key separately."
                />
              )}
            </div>
            {!hasBackupEvidence && (
              <p className="app-settings-field-help">
                {guided
                  ? 'Create a verified backup above. Its verification evidence is filled automatically; no fingerprint needs to be typed.'
                  : 'Read the current frozen fingerprint and enter a backup reference and matching restored fingerprint before certifying the backup.'}
              </p>
            )}
          </fieldset>
        )}
        <UpgradeActionButton
          action="copy"
          primary
          loading={activeAction === 'copy' || copying}
          disabled={controlDisabled.copy}
          onClick={actions.copy}
        >
          {retryJob ? 'Retry copy and verification' : 'Copy and verify'}
        </UpgradeActionButton>
        {previousCopy && (
          <p className="app-settings-field-help">
            The previous attempt used different or unavailable source/backup evidence. Copy and verify starts a new
            candidate using the confirmed backup; earlier candidate files are retained, not reused or deleted.
          </p>
        )}
        {status?.job && (
          <p className="app-settings-field-help" role="status">
            {previousCopy ? 'Previous copy status' : 'Copy status'}: {status.job.phase}.{' '}
            {status.job.stage && `Stage: ${status.job.stage}. `}
            {status.job.message}
            {status.job.failure &&
              ` Failure: ${status.job.failure.code} at ${status.job.failure.stage}. Download the diagnostic report; no exception contents or secrets are included.`}
            {status.job.failure?.reason &&
              Object.hasOwn(LOCAL_UPGRADE_FAILURE_REASONS, status.job.failure.reason) &&
              ` ${LOCAL_UPGRADE_FAILURE_REASONS[status.job.failure.reason]}`}
            {status.job.failure?.sourceReference &&
              /^[a-f0-9]{16}$/.test(status.job.failure.sourceReference) &&
              ` Project reference: ${status.job.failure.sourceReference}.`}
            {projectDiagnostic?.token === copyDiagnosticToken &&
              projectDiagnostic.paths.length > 0 &&
              ` Affected project: ${projectDiagnostic.paths.join(', ')}.`}
          </p>
        )}
      </section>
      <section
        className="app-settings-section"
        aria-label="Activation and runtime validation"
        hidden={!!needsPreparation}
      >
        <h4 className="app-settings-section-title">3. Activate and validate</h4>
        <UpgradeActionButton
          action="activate"
          primary
          loading={activeAction === 'activate'}
          disabled={controlDisabled.activate}
          onClick={() => void actions.transitionAction('activate')}
        >
          Activate SQLite while paused
        </UpgradeActionButton>
        {restartRequired && (
          <p role="status" className="app-settings-field-help app-settings-inline-note">
            {guided
              ? 'The backend must restart to load this selection. Use Restart backend below; this panel reconnects and validates automatically.'
              : 'Restart the combined API/executor container, then reopen this panel. Both processes must load the selected generation before validation or new work.'}
          </p>
        )}
        {guided && restartRequired && (
          <UpgradeActionButton
            action="restart"
            loading={activeAction === 'restart'}
            disabled={disabled}
            onClick={actions.restart}
          >
            Restart backend
          </UpgradeActionButton>
        )}
        {guided && (
          <p className="app-settings-field-help">
            Activation restarts both backend processes and validates automatically while writes stay paused. If
            validation fails, retry it below or return to legacy. Resuming writes also restarts automatically.
          </p>
        )}
        {(!guided || !transition?.validated) && (
          <UpgradeActionButton
            action="validate"
            loading={activeAction === 'validate'}
            disabled={controlDisabled.validate}
            onClick={() => void actions.transitionAction('validate')}
          >
            Validate selected runtime
          </UpgradeActionButton>
        )}
        {activeAction !== 'validate' &&
          (currentValidationFailure ? (
            <p role="alert" className="project-settings-error">
              Runtime validation failed: {currentValidationFailure} Do not resume writes.
            </p>
          ) : runtimeValidationPassed ? (
            <p role="status" className="project-settings-success local-upgrade-validation-result">
              {transition?.backend === 'sqlite' ? 'SQLite' : 'Legacy'} runtime validation passed. Writes remain paused.
              {transition?.backend === 'sqlite'
                ? ' You can test Return to legacy before choosing to resume writes.'
                : ' The legacy backend is ready for recovery review before choosing to resume writes.'}
            </p>
          ) : validating && selectedRuntimeReady ? (
            <p role="status" className="app-settings-field-help">
              Runtime validation has not passed yet. Validate the selected runtime before resuming writes.
            </p>
          ) : null)}
      </section>
      <section className="app-settings-section" aria-label="Write resumption" hidden={!!needsPreparation}>
        <h4 className="app-settings-section-title">4. Resume writes</h4>
        {validating && (
          <BooleanSetting
            disabled={controlDisabled.resumeConfirmation}
            checked={resumeConfirmed}
            onChange={actions.confirmResume}
            label="I reviewed the selected backend and its write-resumption recovery boundary."
          />
        )}
        {validating && (
          <p className="app-settings-field-help app-settings-inline-note">
            {transition?.backend === 'sqlite'
              ? 'Resuming SQLite writes closes one-click rollback.'
              : 'Resuming legacy writes continues the old backend; it does not activate SQLite.'}
          </p>
        )}
        <UpgradeActionButton
          action="resume"
          primary
          loading={activeAction === 'resume'}
          disabled={controlDisabled.resume}
          onClick={() => void actions.transitionAction('resume')}
        >
          Resume writes
        </UpgradeActionButton>
        {quiet && resumed && (
          <UpgradeActionButton
            action="finish-resume"
            loading={activeAction === 'finish-resume'}
            disabled={controlDisabled.storage}
            onClick={() => void actions.transitionAction('resume', 'finish-resume')}
          >
            Finish durable resumption
          </UpgradeActionButton>
        )}
      </section>
      <section
        className="app-settings-section"
        aria-label="Recovery and verification report"
        hidden={!!needsPreparation}
      >
        <h4 className="app-settings-section-title">Recovery and report</h4>
        {transition?.phase !== 'sqlite-live' && (
          <>
            <UpgradeActionButton
              action="return-to-legacy"
              loading={activeAction === 'return-to-legacy'}
              disabled={controlDisabled.returnToLegacy}
              onClick={() => void actions.transitionAction('return-to-legacy')}
            >
              Return to legacy while paused
            </UpgradeActionButton>
            <UpgradeActionButton
              action="cancel"
              loading={activeAction === 'cancel'}
              disabled={controlDisabled.cancel}
              onClick={() => void actions.transitionAction('cancel')}
            >
              {status?.repair?.phase === 'complete' ? 'Resume legacy with repaired IDs' : 'Resume unchanged legacy'}
            </UpgradeActionButton>
          </>
        )}
        <UpgradeActionButton
          action="report"
          loading={activeAction === 'report'}
          disabled={controlDisabled.report}
          onClick={actions.downloadReport}
        >
          Download verification report
        </UpgradeActionButton>
      </section>
    </section>
  );
}
