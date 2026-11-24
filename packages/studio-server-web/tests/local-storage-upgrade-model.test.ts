import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveLocalStorageUpgradeState,
  deriveLocalUpgradeDiagnostics,
  type LocalStorageUpgradeModelState,
  type LocalStorageUpgradeStatus,
} from '../dashboard/app-settings/tabs/localStorageUpgradeModel';

const fingerprint = 'a'.repeat(64);
const backupToken = `["paused",7,"${fingerprint}","archive"]`;

function status(): LocalStorageUpgradeStatus {
  return {
    available: true,
    runningBackend: 'legacy',
    maintenance: { enteredAt: 'paused' },
    drain: { ready: true, blockers: [] },
    restartRequired: false,
    transition: {
      revision: 7,
      phase: 'legacy',
      backend: 'legacy',
      generationId: null,
      canReturnToLegacy: false,
      validated: false,
    },
    job: null,
  };
}

function state(): LocalStorageUpgradeModelState {
  return {
    setup: null,
    status: status(),
    inventory: null,
    pendingAction: null,
    awaitingRestart: false,
    statusError: null,
    backupReference: '  archive  ',
    backupFingerprint: fingerprint,
    frozenSource: { pausedAt: 'paused', fingerprint },
    backupRestoredFor: backupToken,
    keyBackedUpFor: backupToken,
    resumeAcknowledgement: null,
    validationFailure: null,
  };
}

void test('backup attestation retains the existing serialized identity and excludes generation', () => {
  const input = state();
  const result = deriveLocalStorageUpgradeState(input);
  assert.equal(result.evidence.backupToken, backupToken);
  assert.equal(result.backupRestored, true);
  assert.equal(result.keyBackedUp, true);
  assert.equal(result.controlDisabled.copy, false);
  input.status!.transition!.generationId = 'another-generation';
  assert.equal(deriveLocalStorageUpgradeState(input).evidence.backupToken, backupToken);
});

void test('changed backup identity cannot reuse either browser attestation', () => {
  const changes: Array<(input: LocalStorageUpgradeModelState) => void> = [
    (input) => {
      input.backupReference = 'another-archive';
    },
    (input) => {
      input.backupFingerprint = 'b'.repeat(64);
    },
    (input) => {
      input.status!.transition!.revision++;
    },
    (input) => {
      input.status!.maintenance!.enteredAt = 'another-pause';
    },
    (input) => {
      input.frozenSource = { pausedAt: 'paused', fingerprint: 'b'.repeat(64) };
    },
  ];
  for (const change of changes) {
    const input = state();
    change(input);
    const result = deriveLocalStorageUpgradeState(input);
    assert.equal(result.backupRestored, false);
    assert.equal(result.keyBackedUp, false);
    assert.equal(result.controlDisabled.copy, true);
  }
});

void test('older capability absence preserves manual readiness, copy admission and key requirements', () => {
  const input = state();
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, false);
  input.keyBackedUpFor = null;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, true);
  input.status!.settingsEncryptionRequired = false;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, false);
  input.status!.copyConfigurationReady = false;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, true);
  input.status!.copyConfigurationReady = true;
  input.setup = {
    eligible: true,
    upgradeEnabled: true,
    controlRootConfigured: true,
    encryptionKeyReady: true,
    uiRestartAvailable: true,
  };
  assert.equal(deriveLocalStorageUpgradeState(input).selectedRuntimeReady, false);
  input.status!.runtimeReady = true;
  assert.equal(deriveLocalStorageUpgradeState(input).selectedRuntimeReady, true);
});

void test('capacity refusal blocks copying while absent capacity remains compatible', () => {
  const input = state();
  input.inventory = {
    source: {},
    inventory: null,
    backupRequired: 'Restore independently.',
    capacity: { payloadBytes: 1, freeBytes: 1, requiredBytes: 2, maxPayloadBytes: 10, fits: false },
  };
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, true);
  input.status!.maintenance = null;
  input.status!.drain = null;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.pause, false);
});

void test('preparation has its own availability rule and repair recovery is not globally disabled', () => {
  const input = state();
  input.status = null;
  input.setup = {
    eligible: true,
    uiPreparationAvailable: true,
    upgradeEnabled: false,
    controlRootConfigured: false,
    encryptionKeyReady: false,
  };
  const preparing = deriveLocalStorageUpgradeState(input);
  assert.equal(preparing.needsPreparation, true);
  assert.equal(preparing.disabled, true);
  assert.equal(preparing.controlDisabled.prepare, false);
  input.awaitingRestart = true;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.prepare, true);
  input.awaitingRestart = false;
  input.statusError = 'Setup could not be refreshed.';
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.prepare, true);
  input.statusError = null;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.prepare, false);
  input.status = status();
  input.status.repair = { id: 'repair', phase: 'applying', archiveHash: 'hash', assignments: [], changedFiles: 0 };
  assert.equal(deriveLocalStorageUpgradeState(input).disabled, true);
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.repair, false);
  input.status.repairStatusUnreadable = true;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.repair, true);
});

