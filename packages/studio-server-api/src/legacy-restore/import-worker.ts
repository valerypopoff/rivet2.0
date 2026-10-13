import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { LegacyRestoreControl } from './control.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { readWorkflowMigrationTargetConfig } from '../scripts/migrate-workflow-storage-lib.js';
import {
  prepareLegacyRestoreSource,
  importLegacyRestoreSource,
  type LegacyRestoreRoots,
} from '../scripts/migrate-workflow-storage.js';
import {
  clearRestoreObjects,
  clearRestoreTables,
  captureRestoreObjects,
  existingRestoreTables,
  assertRestoreTableBoundary,
} from './scope.js';
import { prepareLegacyArchive, resetRestoreScratch } from './archive.js';
import { enableWorkflowRecordingMigrationCopyMode } from '../routes/workflows/recordings.js';
import type { SettingsRow } from '../scripts/migrate-app-settings.js';
import { normalizeExtractedRuntimeLayout } from './runtime-layout.js';
import { LocalUpgradeDiagnosticError, localUpgradeFailure } from '../local-metadata/upgrade-diagnostics.js';
import { LOCAL_UPGRADE_FAILURE_REASONS } from '../../../studio-server-shared/local-upgrade-types.js';
import { selectRestoreSourceBudget } from './preparation-budget.js';
import { withLocalSourceBundleLimit, withLocalSourceBudget } from '../local-metadata/source-budget.js';
import { prepareRestoreRuntime, restoreRuntimePlatform, runtimeNeedsReinstallation } from './runtime-preparation.js';
import { readSourceManifest } from '../scripts/migrate-runtime-libraries.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import fs from 'node:fs/promises';

export function restoreValidationFailureMessage(error: unknown, integrityOverridden = false): string {
  if (error instanceof LocalUpgradeDiagnosticError) {
    const failure = localUpgradeFailure('preflight', error);
    if (failure.reason && failure.reason !== 'unexpected-error') {
      const message =
        failure.reason === 'source-bundle-limit'
          ? 'A decoded source bundle exceeds the memory safety limit. A workflow bundle includes its datasets and retained publication history. This is separate from the archive upload limit.'
          : LOCAL_UPGRADE_FAILURE_REASONS[failure.reason];
      return `${message}${failure.sourceReference ? ` Source reference: ${failure.sourceReference}.` : ''} Nothing was deleted.`;
    }
  }
  let message: unknown;
  try {
    if (error instanceof Error) message = error.message;
  } catch {
    // Even diagnostic getters may be hostile. Never strand failure settlement.
  }
  if (typeof message === 'string') {
    if (message === 'Insufficient restore memory headroom.')
      return 'Restore needs more available memory for the selected source bundles. Increase server memory and upload again. Nothing was deleted.';
    if (message === 'Runtime package reinstallation failed.')
      return 'Runtime package reinstallation failed. Check access to the npm registry and target-platform package availability. Nothing was deleted.';
    if (
      [
        'Runtime package reinstallation requires a valid npm lockfile.',
        'Runtime package lock does not match the backup manifest.',
        'Runtime package lock does not match the installed backup packages.',
        'Runtime package lock contains unsupported sources.',
      ].includes(message)
    )
      return `${message} Nothing was deleted.`;
    if (message === 'Native runtime libraries require a platform-certified migration.')
      return 'Backup contains native runtime libraries that cannot be safely copied to this server. Nothing was deleted.';
    if (
      message === 'Insufficient restore scratch space.' ||
      message === 'Insufficient restore scratch space for the runtime-library artifact.'
    )
      return 'Restore storage has insufficient free space. Increase the dedicated restore storage and upload again. Nothing was deleted.';
    if (
      [
        'Unsafe backup path.',
        'Unsafe backup link.',
        'Unsupported backup entry.',
        'Backup entry traverses a non-directory.',
      ].includes(message)
    )
      return 'Backup archive contains unsupported paths, links or entry types. Repack only backup.json and the backup data folders as a gzip tar archive. Nothing was deleted.';
    if (message === 'Backup roots or manifest are missing.')
      return 'Backup is missing backup.json or a required data folder. Keep workflows, appData and runtimeLibraries at the archive root. Nothing was deleted.';
  }
  return integrityOverridden
    ? 'Backup validation failed after bypassing original integrity checks. Archive safety and application-data checks still apply. Nothing was deleted.'
    : 'Backup validation failed. Use the original downloaded legacy archive. Nothing was deleted.';
}

