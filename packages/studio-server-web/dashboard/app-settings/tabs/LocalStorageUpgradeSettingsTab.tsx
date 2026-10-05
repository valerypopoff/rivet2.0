import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LoadingButton } from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import { RIVET_API_BASE_URL } from '../../../../studio-server-shared/hosted-env';
import { parseJsonResponse } from '../../apiRequest';
import {
  LOCAL_UPGRADE_FAILURE_REASONS,
  type LocalUpgradeFailureReason,
  type LocalUpgradeOperation,
} from '../../../../studio-server-shared/local-upgrade-types';
import { BooleanSetting } from '../SettingsControls';
import './LocalStorageUpgradeSettingsTab.css';

type Status = {
  settingsEncryptionRequired?: boolean;
  uiRestartAvailable?: boolean;
  runtimeReady?: boolean;
  backupStatusUnreadable?: boolean;
  backup?: {
    id: string;
    revision: number;
    pausedAt: string;
    phase: 'creating' | 'ready' | 'failed' | 'interrupted';
    sourceFingerprint: string;
    archiveHash: string | null;
    bytes: number;
  } | null;
  available: boolean;
  operation?: LocalUpgradeOperation | null;
  copyConfigurationReady?: boolean;
  runningBackend: string;
  maintenance: { enteredAt: string } | null;
  drain: { ready: boolean; blockers: string[] } | null;
  restartRequired: boolean;
  transition: {
    revision: number;
    phase: string;
    backend: string;
    generationId: string | null;
    canReturnToLegacy: boolean;
    validated: boolean;
  } | null;
  job: {
    id: string;
    phase: string;
    message: string | null;
    stage?: string;
    failure?: { stage: string; code: string; reason?: LocalUpgradeFailureReason; sourceReference?: string } | null;
  } | null;
};
type Inventory = {
  source: Record<string, string>;
  capacity?: {
    payloadBytes: number;
    freeBytes: number;
    requiredBytes: number;
    maxPayloadBytes: number;
    fits: boolean;
    estimatedWorkingBytes?: number;
    memoryBudgetBytes?: number;
    measurementComplete?: boolean;
    reasons?: string[];
  };
  inventory: {
    projects: number;
    folders: number;
    recordingBundles: number;
    publishedEndpoints: number;
    publishedVersions: number;
    publishedWebApps: number;
    warnings: string[];
  } | null;
  backupRequired: string;
};
const base = `${RIVET_API_BASE_URL}/app-settings/local-upgrade`;
const actionProgress = {
  prepare: 'Preparing persistent control storage, then restarting the backend…',
  restart: 'Restarting both backend processes. This panel reconnects automatically; writes stay fenced…',
  inspect: 'Inspecting source data and checking capacity…',
  pause: 'Pausing new writes and waiting for active work to drain…',
  fingerprint: 'Reading the frozen source fingerprint…',
  backup: 'Creating the backup archive and checking an isolated restore. Writes remain paused…',
  copy: 'Copy and verification are in progress. Original data remains unchanged.',
  activate: 'Checking the certified candidate and selecting SQLite for paused validation…',
  'return-to-legacy': 'Checking the retained source and selecting the legacy backend…',
  validate: 'Validating the selected runtime. Keep writes paused until validation finishes.',
  resume: 'Recording write resumption. The combined backend will need a restart…',
  'finish-resume': 'Completing durable write resumption. The combined backend will need a restart…',
  cancel: 'Restoring unchanged legacy operation. The combined backend will need a restart…',
  report: 'Preparing the verification report download…',
} as const satisfies Record<LocalUpgradeOperation | 'finish-resume' | 'report', string>;
type UpgradeAction = keyof typeof actionProgress;
type UpgradeTransitionAction = Exclude<
  LocalUpgradeOperation,
  'prepare' | 'restart' | 'inspect' | 'pause' | 'fingerprint' | 'copy' | 'backup'
>;

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

