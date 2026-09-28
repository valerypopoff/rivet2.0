import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getServerUiAuthMode } from '../server-ui-auth.js';
import { getWorkflowStorageBackendMode } from '../routes/workflows/storage-config.js';
import { getAppSettingsBackendKind, checkAppSettingsRepositoriesHealth } from '../app-settings/settings-repository.js';
import { getWorkflowTree, checkWorkflowStorageHealth } from '../routes/workflows/storage-backend.js';
import {
  readVmMigrationMaintenance,
  isVmMigrationMaintenanceActive,
  leaveVmMigrationMaintenance,
} from '../vm-migration-maintenance.js';
import { freezeLocalStorageSource, localStorageDrainSnapshot } from '../vm-migration-service.js';
import { inspectVmMigrationSource } from '../vm-migration-inventory.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { createVerifiedLocalSqliteSnapshot, inspectLocalSqliteSnapshot } from './sqlite-snapshot.js';
import { stageLocalMetadataCandidate } from './stage-local-metadata-candidate.js';
import { getLocalMetadataServingSelection, localMetadataGenerationPaths } from './serving-selection.js';
import { materializeLocalRuntimeLibraries } from './runtime-library-authority.js';
import { LocalWorkflowCatalog } from './workflow-catalog.js';
import {
  assertLocalControlPaths,
  assertLocalGenerationCertificate,
  freshLocalGenerationProof,
  hashLocalUpgradeValue,
  localMetadataControlRoot,
  localMetadataSourceRoots,
  withLocalMetadataControl,
} from './runtime-control.js';
import type { LocalUpgradeJob, LocalUpgradeCertificate } from './operator-store.js';
import type { LocalMetadataGenerationProof } from './transition-journal.js';
import { localMetadataSourceIdentity } from './source-identity.js';
import { inspectLocalCopyCapacity } from './copy-capacity.js';
import { checkRuntimeLibrariesHealth, prepareRuntimeLibrariesForExecution } from '../runtime-libraries/backend.js';
import { FilesystemRivetEvaluationStore } from '../evaluation-runs/filesystem-store.js';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';
import { createRequire } from 'node:module';
import { readSourceManifest } from '../scripts/migrate-runtime-libraries.js';
import { DatabaseSync } from 'node:sqlite';
import { assertEmptyLocalOperationalDatabase, assertLocalOperationalSchema } from './operational-schema.js';
import { localUpgradeFailure, type LocalUpgradeStage, type LocalUpgradeHooks } from './upgrade-diagnostics.js';
import { createHttpError } from '../utils/httpError.js';
import type { LocalUpgradeOperation } from '../../../studio-server-shared/local-upgrade-types.js';

let activeOperation: LocalUpgradeOperation | null = null;
let runningJob: Promise<void> | null = null;
function assertAvailable(): void {
  if (
    process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED !== '1' ||
    process.env.RIVET_LOCAL_METADATA_SUPERVISED !== '1' ||
    process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated' ||
    process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL !== '1' ||
    getServerUiAuthMode() === 'none' ||
    getWorkflowStorageBackendMode() !== 'filesystem'
  )
    throw new Error(
      'Local storage upgrade requires an enabled, authenticated, supervised single-host local deployment.',
    );
  localMetadataControlRoot();
}
async function exclusive<T>(operation: LocalUpgradeOperation, callback: () => Promise<T>): Promise<T> {
  assertAvailable();
  if (activeOperation || runningJob)
    throw createHttpError(
      409,
      'A local storage operation is already running. Wait for it to finish and reload status.',
      {
        code: 'local-upgrade-busy',
      },
    );
  activeOperation = operation;
  try {
    return await callback();
  } finally {
    activeOperation = null;
  }
}
async function assertDrained(): Promise<void> {
  if (!isVmMigrationMaintenanceActive()) throw new Error('Pause writes before copying or changing storage authority.');
  readVmMigrationMaintenance();
  const drain = await localStorageDrainSnapshot();
  if (!drain.ready) throw new Error(`Wait for active work to drain: ${drain.blockers.join(', ')}.`);
}

