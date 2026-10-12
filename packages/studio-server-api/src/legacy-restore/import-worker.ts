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

export function restoreValidationFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'Native runtime libraries require a platform-certified migration.')
      return 'Backup contains native runtime libraries that cannot be safely copied to this server. Nothing was deleted.';
    if (
      error.message === 'Insufficient restore scratch space.' ||
      error.message === 'Insufficient restore scratch space for the runtime-library artifact.'
    )
      return 'Restore storage has insufficient free space. Increase the dedicated restore storage and upload again. Nothing was deleted.';
  }
  return 'Backup validation failed. Use the original downloaded legacy archive. Nothing was deleted.';
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
    let operation = await control.read();
    if (!operation || operation.id !== id) throw new Error('Restore worker operation changed.');
    // A predecessor may have finished while this replacement waited for ownership.
    if (['awaiting-confirmation', 'failed', 'restarting', 'completed', 'cancelled'].includes(operation.phase)) return;
    const payload = await control.payload(id);
    const roots = payload.roots as LegacyRestoreRoots;
    const setPhase = async (phase: import('./control.js').RestorePhase, message: string) => {
      operation = { ...operation!, phase, message };
      payload.resumePhase = phase;
      await control.write(operation, payload);
    };
    process.env.RIVET_APP_DATA_ROOT = roots.appData;
    process.env.RIVET_WORKFLOWS_ROOT = roots.workflows;
    process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = roots.recordings;
    enableWorkflowRecordingMigrationCopyMode();
    if (operation.phase === 'validating') {
      const archivePath = payload.archive as string;
      const root = path.dirname(roots.workflows);
      await resetRestoreScratch(
        archivePath,
        root,
        id,
        process.env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore',
        operation.archiveDigest!,
      );
      const archive = await prepareLegacyArchive(payload.archive as string, path.dirname(roots.workflows));
      await normalizeExtractedRuntimeLayout(roots.runtimeLibraries);
      const source = await prepareLegacyRestoreSource(roots, target);
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
          message: 'Backup validated. Confirm replacement.',
          backupCreatedAt: archive.createdAt,
          projects: source.projects,
          recordings: source.recordings,
          destinationProjects: await count('workflows'),
          destinationRecordings: await count('workflow_recordings'),
        },
        { ...payload, sourceManifest: source.sourceManifest, settings: source.settings },
      );
      return;
    }
    if (
      !['clearing', 'importing', 'verifying'].includes(operation.phase) ||
      (operation.phase !== 'clearing' && !operation.destructive)
    )
      throw new Error('Restore worker has no destructive authorization.');
    if (!(await control.exclusive(client))) throw new Error('Application writers have not drained.');
    const pool = new Pool(getManagedDbPoolConfig(target));
    try {
      if (operation.phase === 'clearing') {
        const prepared = await prepareLegacyRestoreSource(roots, target);
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
  } catch (error) {
    const operation = client ? await control.read() : null;
    if (operation?.id === id)
      await control.write({
        ...operation,
        phase: 'failed',
        message: !operation.destructive
          ? restoreValidationFailureMessage(error)
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
