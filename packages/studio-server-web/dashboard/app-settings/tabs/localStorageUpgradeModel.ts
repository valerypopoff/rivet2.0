import type {
  LocalUpgradeFailureReason,
  LocalUpgradeOperation,
  LocalUpgradeInventory,
  LocalUpgradePreparation,
  LocalUpgradeDuplicateRepairStatus,
} from '@valerypopoff/rivet-studio-server-shared/local-upgrade-types';

export type LocalStorageUpgradeStatus = {
  duplicateRepairAvailable?: boolean;
  repair?: LocalUpgradeDuplicateRepairStatus | null;
  repairStatusUnreadable?: boolean;
  preparationJobsAvailable?: boolean;
  preparation?: LocalUpgradePreparation | null;
  preparationStatusUnreadable?: boolean;
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
    sourceFingerprint?: string;
    backupReference?: string;
    stage?: string;
    failure?: { stage: string; code: string; reason?: LocalUpgradeFailureReason; sourceReference?: string } | null;
  } | null;
};
export type LocalStorageUpgradeSetup = {
  eligible: boolean;
  sqliteSelected?: boolean;
  uiPreparationAvailable?: boolean;
  uiRestartAvailable?: boolean;
  upgradeEnabled: boolean;
  controlRootConfigured: boolean;
  encryptionKeyReady: boolean;
};
export type UpgradeAction = LocalUpgradeOperation | 'finish-resume' | 'report';
export type UpgradeTransitionAction = Exclude<
  LocalUpgradeOperation,
  'prepare' | 'restart' | 'inspect' | 'pause' | 'fingerprint' | 'copy' | 'backup' | 'repair'
>;

export type LocalStorageUpgradeModelState = {
  setup: LocalStorageUpgradeSetup | null;
  status: LocalStorageUpgradeStatus | null;
  inventory: LocalUpgradeInventory | null;
  pendingAction: UpgradeAction | null;
  awaitingRestart: boolean;
  statusError: string | null;
  backupReference: string;
  backupFingerprint: string;
  frozenSource: { pausedAt: string; fingerprint: string } | null;
  backupRestoredFor: string | null;
  keyBackedUpFor: string | null;
  resumeAcknowledgement: string | null;
  validationFailure: { token: string | null; message: string } | null;
};

export function deriveLocalUpgradeDiagnostics(status: LocalStorageUpgradeStatus | null) {
  const preparationReference =
    status?.preparation?.phase === 'failed' && status.preparation.revision === status.transition?.revision
      ? status.preparation.failure?.sourceReference
      : undefined;
  const copyReference = status?.job?.phase === 'failed' ? status.job.failure?.sourceReference : undefined;
  const preparationDiagnosticToken = preparationReference
    ? `preparation:${status?.preparation?.id}:${preparationReference}`
    : null;
  const copyDiagnosticToken = copyReference ? `copy:${status?.job?.id}:${copyReference}` : null;
  const diagnosticReference = preparationReference ?? copyReference;
  const diagnosticToken = preparationDiagnosticToken ?? copyDiagnosticToken;
  return {
    preparationReference,
    copyReference,
    preparationDiagnosticToken,
    copyDiagnosticToken,
    diagnosticReference,
    diagnosticToken,
  };
}

/** Pure policy for the current server snapshot and this browser's attestations. */
export function deriveLocalStorageUpgradeState({
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
}: LocalStorageUpgradeModelState) {
  const busy = pendingAction !== null;
  const transition = status?.transition;
  const preparation = status?.preparation;
  const repairAnalysis =
    preparation?.revision === transition?.revision && preparation?.phase !== 'running'
      ? preparation?.repairAnalysis
      : undefined;
  const guided = status?.uiRestartAvailable === true || setup?.uiRestartAvailable === true;
  const needsPreparation =
    setup?.eligible && !setup.sqliteSelected && setup.uiPreparationAvailable && !status?.available;
  const resumed = transition?.phase === 'sqlite-live' || transition?.phase === 'legacy-resumed';
  const repairRunning =
    preparation?.phase === 'running' && ['repair', 'repair-recover', 'repair-inspect'].includes(preparation.kind);
  const activeAction =
    pendingAction ??
    (repairRunning
      ? 'repair'
      : preparation?.phase === 'running' && preparation.kind === 'pause-backup' && preparation.stage !== 'backup'
        ? 'pause'
        : status?.operation === 'resume' && resumed
          ? 'finish-resume'
          : status?.operation);
  const copying = status?.job?.phase === 'copying';
  const operationDisabled =
    busy || awaitingRestart || !!status?.operation || preparation?.phase === 'running' || copying || !status?.available;
  const repairBlocked = status?.repair?.phase === 'applying' || status?.repairStatusUnreadable === true;
  const disabled = operationDisabled || repairBlocked;
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
  const normalizedBackupReference = backupReference.trim();
  const usesAutomatedBackup =
    !!automatedBackup &&
    normalizedBackupReference === `browser-backup:${automatedBackup.id}:${automatedBackup.archiveHash}`;
  const sourceFingerprint =
    frozenSource?.pausedAt === status?.maintenance?.enteredAt ? frozenSource?.fingerprint ?? '' : '';
  const backupToken =
    sourceFingerprint && normalizedBackupReference && backupFingerprint === sourceFingerprint
      ? JSON.stringify([
          status?.maintenance?.enteredAt,
          transition?.revision,
          sourceFingerprint,
          normalizedBackupReference,
        ])
      : null;
  const backupRestored = backupToken !== null && backupRestoredFor === backupToken;
  const retainedCopy = ['interrupted', 'failed'].includes(status?.job?.phase ?? '') ? status?.job : null;
  const retryJob =
    backupToken !== null &&
    retainedCopy?.sourceFingerprint === sourceFingerprint &&
    retainedCopy.backupReference === normalizedBackupReference
      ? retainedCopy
      : null;
  const previousCopy = backupToken !== null && !!retainedCopy && !retryJob;
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
  const readyToCopy =
    quiet &&
    initial &&
    status?.copyConfigurationReady !== false &&
    inventory?.capacity?.fits !== false &&
    backupRestored &&
    keyBackedUp &&
    (!normalizedBackupReference.startsWith('browser-backup:') || usesAutomatedBackup) &&
    /^[a-f0-9]{64}$/.test(backupFingerprint) &&
    backupFingerprint === sourceFingerprint;
  const controlDisabled = {
    prepare: busy || awaitingRestart || statusError !== null,
    repair: operationDisabled || !!status?.repairStatusUnreadable || restartRequired,
    storage: disabled || restartRequired,
    inspect: disabled || !initial || !!status?.maintenance || restartRequired,
    pause: disabled || !inventory || !initial || !!status?.maintenance || restartRequired,
    keyDownload: disabled || status?.copyConfigurationReady === false,
    backupConfirmation: disabled || backupToken === null,
    copy: disabled || !readyToCopy || restartRequired,
    activate: disabled || transition?.phase !== 'verified' || !quiet,
    validate: disabled || !validating || !quiet || !selectedRuntimeReady,
    resumeConfirmation: disabled || !runtimeValidationPassed || !!currentValidationFailure,
    resume: disabled || !runtimeValidationPassed || !resumeConfirmed || !!currentValidationFailure,
    returnToLegacy: disabled || !transition?.canReturnToLegacy || !quiet,
    cancel: disabled || !initial || !quiet || restartRequired,
    report: disabled || (!transition?.generationId && !status?.job),
  };
  return {
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
    hasBackupEvidence: backupToken !== null,
    evidence: { backupToken, resumeToken, normalizedBackupReference },
  };
}