export async function getLocalUpgradeStatus() {
  let available = true;
  try {
    assertAvailable();
  } catch {
    available = false;
  }
  if (!available)
    return {
      available: false,
      operation: null,
      copyConfigurationReady: false,
      runningBackend: getAppSettingsBackendKind(),
      maintenance: readVmMigrationMaintenance(),
      transition: null,
      job: null,
      drain: null,
      restartRequired: false,
    };
  return withLocalMetadataControl(async (journal, store) => {
    const state = journal.read(),
      selection = getLocalMetadataServingSelection(),
      job = store.latestJob();
    return {
      available: true,
      operation: activeOperation ?? (runningJob ? 'copy' : null),
      copyConfigurationReady: (process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY || '').length >= 32,
      runningBackend: selection ? 'sqlite' : 'legacy',
      maintenance: readVmMigrationMaintenance(),
      transition: {
        revision: state.revision,
        phase: state.phase,
        backend: state.backend,
        paused: state.paused,
        canReturnToLegacy: state.canReturnToLegacy,
        generationId: state.generation?.id ?? null,
        validated: !!state.validationEvidenceHash,
      },
      job:
        job && state.generation?.id === job.id
          ? {
              ...job,
              phase: 'verified',
              message: 'Candidate certification is durable. Use the selected transition state below.',
            }
          : job?.phase === 'copying' && !runningJob
            ? {
                ...job,
                phase: 'interrupted',
                message: 'Copy was interrupted. Source remains selected and paused; retry the same generation.',
              }
            : job,
      drain: isVmMigrationMaintenanceActive() ? await localStorageDrainSnapshot() : null,
      restartRequired:
        (state.backend === 'sqlite' ? selection?.generationId !== state.generation?.id : selection !== null) ||
        (['sqlite-live', 'legacy-resumed', 'legacy'].includes(state.phase) &&
          state.revision !== Number(process.env.RIVET_LOCAL_METADATA_BOOT_REVISION)),
    };
  }, true);
}

export async function inspectLocalUpgradeSource() {
  return exclusive('inspect', async () => {
    if (getLocalMetadataServingSelection()) throw new Error('The local SQLite upgrade is already activated.');
    const source = localMetadataSourceRoots();
    await assertLocalControlPaths(localMetadataControlRoot(), source);
    // Inventory decodes projects and publication history. Refuse oversized
    // sources before that allocation, not only before the eventual copy.
    const capacity = await inspectLocalCopyCapacity(source, localMetadataControlRoot());
    return {
      source,
      inventory: capacity.fits ? await inspectVmMigrationSource() : null,
      capacity,
      backupRequired:
        'Back up all four source roots and the encryption key; restore a separate copy before certifying it. Retained originals are not an off-VM backup.',
    };
  });
}
export async function pauseLocalUpgradeSource(): Promise<void> {
  return exclusive('pause', async () => {
    if (getLocalMetadataServingSelection()) throw new Error('This generation is already selected.');
    await freezeLocalStorageSource();
  });
}

export type LocalUpgradeCopyInput = {
  revision: number;
  backupReference: string;
  backupSourceFingerprint: string;
  backupRestored: boolean;
  encryptionKeyBackedUp: boolean;
  retryJobId?: string;
};
export async function startLocalUpgradeCopy(
  input: LocalUpgradeCopyInput,
  hooks: LocalUpgradeHooks = {},
): Promise<void> {
  input = { ...input };
  hooks = { ...hooks };
  return exclusive('copy', async () => {
    if (getLocalMetadataServingSelection()) throw new Error('A SQLite generation is already selected.');
    await assertDrained();
    if (
      !input.backupRestored ||
      !input.encryptionKeyBackedUp ||
      !input.backupReference.trim() ||
      input.backupReference.length > 512
    )
      throw new Error('A restored backup and a separately backed-up encryption key must be certified.');
    const key = process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY || '';
    if (key.length < 32)
      throw createHttpError(
        409,
        'Configure RIVET_LOCAL_METADATA_ENCRYPTION_KEY with at least 32 securely generated characters, recreate the backend and back up the key separately before copying. No copy was started.',
        { code: 'local-encryption-key-required' },
      );
    const source = localMetadataSourceRoots();
    await assertLocalControlPaths(localMetadataControlRoot(), source);
    const capacity = await inspectLocalCopyCapacity(source, localMetadataControlRoot());
    if (!capacity.fits)
      throw new Error(
        'Local copy exceeds its configured payload budget, candidate disk space or available memory headroom. No copy was started.',
      );
    const sourceFingerprint = await fingerprintVmMigrationSource(source);
    if (input.backupSourceFingerprint !== sourceFingerprint)
      throw new Error('The restored backup fingerprint does not match the frozen source.');
    const job = await withLocalMetadataControl(async (journal, store) => {
      const state = journal.read();
      if (state.revision !== input.revision || !['legacy', 'legacy-resumed'].includes(state.phase))
        throw new Error('Stale upgrade request or an existing verified generation. Reload status.');
      const old = store.latestJob();
      if (input.retryJobId) {
        if (
          !old ||
          old.id !== input.retryJobId ||
          !['copying', 'failed', 'interrupted'].includes(old.phase) ||
          old.sourceFingerprint !== sourceFingerprint ||
          old.backupReference !== input.backupReference
        )
          throw new Error('Retry must use the same frozen source, backup and interrupted generation.');
        const next: LocalUpgradeJob = {
          ...old,
          phase: 'copying',
          stage: 'preflight',
          failure: null,
          finishedAt: null,
          message: null,
        };
        store.saveJob(next);
        return next;
      }
      if (old?.phase === 'copying') throw new Error('Retry the interrupted generation explicitly.');
      const next: LocalUpgradeJob = {
        id: randomUUID(),
        phase: 'copying',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: null,
        sourceFingerprint,
        backupReference: input.backupReference,
        stage: 'preflight',
        failure: null,
      };
      store.saveJob(next);
      return next;
    });
    runningJob = copyGeneration(job, source, key, input.revision, hooks).finally(() => {
      runningJob = null;
    });
  });
}