void test('browser-backup references require the current certified archive identity', () => {
  const input = state();
  input.backupReference = 'browser-backup:backup:hash';
  const token = `["paused",7,"${fingerprint}","browser-backup:backup:hash"]`;
  input.backupRestoredFor = token;
  input.keyBackedUpFor = token;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, true);
  input.status!.backup = {
    id: 'backup',
    revision: 7,
    pausedAt: 'paused',
    phase: 'ready',
    sourceFingerprint: fingerprint,
    archiveHash: 'hash',
    bytes: 1,
  };
  const current = deriveLocalStorageUpgradeState(input);
  assert.equal(current.usesAutomatedBackup, true);
  assert.equal(current.automatedBackup, input.status!.backup);
  assert.equal(current.controlDisabled.copy, false);
  input.status!.backup.revision++;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.copy, true);
});

void test('retry admission reuses only matching failed or interrupted evidence', () => {
  for (const phase of ['failed', 'interrupted']) {
    const input = state();
    input.status!.job = { id: 'job', phase, message: null, sourceFingerprint: fingerprint, backupReference: 'archive' };
    assert.equal(deriveLocalStorageUpgradeState(input).retryJob, input.status!.job);
    input.status!.job.backupReference = 'previous-archive';
    const previous = deriveLocalStorageUpgradeState(input);
    assert.equal(previous.retryJob, null);
    assert.equal(previous.previousCopy, true);
    input.backupFingerprint = '';
    assert.equal(deriveLocalStorageUpgradeState(input).previousCopy, false);
  }
});

void test('resumption binds the current generation, phase, revision and maintenance', () => {
  const input = state();
  input.status!.transition = {
    revision: 7,
    phase: 'sqlite-validation',
    backend: 'sqlite',
    generationId: 'generation',
    validated: true,
    canReturnToLegacy: true,
  };
  input.status!.runningBackend = 'sqlite';
  input.resumeAcknowledgement = 'generation:sqlite-validation:7:paused';
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.resume, false);
  const replacements = [{ generationId: 'next' }, { phase: 'legacy-validation' }, { revision: 8 }];
  for (const replacement of replacements) {
    const changed: LocalStorageUpgradeModelState = {
      ...input,
      status: { ...input.status!, transition: { ...input.status!.transition!, ...replacement } },
    };
    assert.equal(deriveLocalStorageUpgradeState(changed).resumeConfirmed, false);
  }
  input.status!.maintenance!.enteredAt = 'next-pause';
  assert.equal(deriveLocalStorageUpgradeState(input).resumeConfirmed, false);
});

void test('validation needs durable success, current runtime and no current local failure', () => {
  const input = state();
  input.status!.transition = {
    revision: 7,
    phase: 'legacy-validation',
    backend: 'legacy',
    generationId: 'generation',
    validated: true,
    canReturnToLegacy: false,
  };
  input.resumeAcknowledgement = 'generation:legacy-validation:7:paused';
  input.validationFailure = { token: input.resumeAcknowledgement, message: 'Validation refused.' };
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.resume, true);
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.resumeConfirmation, true);
  input.validationFailure.token = 'previous-token';
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.resume, false);
  input.status!.transition.validated = false;
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.resume, true);
  input.status!.transition.validated = true;
  input.status!.runningBackend = 'sqlite';
  assert.equal(deriveLocalStorageUpgradeState(input).controlDisabled.validate, true);
  assert.equal(deriveLocalStorageUpgradeState(input).runtimeValidationPassed, false);
});

void test('pending progress wins and durable resumption keeps its distinct action identity', () => {
  const input = state();
  input.status!.transition!.phase = 'legacy-resumed';
  input.status!.operation = 'resume';
  assert.equal(deriveLocalStorageUpgradeState(input).activeAction, 'finish-resume');
  input.pendingAction = 'report';
  assert.equal(deriveLocalStorageUpgradeState(input).activeAction, 'report');
  input.pendingAction = null;
  input.status!.operation = null;
  const finished = deriveLocalStorageUpgradeState(input);
  assert.equal(finished.resumed, true);
  assert.equal(finished.controlDisabled.storage, false);
  assert.equal(finished.controlDisabled.resume, true);
  input.status!.preparation = {
    id: 'preparation',
    kind: 'pause-backup',
    revision: 7,
    phase: 'running',
    stage: 'inspect',
  };
  assert.equal(deriveLocalStorageUpgradeState(input).activeAction, 'pause');
  input.status!.preparation.kind = 'repair-recover';
  assert.equal(deriveLocalStorageUpgradeState(input).activeAction, 'repair');
});

void test('diagnostics select current preparation provenance before retained copy evidence', () => {
  const current = status();
  current.preparation = {
    id: 'preparation',
    kind: 'inspect',
    revision: 7,
    phase: 'failed',
    stage: 'inspect',
    failure: { code: 'invalid-source', sourceReference: 'a'.repeat(16) },
  };
  current.job = {
    id: 'copy',
    phase: 'failed',
    message: null,
    failure: { stage: 'copy', code: 'invalid-source', sourceReference: 'b'.repeat(16) },
  };
  assert.equal(deriveLocalUpgradeDiagnostics(current).diagnosticToken, 'preparation:preparation:aaaaaaaaaaaaaaaa');
  current.preparation.revision--;
  assert.equal(deriveLocalUpgradeDiagnostics(current).diagnosticToken, 'copy:copy:bbbbbbbbbbbbbbbb');
});
