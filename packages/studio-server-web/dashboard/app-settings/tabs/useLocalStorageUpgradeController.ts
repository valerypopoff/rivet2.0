import { useEffect, useRef, useState } from 'react';
import { RIVET_API_BASE_URL } from '@valerypopoff/rivet-studio-server-shared/hosted-env';
import type {
  LocalUpgradeInventory as Inventory,
  LocalUpgradePreparationKind,
  LocalUpgradeDuplicateRepairChoices,
} from '@valerypopoff/rivet-studio-server-shared/local-upgrade-types';
import { parseJsonResponse } from '../../apiRequest';
import {
  deriveLocalStorageUpgradeState,
  deriveLocalUpgradeDiagnostics,
  type LocalStorageUpgradeStatus as Status,
  type LocalStorageUpgradeSetup,
  type UpgradeAction,
  type UpgradeTransitionAction,
} from './localStorageUpgradeModel';

const base = `${RIVET_API_BASE_URL}/app-settings/local-upgrade`;
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

/** One tab-mount lifetime; durable work and cross-session fencing remain server-owned. */
export function useLocalStorageUpgradeController() {
  const [setup, setSetup] = useState<LocalStorageUpgradeSetup | null>(null);
  const setupSnapshot = useRef(setup);
  const [status, setStatus] = useState<Status | null>(null);
  const [projectDiagnostic, setProjectDiagnostic] = useState<{ token: string; paths: string[] } | null>(null);
  const diagnostics = deriveLocalUpgradeDiagnostics(status);
  const { diagnosticToken, diagnosticReference } = diagnostics;
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
  const preparationRequest = useRef<string | null>(null);
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
        if (next.preparation?.id === preparationRequest.current) {
          // Reconcile only this acknowledgement. The retained job must not
          // erase diagnostics from later, unrelated operator actions.
          preparationRequest.current = null;
          setError(null);
        }
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
  const { evidence, ...derived } = deriveLocalStorageUpgradeState({
    setup,
    status,
    inventory,
    pendingAction,
    awaitingRestart,
    statusError,
    backupReference,
    backupFingerprint,
    frozenSource,
    backupRestoredFor,
    keyBackedUpFor,
    resumeAcknowledgement,
    validationFailure,
  });
  const {
    transition,
    preparation,
    disabled,
    guided,
    validating,
    selectedRuntimeReady,
    quiet,
    automatedBackup,
    backupRestored,
    keyBackedUp,
    settingsEncryptionRequired,
    retryJob,
  } = derived;
  const { backupToken, resumeToken, normalizedBackupReference } = evidence;
  useEffect(() => {
    if (!status?.repair?.id) return;
    setFrozenSource(null);
    setBackupRestoredFor(null);
    setKeyBackedUpFor(null);
    setInventory(null);
  }, [status?.repair?.id]);
  useEffect(() => {
    if (status?.preparationStatusUnreadable) {
      setInventory(null);
      setFrozenSource(null);
      setBackupRestoredFor(null);
      setKeyBackedUpFor(null);
      return;
    }
    if (!preparation || preparation.revision !== transition?.revision) return;
    if (['inspect', 'pause-backup', 'repair', 'repair-recover'].includes(preparation.kind))
      setInventory(preparation.phase === 'running' ? null : preparation.inventory ?? null);
    if (preparation.kind === 'fingerprint') {
      // Another operator's retry invalidates old browser evidence too. A failed
      // or interrupted new read must not silently revive the previous proof.
      setBackupRestoredFor(null);
      setKeyBackedUpFor(null);
      setFrozenSource(
        preparation.phase === 'ready' &&
          preparation.fingerprint &&
          preparation.fingerprint.pausedAt === status?.maintenance?.enteredAt
          ? { pausedAt: preparation.fingerprint.pausedAt, fingerprint: preparation.fingerprint.sourceFingerprint }
          : null,
      );
    }
  }, [
    preparation?.id,
    preparation?.phase,
    transition?.revision,
    status?.maintenance?.enteredAt,
    status?.preparationStatusUnreadable,
  ]);
  const startPreparation = async (
    kind: LocalUpgradePreparationKind,
    repairChoices?: LocalUpgradeDuplicateRepairChoices,
  ) => {
    const id = crypto.randomUUID();
    preparationRequest.current = id;
    await request(
      '/preparation',
      { id, kind, revision: transition?.revision, ...(repairChoices ? { repairChoices } : {}) },
      AbortSignal.timeout(10_000),
    );
  };
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
  const inspectDuplicates = () => void act(() => startPreparation('repair-inspect'), 'repair');
  const repairDuplicates = (choices: LocalUpgradeDuplicateRepairChoices) =>
    void act(async () => {
      setFrozenSource(null);
      setBackupRestoredFor(null);
      setKeyBackedUpFor(null);
      setInventory(null);
      await startPreparation('repair', choices);
    }, 'repair');
  const recoverDuplicates = () => void act(() => startPreparation('repair-recover'), 'repair');
  const prepareServer = () =>
    void act(async () => {
      await requestRestart('/prepare', {});
    }, 'prepare');
  const pauseAndBackup = () =>
    void act(async () => {
      setInventory(null);
      if (status?.preparationJobsAvailable) {
        await startPreparation('pause-backup');
        return;
      }
      const checked = await request<Inventory>('/inventory');
      if (mounted.current) setInventory(checked);
      if (!checked.capacity?.fits)
        throw new Error('Capacity inspection did not pass. No writes were paused. Review source details.');
      await request('/pause', {});
      const paused = await request<Status>();
      if (paused.maintenance && paused.drain?.ready && !paused.restartRequired)
        await request('/backup', { revision: paused.transition?.revision });
    }, 'pause');
  const inspectSource = () =>
    void act(async () => {
      setInventory(null);
      if (status?.preparationJobsAvailable) {
        await startPreparation('inspect');
        return;
      }
      const next = await request<Inventory>('/inventory');
      if (mounted.current) setInventory(next);
    }, 'inspect');
  const pauseWrites = () =>
    void act(async () => {
      if (status?.preparationJobsAvailable) await startPreparation('pause');
      else await request('/pause', {});
    }, 'pause');
  const createBackup = () =>
    void act(async () => {
      if (status?.preparationJobsAvailable) await startPreparation('backup');
      else await request('/backup', { revision: transition?.revision });
    }, 'backup');
  const readFingerprint = () =>
    void act(async () => {
      setFrozenSource(null);
      if (status?.preparationJobsAvailable) {
        await startPreparation('fingerprint');
        return;
      }
      const next = await request<{ sourceFingerprint: string }>('/fingerprint');
      if (mounted.current && status?.maintenance)
        setFrozenSource({
          pausedAt: status.maintenance.enteredAt,
          fingerprint: next.sourceFingerprint,
        });
    }, 'fingerprint');
  const editBackupReference = (value: string) => {
    setBackupReference(value);
    setBackupRestoredFor(null);
    setKeyBackedUpFor(null);
  };
  const editBackupFingerprint = (value: string) => {
    setBackupFingerprint(value.trim());
    setBackupRestoredFor(null);
    setKeyBackedUpFor(null);
  };
  const confirmBackupRestored = (checked: boolean) => setBackupRestoredFor(checked ? backupToken : null);
  const confirmKeyBackedUp = (checked: boolean) => setKeyBackedUpFor(checked ? backupToken : null);
  const copy = () =>
    void act(async () => {
      await request('/copy', {
        revision: transition?.revision,
        backupReference: normalizedBackupReference,
        backupSourceFingerprint: backupFingerprint,
        backupRestored,
        ...(settingsEncryptionRequired ? { encryptionKeyBackedUp: keyBackedUp } : {}),
        ...(retryJob ? { retryJobId: retryJob.id } : {}),
      });
    }, 'copy');
  const restart = () =>
    void act(async () => {
      await restartBackend(status!);
    }, 'restart');
  const confirmResume = (checked: boolean) => setResumeAcknowledgement(checked ? resumeToken : null);
  const downloadReport = () =>
    void act(async () => {
      const report = await request<{ generationId?: string; job?: { id: string } }>('/report');
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `rivet-local-upgrade-${report.generationId ?? report.job?.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'report');
  return {
    state: {
      status,
      projectDiagnostic,
      inventory,
      awaitingRestart,
      error,
      statusError,
      backupReference,
      backupFingerprint,
      downloadStarted,
    },
    derived: {
      ...derived,
      preparationReference: diagnostics.preparationReference,
      preparationDiagnosticToken: diagnostics.preparationDiagnosticToken,
      copyDiagnosticToken: diagnostics.copyDiagnosticToken,
      repairDownloadUrl: status?.repair
        ? `${base}/repair/download?id=${encodeURIComponent(status.repair.id)}`
        : undefined,
    },
    actions: {
      inspectDuplicates,
      repairDuplicates,
      recoverDuplicates,
      prepareServer,
      pauseAndBackup,
      inspectSource,
      pauseWrites,
      createBackup,
      readFingerprint,
      editBackupReference,
      editBackupFingerprint,
      confirmBackupRestored,
      confirmKeyBackedUp,
      copy,
      restart,
      confirmResume,
      downloadReport,
      transitionAction: action,
      downloadBackup,
    },
  };
}