async function copyGeneration(
  job: LocalUpgradeJob,
  source: ReturnType<typeof localMetadataSourceRoots>,
  key: string,
  revision: number,
  hooks: LocalUpgradeHooks,
): Promise<void> {
  let stage: LocalUpgradeStage = 'preflight';
  const onStage = async (next: LocalUpgradeStage) => {
    stage = next;
    job = { ...job, stage };
    await withLocalMetadataControl(async (_journal, store) => store.saveJob(job));
    await hooks.checkpoint?.(`copy:${stage}`);
  };
  try {
    await onStage('preflight');
    const paths = localMetadataGenerationPaths(localMetadataControlRoot(), job.id);
    await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.operationalRoot, { mode: 0o700, recursive: true });
    const assertFrozen = async () => {
      await assertDrained();
    };
    const report = await stageLocalMetadataCandidate({
      source,
      candidate: paths,
      settingsEncryptionKey: key,
      assertFrozen,
      onStage,
    });
    if (report.sourceFingerprint !== job.sourceFingerprint)
      throw new Error('Source changed after backup certification.');
    await onStage('operational-snapshots');
    const operational: LocalUpgradeCertificate['operational'] = {};
    for (const name of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite']) {
      const file = path.join(source.appData, name);
      try {
        await fs.lstat(file);
        const proof = await createVerifiedLocalSqliteSnapshot({
          sourcePath: file,
          destinationPath: path.join(paths.operationalRoot, name),
          assertFrozen,
        });
        operational[name] = proof.logicalHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Missing means a genuinely empty domain, not permission for serving
        // startup to create an uncertified database after activation.
        const destination = path.join(paths.operationalRoot, name);
        if (name === 'evaluation-runs.sqlite') {
          const empty = new FilesystemRivetEvaluationStore(destination);
          try {
            await empty.getLibrarySnapshot();
          } finally {
            await empty.dispose();
          }
        } else {
          const empty = new FilesystemRivetLLMProfileHealthStore(destination);
          try {
            await empty.list();
          } finally {
            await empty.dispose();
          }
        }
        const emptyDatabase = new DatabaseSync(destination, { readOnly: true });
        try {
          assertEmptyLocalOperationalDatabase(
            emptyDatabase,
            name === 'evaluation-runs.sqlite' ? 'evaluations' : 'health',
          );
        } finally {
          emptyDatabase.close();
        }
        operational[name] = (await inspectLocalSqliteSnapshot(destination)).logicalHash;
      }
    }
    for (const [name, domain] of [
      ['evaluation-runs.sqlite', 'evaluations'],
      ['llm-profile-health.sqlite', 'health'],
    ] as const) {
      const database = new DatabaseSync(path.join(paths.operationalRoot, name), { readOnly: true });
      try {
        assertLocalOperationalSchema(database, domain);
      } finally {
        database.close();
      }
    }
    await onStage('runtime-cache');
    const catalog = new LocalWorkflowCatalog({
      databasePath: paths.catalogDatabasePath,
      artifactRoot: paths.artifactRoot,
    });
    try {
      catalog.initialize({ verifyOnly: true, requireExisting: true });
      const state = await catalog.readRuntimeLibraryState();
      if (!state) throw new Error('Missing runtime activation.');
      await materializeLocalRuntimeLibraries(paths.runtimeCacheRoot, state);
    } finally {
      catalog.close();
    }
    await assertFrozen();
    await onStage('certification');
    const certificate: LocalUpgradeCertificate = {
      version: 1,
      generationId: job.id,
      source,
      backupReference: job.backupReference!,
      backupConfirmedAt: job.startedAt,
      encryptionKeyId: hashLocalUpgradeValue(key),
      report,
      operational,
    };
    const proof = await freshLocalGenerationProof(certificate);
    if (proof.sourceFingerprint !== job.sourceFingerprint)
      throw new Error('Source changed before candidate certification.');
    await withLocalMetadataControl(async (journal, store) => {
      store.saveCertificate(certificate);
      await hooks.checkpoint?.('copy:certificate-committed');
      journal.recordVerifiedCandidate(revision, proof);
      await hooks.checkpoint?.('copy:selection-certified');
      store.saveJob({
        ...job,
        phase: 'verified',
        finishedAt: new Date().toISOString(),
        message: 'Copied and exactly verified. Legacy remains selected; writes remain paused.',
      });
    });
  } catch (error) {
    // Do not log or persist raw errors: they can contain package scripts,
    // workflow inputs, provider credentials or encrypted settings material.
    await withLocalMetadataControl(async (_journal, store) => {
      store.saveJob({
        ...job,
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        stage,
        failure: localUpgradeFailure(stage, error),
        message:
          'Copy or verification failed. Legacy source is untouched and writes remain paused. Repair the source/space/key issue and retry, or resume legacy.',
      });
    }).catch(() => undefined);
  }
}