async function run() {
  const id = process.env.RIVET_LEGACY_RESTORE_OPERATION;
  const secret = process.env.RIVET_APP_SETTINGS_ENCRYPTION_KEY || process.env.RIVET_KEY;
  if (!id || !secret) throw new Error('Restore worker configuration is missing.');
  const target = readWorkflowMigrationTargetConfig(process.env);
  const control = new LegacyRestoreControl(getManagedDbPoolConfig(target), secret);
  let client: PoolClient | undefined;
  try {
    await control.assertDeployment(process.env.RIVET_LEGACY_RESTORE_INSTALLATION || '');
    client = await control.lock(120000);
    const selectedOperation = await control.read();
    if (!selectedOperation || selectedOperation.id !== id) throw new Error('Restore worker operation changed.');
    let operation = selectedOperation;
    const lockedClient = client;
    // A predecessor may have finished while this replacement waited for ownership.
    if (['awaiting-confirmation', 'failed', 'restarting', 'completed', 'cancelled'].includes(operation.phase)) return;
    const payload = await control.payload(id);
    let roots = payload.roots as LegacyRestoreRoots;
    const sourceBundleLimit = selectRestoreSourceBudget(undefined, payload.sourceBundleLimit as number | undefined);
    payload.sourceBundleLimit = sourceBundleLimit;
    // Persist admission before expensive preparation, including crash/restart before npm starts.
    await control.write(operation, payload);
    await withLocalSourceBundleLimit(sourceBundleLimit, async () => {
      const setPhase = async (phase: import('./control.js').RestorePhase, message: string) => {
        operation = { ...operation, phase, message };
        payload.resumePhase = phase;
        await control.write(operation, payload);
      };
      process.env.RIVET_APP_DATA_ROOT = roots.appData;
      process.env.RIVET_WORKFLOWS_ROOT = roots.workflows;
      process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = roots.recordings;
      enableWorkflowRecordingMigrationCopyMode();
      if (operation.phase === 'validating') {
        delete payload.runtimePlatform;
        roots = (payload.originalRoots ?? payload.roots) as LegacyRestoreRoots;
        const archivePath = payload.archive as string;
        const root = path.dirname(roots.workflows);
        await resetRestoreScratch(
          archivePath,
          root,
          id,
          process.env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore',
          operation.archiveDigest!,
        );
        const archive = await prepareLegacyArchive(payload.archive as string, path.dirname(roots.workflows), {
          allowModifiedBackup: operation.integrityOverridden === true,
        });
        await normalizeExtractedRuntimeLayout(roots.runtimeLibraries);
        const originalRoots = roots;
        const originalSourceManifest = await fingerprintVmMigrationSource(originalRoots);
        if (
          Object.keys((await readSourceManifest(roots.runtimeLibraries)).packages).length &&
          (await runtimeNeedsReinstallation(path.join(roots.runtimeLibraries, 'current')))
        ) {
          operation = {
            ...operation,
            message: 'Reinstalling pinned runtime packages for this server before confirmation.',
          };
          await control.write(operation, payload);
          const destination = path.join(path.dirname(root), 'prepared-runtime');
          // Only this worker-owned fixed scratch path may be replaced on preparation restart.
          if (
            await fs
              .lstat(destination)
              .then((stat) => stat.isSymbolicLink())
              .catch((error) => {
                if (error.code === 'ENOENT') return false;
                throw error;
              })
          )
            throw new Error('Unsafe backup link.');
          await fs.rm(destination, { recursive: true, force: true });
          await withLocalSourceBudget(() => prepareRestoreRuntime(roots.runtimeLibraries, destination));
          roots = { ...roots, runtimeLibraries: destination };
          payload.runtimePlatform = restoreRuntimePlatform();
        }
        const source = await prepareLegacyRestoreSource(roots, target, {
          runtimePlatformValidated: !!payload.runtimePlatform,
        });
        const tables = await existingRestoreTables(control.pool);
        await assertRestoreTableBoundary(control.pool, tables);
        const count = async (table: 'workflows' | 'workflow_recordings') =>
          tables.includes(table)
            ? Number((await control.pool.query(`SELECT count(*) AS count FROM public.${table}`)).rows[0]?.count)
            : 0;
        await control.write(
          {
            ...operation,
            phase: 'awaiting-confirmation',
            message: operation.integrityOverridden
              ? 'Modified backup prepared with original integrity checks bypassed. Confirm replacement.'
              : 'Backup validated. Confirm replacement.',
            backupCreatedAt: archive.createdAt,
            projects: source.projects,
            recordings: source.recordings,
            destinationProjects: await count('workflows'),
            destinationRecordings: await count('workflow_recordings'),
          },
          {
            ...payload,
            roots,
            originalRoots,
            originalSourceManifest,
            sourceManifest: source.sourceManifest,
            settings: source.settings,
          },
        );
        return;
      }
      if (
        !['clearing', 'importing', 'verifying'].includes(operation.phase) ||
        (operation.phase !== 'clearing' && !operation.destructive)
      )
        throw new Error('Restore worker has no destructive authorization.');
      if (!(await control.exclusive(lockedClient))) throw new Error('Application writers have not drained.');
      if (payload.runtimePlatform && payload.runtimePlatform !== restoreRuntimePlatform())
        throw new Error('Runtime package reinstallation failed.');
      const pool = new Pool(getManagedDbPoolConfig(target));
      try {
        if (operation.phase === 'clearing') {
          if (
            payload.originalRoots &&
            (await fingerprintVmMigrationSource(payload.originalRoots as LegacyRestoreRoots)) !==
              payload.originalSourceManifest
          )
            throw new Error('Prepared source changed before deletion.');
          const prepared = await prepareLegacyRestoreSource(roots, target, {
            runtimePlatformValidated: !!payload.runtimePlatform,
          });
          if (prepared.sourceManifest !== payload.sourceManifest)
            throw new Error('Prepared source changed before deletion.');
          // Set this only after the last source check, immediately before the first destructive operation.
          operation = { ...operation, destructive: true, message: 'Replacing application data.' };
          await control.write(operation, payload);
          const objects = payload.objects as Awaited<ReturnType<typeof captureRestoreObjects>>;
          await clearRestoreObjects(target, objects);
          await clearRestoreTables(pool);
          await setPhase('importing', 'Importing legacy application data.');
        }
        if (operation.phase === 'importing') {
          await importLegacyRestoreSource({
            roots,
            target,
            encryptionKey: secret,
            settings: payload.settings as SettingsRow[],
            sourceManifest: payload.sourceManifest as string,
            verifyOnly: false,
          });
          await setPhase('verifying', 'Comparing restored data and artifacts.');
        }
        await importLegacyRestoreSource({
          roots,
          target,
          encryptionKey: secret,
          settings: payload.settings as SettingsRow[],
          sourceManifest: payload.sourceManifest as string,
          verifyOnly: true,
        });
        await setPhase('restarting', 'Restore verified. Restarting consumers.');
      } finally {
        await pool.end();
      }
    });
  } catch (error) {
    const operation = client ? await control.read() : null;
    if (operation?.id === id)
      await control.write({
        ...operation,
        phase: 'failed',
        message: !operation.destructive
          ? restoreValidationFailureMessage(error, operation.integrityOverridden === true)
          : 'Restore stopped safely. Retry restore; application traffic remains blocked.',
      });
    process.exitCode = 1;
  } finally {
    try {
      if (client) await control.unlock(client);
    } finally {
      await control.dispose();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void run().catch(() => {
    process.exitCode = 1;
  });