async function request<T>(suffix = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}${suffix}`, {
    cache: 'no-store',
    signal,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return undefined as T;
  return parseJsonResponse<T>(response);
}

export function LocalStorageUpgradeSettingsTab() {
  const [setup, setSetup] = useState<{
    eligible: boolean;
    sqliteSelected?: boolean;
    uiPreparationAvailable?: boolean;
    uiRestartAvailable?: boolean;
    upgradeEnabled: boolean;
    controlRootConfigured: boolean;
    encryptionKeyReady: boolean;
  } | null>(null);
  const setupSnapshot = useRef(setup);
  const [status, setStatus] = useState<Status | null>(null);
  const [projectDiagnostic, setProjectDiagnostic] = useState<{ token: string; paths: string[] } | null>(null);
  const diagnosticReference = status?.job?.phase === 'failed' ? status.job.failure?.sourceReference : undefined;
  const diagnosticToken = diagnosticReference ? `${status?.job?.id}:${diagnosticReference}` : null;
  useEffect(() => {
    if (!diagnosticToken || !diagnosticReference || !/^[a-f0-9]{16}$/.test(diagnosticReference)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void request<{ reference: string; paths: string[] }>(
      `/project-reference?reference=${diagnosticReference}`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (
          !controller.signal.aborted &&
          result.reference === diagnosticReference &&
          Array.isArray(result.paths) &&
          result.paths.every((value) => typeof value === 'string')
        )
          setProjectDiagnostic({ token: diagnosticToken, paths: result.paths });
      })
      .catch(() => {
        /* Optional name lookup cannot unlock controls or conceal the durable failure. */
      });
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [diagnosticToken, diagnosticReference]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [pendingAction, setPendingAction] = useState<UpgradeAction | null>(null);
  const [awaitingRestart, setAwaitingRestart] = useState(false);
  const restartDeadline = useRef(0);
  const busy = pendingAction !== null;
  const actionInFlight = useRef(false);
  const [validationFailure, setValidationFailure] = useState<{ token: string | null; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [backupReference, setBackupReference] = useState('');
  const [backupFingerprint, setBackupFingerprint] = useState('');
  const [frozenSource, setFrozenSource] = useState<{ pausedAt: string; fingerprint: string } | null>(null);
  const [backupRestoredFor, setBackupRestoredFor] = useState<string | null>(null);
  const [keyBackedUpFor, setKeyBackedUpFor] = useState<string | null>(null);
  const [resumeAcknowledgement, setResumeAcknowledgement] = useState<string | null>(null);
  const adoptedBackup = useRef<string | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const refresh = async () => {
    const sequence = ++requestSequence.current;
    try {
      // A stalled connection must not leave stale operator controls enabled.
      // Only status reads are bounded; conversion actions can take much longer.
      // Setup is stable for a running backend. Re-read it only while first-time
      // preparation is pending; ordinary action settlement needs one status read.
      let configuration = setupSnapshot.current;
      if (
        !configuration ||
        (configuration.uiPreparationAvailable &&
          !configuration.sqliteSelected &&
          (!configuration.upgradeEnabled || !configuration.controlRootConfigured || !configuration.encryptionKeyReady))
      ) {
        configuration = await request<NonNullable<typeof setup>>('/setup', undefined, AbortSignal.timeout(10_000));
        if (mounted.current && sequence === requestSequence.current) {
          setupSnapshot.current = configuration;
          setSetup(configuration);
        }
      }
      if (
        configuration.uiPreparationAvailable &&
        !configuration.sqliteSelected &&
        (!configuration.upgradeEnabled || !configuration.controlRootConfigured || !configuration.encryptionKeyReady)
      ) {
        if (mounted.current && sequence === requestSequence.current) {
          setStatus(null);
          setStatusError(null);
        }
        return;
      }
      const next = await request<Status>('', undefined, AbortSignal.timeout(10_000));
      if (mounted.current && sequence === requestSequence.current) {
        setStatus(next);
        if (next.available && !next.restartRequired) {
          restartDeadline.current = 0;
          setAwaitingRestart(false);
        }
        if (!next.available) setResumeAcknowledgement(null);
        setStatusError(null);
      }
    } catch (failure) {
      if (mounted.current && sequence === requestSequence.current) {
        setStatus(null);
        setResumeAcknowledgement(null);
        const restarting = restartDeadline.current > Date.now();
        if (!restarting) setAwaitingRestart(false);
        setStatusError(
          restarting
            ? null
            : 'Local storage upgrade is unavailable. Check the connection and sign in as an operator; controls stay locked until status is refreshed.',
        );
      }
      throw failure;
    }
  };
  useEffect(() => {
    mounted.current = true;
    let refreshing = false;
    const poll = async () => {
      if (refreshing || actionInFlight.current) return;
      refreshing = true;
      try {
        await refresh();
      } catch {
        // refresh owns sequence-checked connection state. An older failed poll
        // must not overwrite a newer response or clear an action's error.
      } finally {
        refreshing = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      mounted.current = false;
      ++requestSequence.current;
      window.clearInterval(timer);
    };
  }, []);
  const act = async (callback: () => Promise<void>, actionName: UpgradeAction) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    // A read begun before this action cannot certify its resulting state.
    ++requestSequence.current;
    setPendingAction(actionName);
    setError(null);
    try {
      try {
        await callback();
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure.message : 'Local storage action failed.');
      }
      if (mounted.current) {
        try {
          // A lost response does not prove that a server-side mutation failed.
          await refresh();
        } catch {
          // refresh locks controls and owns the connection error. Preserve any
          // action diagnostic rather than replacing it with a polling failure.
        }
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) {
        setPendingAction(null);
      }
    }
  };
  const transition = status?.transition;
  const guided = status?.uiRestartAvailable === true || setup?.uiRestartAvailable === true;
  const needsPreparation =
    setup?.eligible && !setup.sqliteSelected && setup.uiPreparationAvailable && !status?.available;
  const resumed = transition?.phase === 'sqlite-live' || transition?.phase === 'legacy-resumed';
  const activeAction =
    pendingAction ?? (status?.operation === 'resume' && resumed ? 'finish-resume' : status?.operation);
  const copying = status?.job?.phase === 'copying';
  const disabled = busy || awaitingRestart || !!status?.operation || copying || !status?.available;
  const quiet = !!status?.maintenance && !!status.drain?.ready;
  const initial = transition?.phase === 'legacy' || transition?.phase === 'legacy-resumed';
  const validating = transition?.phase === 'sqlite-validation' || transition?.phase === 'legacy-validation';
  const restartRequired = !!status?.restartRequired || (!!transition && status?.runningBackend !== transition.backend);
  const selectedRuntimeReady =
    status?.available && !!transition && !restartRequired && (!guided || status.runtimeReady === true);
  const automatedBackup =
    status?.backup?.phase === 'ready' &&
    initial &&
    quiet &&
    !restartRequired &&
    status.backup.revision === transition?.revision &&
    status.backup.pausedAt === status.maintenance?.enteredAt
      ? status.backup
      : null;
  useEffect(() => {
    if (!automatedBackup || adoptedBackup.current === automatedBackup.id) return;
    adoptedBackup.current = automatedBackup.id;
    setFrozenSource({ pausedAt: automatedBackup.pausedAt, fingerprint: automatedBackup.sourceFingerprint });
    setBackupReference(`browser-backup:${automatedBackup.id}:${automatedBackup.archiveHash}`);
    setBackupFingerprint(automatedBackup.sourceFingerprint);
    setBackupRestoredFor(null);
    setKeyBackedUpFor(null);
    setDownloadStarted(false);
  }, [automatedBackup?.id]);
  const usesAutomatedBackup =
    !!automatedBackup && backupReference === `browser-backup:${automatedBackup.id}:${automatedBackup.archiveHash}`;
  const downloadBackup = (key = false) => {
    if (!automatedBackup) return;
    const anchor = document.createElement('a');
    anchor.href = `${base}/backup/${key ? 'key' : 'download'}?id=${encodeURIComponent(automatedBackup.id)}`;
    // Only the server's successful attachment response should download. A
    // forced download attribute would disguise a JSON auth/integrity error as
    // a backup. Keep error navigation away from the editor's unsaved workspace.
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setDownloadStarted(true);
  };
  const sourceFingerprint =
    frozenSource?.pausedAt === status?.maintenance?.enteredAt ? frozenSource?.fingerprint ?? '' : '';
  const backupToken =
    sourceFingerprint && backupReference.trim() && backupFingerprint === sourceFingerprint
      ? JSON.stringify([
          status?.maintenance?.enteredAt,
          transition?.revision,
          sourceFingerprint,
          backupReference.trim(),
        ])
      : null;
  const backupRestored = backupToken !== null && backupRestoredFor === backupToken;
  // Older servers still require key attestation; new plaintext servers do not.
  const settingsEncryptionRequired = status?.settingsEncryptionRequired !== false;
  const keyBackedUp = !settingsEncryptionRequired || (backupToken !== null && keyBackedUpFor === backupToken);
  const resumeToken =
    validating && transition?.generationId
      ? `${transition.generationId}:${transition.phase}:${transition.revision}:${status?.maintenance?.enteredAt}`
      : null;
  const resumeConfirmed = resumeToken !== null && resumeAcknowledgement === resumeToken;
  const currentValidationFailure =
    resumeToken !== null && validationFailure?.token === resumeToken ? validationFailure.message : null;
  const runtimeValidationPassed = selectedRuntimeReady && validating && transition?.validated && quiet;
  const requestRestart = async (suffix: '/prepare' | '/restart', body: unknown) => {
    restartDeadline.current = Date.now() + 300_000;
    setAwaitingRestart(true);
    try {
      await request(suffix, body);
    } catch (failure) {
      restartDeadline.current = 0;
      setAwaitingRestart(false);
      throw failure;
    }
  };
  const restartBackend = async (current: Status) => {
    if (current.uiRestartAvailable && current.restartRequired)
      await requestRestart('/restart', { revision: current.transition?.revision });
  };
  const action = (name: UpgradeTransitionAction, actionName: UpgradeAction = name) =>
    act(async () => {
      if (name === 'validate') {
        setValidationFailure(null);
        setResumeAcknowledgement(null);
      }
      try {
        await request('/action', { action: name, revision: transition?.revision });
        if (name !== 'validate' && guided) await restartBackend(await request<Status>());
      } catch (failure) {
        if (name === 'validate' && mounted.current)
          setValidationFailure({
            token: resumeToken,
            message: failure instanceof Error ? failure.message : 'Local storage validation failed.',
          });
        throw failure;
      }
    }, actionName);
  const validationAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (
      !guided ||
      disabled ||
      !validating ||
      !selectedRuntimeReady ||
      !quiet ||
      transition?.validated ||
      !resumeToken ||
      validationAttempt.current === resumeToken
    )
      return;
    validationAttempt.current = resumeToken;
    void action('validate');
  }, [guided, disabled, validating, selectedRuntimeReady, quiet, transition?.validated, resumeToken]);
  const readyToCopy =
    quiet &&
    initial &&
    status?.copyConfigurationReady !== false &&
    inventory?.capacity?.fits !== false &&
    backupRestored &&
    keyBackedUp &&
    !!backupReference.trim() &&
    (!backupReference.trim().startsWith('browser-backup:') || usesAutomatedBackup) &&
    /^[a-f0-9]{64}$/.test(backupFingerprint) &&
    backupFingerprint === sourceFingerprint;
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
      {status && (
        <p className="app-settings-field-help">
          Running backend: {status.runningBackend}. Selected phase: {transition?.phase ?? 'not configured'}.
        </p>
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
            disabled={busy || awaitingRestart}
            onClick={() =>
              void act(async () => {
                await requestRestart('/prepare', {});
              }, 'prepare')
            }
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
            action="pause"
            primary
            loading={activeAction === 'pause'}
            disabled={disabled || restartRequired}
            onClick={() =>
              void act(async () => {
                setInventory(null);
                const checked = await request<Inventory>('/inventory');
                if (mounted.current) setInventory(checked);
                if (!checked.capacity?.fits)
                  throw new Error('Capacity inspection did not pass. No writes were paused. Review source details.');
                await request('/pause', {});
                const paused = await request<Status>();
                if (paused.maintenance && paused.drain?.ready && !paused.restartRequired)
                  await request('/backup', { revision: paused.transition?.revision });
              }, 'pause')
            }
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
              disabled={disabled || !initial || !!status?.maintenance || restartRequired}
              onClick={() =>
                void act(async () => {
                  setInventory(null);
                  const next = await request<Inventory>('/inventory');
                  if (mounted.current) setInventory(next);
                }, 'inspect')
              }
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
              disabled={disabled || !inventory || !initial || !!status?.maintenance || restartRequired}
              onClick={() =>
                void act(async () => {
                  await request('/pause', {});
                }, 'pause')
              }
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
              disabled={disabled || restartRequired}
              onClick={() =>
                void act(async () => {
                  await request('/backup', { revision: transition?.revision });
                }, 'backup')
              }
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
                  onClick={() => downloadBackup()}
                >
                  Download verified backup
                </LoadingButton>
                {settingsEncryptionRequired && (
                  <LoadingButton
                    className="local-upgrade-action button-size-l"
                    isDisabled={disabled || status?.copyConfigurationReady === false}
                    onClick={() => downloadBackup(true)}
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
                  disabled={disabled || restartRequired}
                  onClick={() =>
                    void act(async () => {
                      setFrozenSource(null);
                      const next = await request<{ sourceFingerprint: string }>('/fingerprint');
                      if (mounted.current && status?.maintenance)
                        setFrozenSource({
                          pausedAt: status.maintenance.enteredAt,
                          fingerprint: next.sourceFingerprint,
                        });
                    }, 'fingerprint')
                  }
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
                      onChange={(event) => {
                        setBackupReference(event.currentTarget.value);
                        setBackupRestoredFor(null);
                        setKeyBackedUpFor(null);
                      }}
                      maxLength={512}
                    />
                  </label>
                  <label className="app-settings-field">
                    <span className="app-settings-field-label">Restored backup fingerprint</span>
                    <TextField
                      aria-label="Restored backup fingerprint"
                      value={backupFingerprint}
                      isDisabled={disabled}
                      onChange={(event) => {
                        setBackupFingerprint(event.currentTarget.value.trim());
                        setBackupRestoredFor(null);
                        setKeyBackedUpFor(null);
                      }}
                      maxLength={64}
                    />
                  </label>
                </div>
              </div>
            </details>
            <div className="app-settings-field-grid">
              <BooleanSetting
                checked={backupRestored}
                disabled={disabled || backupToken === null}
                onChange={(checked) => setBackupRestoredFor(checked ? backupToken : null)}
                label={
                  usesAutomatedBackup
                    ? 'I saved the verified backup download securely outside this VM.'
                    : 'I restored a separate backup of all four source roots.'
                }
              />
              {settingsEncryptionRequired && (
                <BooleanSetting
                  checked={keyBackedUp}
                  disabled={disabled || backupToken === null}
                  onChange={(checked) => setKeyBackedUpFor(checked ? backupToken : null)}
                  label="I backed up the local settings encryption key separately."
                />
              )}
            </div>
            {backupToken === null && (
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
          disabled={disabled || !readyToCopy || restartRequired}
          onClick={() =>
            void act(async () => {
              await request('/copy', {
                revision: transition?.revision,
                backupReference,
                backupSourceFingerprint: backupFingerprint,
                backupRestored,
                ...(settingsEncryptionRequired ? { encryptionKeyBackedUp: keyBackedUp } : {}),
                ...(['interrupted', 'failed'].includes(status?.job?.phase ?? '')
                  ? { retryJobId: status!.job!.id }
                  : {}),
              });
            }, 'copy')
          }
        >
          {['interrupted', 'failed'].includes(status?.job?.phase ?? '')
            ? 'Retry copy and verification'
            : 'Copy and verify'}
        </UpgradeActionButton>
        {status?.job && (
          <p className="app-settings-field-help" role="status">
            Copy status: {status.job.phase}. {status.job.stage && `Stage: ${status.job.stage}. `}
            {status.job.message}
            {status.job.failure &&
              ` Failure: ${status.job.failure.code} at ${status.job.failure.stage}. Download the diagnostic report; no exception contents or secrets are included.`}
            {status.job.failure?.reason &&
              Object.hasOwn(LOCAL_UPGRADE_FAILURE_REASONS, status.job.failure.reason) &&
              ` ${LOCAL_UPGRADE_FAILURE_REASONS[status.job.failure.reason]}`}
            {status.job.failure?.sourceReference &&
              /^[a-f0-9]{16}$/.test(status.job.failure.sourceReference) &&
              ` Project reference: ${status.job.failure.sourceReference}.`}
            {projectDiagnostic?.token === diagnosticToken &&
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
          disabled={disabled || transition?.phase !== 'verified' || !quiet}
          onClick={() => void action('activate')}
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
            onClick={() =>
              void act(async () => {
                await restartBackend(status!);
              }, 'restart')
            }
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
            disabled={disabled || !validating || !quiet || !selectedRuntimeReady}
            onClick={() => void action('validate')}
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
            disabled={disabled || !runtimeValidationPassed || !!currentValidationFailure}
            checked={resumeConfirmed}
            onChange={(checked) => setResumeAcknowledgement(checked ? resumeToken : null)}
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
          disabled={disabled || !runtimeValidationPassed || !resumeConfirmed || !!currentValidationFailure}
          onClick={() => void action('resume')}
        >
          Resume writes
        </UpgradeActionButton>
        {quiet && resumed && (
          <UpgradeActionButton
            action="finish-resume"
            loading={activeAction === 'finish-resume'}
            disabled={disabled || restartRequired}
            onClick={() => void action('resume', 'finish-resume')}
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
              disabled={disabled || !transition?.canReturnToLegacy || !quiet}
              onClick={() => void action('return-to-legacy')}
            >
              Return to legacy while paused
            </UpgradeActionButton>
            <UpgradeActionButton
              action="cancel"
              loading={activeAction === 'cancel'}
              disabled={disabled || !initial || !quiet || restartRequired}
              onClick={() => void action('cancel')}
            >
              Resume unchanged legacy
            </UpgradeActionButton>
          </>
        )}
        <UpgradeActionButton
          action="report"
          loading={activeAction === 'report'}
          disabled={disabled || (!transition?.generationId && !status?.job)}
          onClick={() =>
            void act(async () => {
              const report = await request<{ generationId?: string; job?: { id: string } }>('/report');
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
              );
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `rivet-local-upgrade-${report.generationId ?? report.job?.id}.json`;
              anchor.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 0);
            }, 'report')
          }
        >
          Download verification report
        </UpgradeActionButton>
      </section>
    </section>
  );
}