export async function localUpgradeBackupFingerprint(): Promise<string> {
  return exclusive('fingerprint', async () => {
    await assertDrained();
    return fingerprintVmMigrationSource(localMetadataSourceRoots());
  });
}
export async function getLocalUpgradeReport() {
  assertAvailable();
  return withLocalMetadataControl(async (journal, store) => {
    const state = journal.read();
    const generation = state.generation;
    const job = store.latestJob();
    // A returned generation remains in the transition journal for recovery.
    // It must not masquerade as the certificate for a newer, failed copy.
    if (!generation || (job && job.id !== generation.id)) {
      if (!job) throw new Error('No local upgrade job report.');
      return {
        verified: false,
        job,
        sourceAuthority: state.backend,
        writesMustRemainPaused: isVmMigrationMaintenanceActive(),
      };
    }
    const certificate = store.certificate(generation.id);
    return {
      generationId: generation.id,
      sourceFingerprint: generation.sourceFingerprint,
      candidateFingerprint: generation.candidateFingerprint,
      reportHash: generation.reportHash,
      backupReference: certificate.backupReference,
      backupCertification:
        'Operator attested a separately restored backup and encryption key; not an automated off-VM backup service.',
      report: certificate.report,
      operational: certificate.operational,
    };
  }, true);
}
export async function transitionLocalUpgrade(
  action: 'activate' | 'validate' | 'return-to-legacy' | 'resume' | 'cancel',
  revision: number,
  hooks: LocalUpgradeHooks = {},
): Promise<void> {
  hooks = { ...hooks };
  return exclusive(action, async () => {
    await assertDrained();
    await withLocalMetadataControl(async (journal, store) => {
      const state = journal.read();
      if (state.revision !== revision) throw new Error('Stale local upgrade action. Reload status.');
      if (action === 'cancel') {
        if (!['legacy', 'legacy-resumed'].includes(state.phase) || getLocalMetadataServingSelection())
          throw new Error('Use Return to legacy for an activated or verified generation.');
        journal.requireLegacyRestart(revision);
        await leaveVmMigrationMaintenance();
        return;
      }
      const certificate = state.generation ? store.certificate(state.generation.id) : null;
      if (!certificate) throw new Error('No verified generation is available.');
      const source = localMetadataSourceRoots();
      assertLocalGenerationCertificate(certificate, state.generation!, source);
      const sourceProof = {
        sourceIdentity: localMetadataSourceIdentity(source),
        sourceFingerprint: await fingerprintVmMigrationSource(source),
      };
      if (action === 'return-to-legacy') {
        journal.returnToLegacy(revision, sourceProof);
        return;
      }
      // Legacy recovery must remain possible even when the candidate database,
      // package archive or encryption key is damaged or unavailable.
      const proof =
        state.backend === 'sqlite' || action === 'activate'
          ? await freshLocalGenerationProof(certificate)
          : sourceProof;
      if (action === 'activate') {
        await hooks.checkpoint?.('activate:before-commit');
        journal.selectSqliteForValidation(revision, proof as LocalMetadataGenerationProof);
        await hooks.checkpoint?.('activate:committed');
        return;
      }
      const selected = getLocalMetadataServingSelection();
      if (state.backend === 'sqlite' ? selected?.generationId !== certificate.generationId : selected !== null)
        throw new Error('Restart the combined backend to load the selected generation before validation or resume.');
      if (action === 'resume' && ['sqlite-live', 'legacy-resumed'].includes(state.phase)) {
        journal.requireResumedRestart(revision);
        await hooks.checkpoint?.('resume:completion-fenced');
        await leaveVmMigrationMaintenance();
        return;
      }
      if (action === 'validate') {
        if (!['sqlite-validation', 'legacy-validation'].includes(state.phase))
          throw new Error('Only a paused selected runtime can be validated.');
        if (
          sourceProof.sourceIdentity !== state.generation!.sourceIdentity ||
          sourceProof.sourceFingerprint !== state.generation!.sourceFingerprint
        )
          throw new Error('Retained source differs from its certified snapshot.');
        if (state.backend === 'sqlite') {
          if (
            Object.entries(state.generation!).some(
              ([key, value]) =>
                (proof as LocalMetadataGenerationProof)[key as keyof LocalMetadataGenerationProof] !== value,
            )
          )
            throw new Error('Source or candidate differs from the certified generation.');
          await stageLocalMetadataCandidate({
            source: certificate.source,
            candidate: localMetadataGenerationPaths(localMetadataControlRoot(), certificate.generationId),
            settingsEncryptionKey: process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY || '',
            verifyOnly: true,
            assertFrozen: assertDrained,
          });
          for (const [name, hash] of Object.entries(certificate.operational))
            if (
              hash !== null &&
              (await inspectLocalSqliteSnapshot(path.join(selected!.operationalRoot, name))).logicalHash !== hash
            )
              throw new Error('Operational SQLite data differs from its certified snapshot.');
        }
        await checkAppSettingsRepositoriesHealth();
        await checkWorkflowStorageHealth();
        await getWorkflowTree();
        if (state.backend === 'sqlite') {
          await prepareRuntimeLibrariesForExecution();
          await checkRuntimeLibrariesHealth();
        } else {
          // Filesystem getState() creates staging directories. Recovery probes
          // must not change the retained source snapshot even for empty domains.
          const manifest = await readSourceManifest(certificate.source.runtimeLibraries);
          const require = createRequire(path.join(certificate.source.runtimeLibraries, 'current', 'package.json'));
          for (const name of Object.keys(manifest.packages)) require.resolve(name);
        }
        const healthPort = Number(process.env.RIVET_BACKEND_HEALTH_PORT);
        if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
          throw new Error('Combined backend health port is required.');
        const response = await fetch(`http://127.0.0.1:${healthPort}/readyz`, { signal: AbortSignal.timeout(3000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error('API and executor have not both become ready.');
        journal.recordRuntimeValidation(
          revision,
          state.backend,
          certificate.generationId,
          hashLocalUpgradeValue({
            proof,
            backend: state.backend,
            appSettings: getAppSettingsBackendKind(),
            checkedAt: new Date().toISOString(),
          }),
        );
        return;
      }
      await hooks.checkpoint?.('resume:before-commit');
      journal.resumeWrites(revision, proof);
      await hooks.checkpoint?.('resume:committed');
      // The irreversible write boundary is durable before this marker is
      // removed. A crash here leaves writes paused, never reopens rollback.
      await leaveVmMigrationMaintenance();
      await hooks.checkpoint?.('resume:maintenance-removed');
      // Admission drains remain closed in this process. Restart the combined
      // backend before new traffic; no old sockets are silently reactivated.
    });
  });
}
