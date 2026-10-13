import { Pool } from 'pg';

import { getManagedDbPoolConfig, withManagedDbRetry } from '../routes/workflows/managed/db.js';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
  type ManagedWorkflowSchemaMode,
} from '../routes/workflows/managed/schema-migrations.js';
import {
  getManagedWorkflowStorageConfig,
  getManagedWorkflowStorageConfigFromSettings,
} from '../routes/workflows/storage-config.js';
import { readDeploymentStorageBootstrapSettings } from '../deployment-storage-settings.js';
import {
  assertVmMigrationTargetMayServe,
  assertVmMigrationTargetMayRecoverRestore,
  migrationSourceIdentity,
  migrationTargetIdentity,
} from '../vm-migration-target-gate.js';
import type { LegacyRestoreRoots } from './migrate-workflow-storage.js';
import { assertManagedSchemaMigrationSafe } from '../managed-schema-cutover.js';
import { LegacyRestoreControl } from '../legacy-restore/control.js';

function readCommand(): { mode: ManagedWorkflowSchemaMode; containerStartup: boolean } {
  const command = process.argv[2]?.trim().toLowerCase();
  if (process.argv.length === 3 && ['migrate', 'verify', 'prepare-container-startup'].includes(command || '')) {
    return {
      mode: command === 'verify' ? 'verify' : 'migrate',
      containerStartup: command === 'prepare-container-startup',
    };
  }

  throw new Error('Usage: migrate-managed-workflow-schema.ts <migrate|verify|prepare-container-startup>');
}

async function main(): Promise<void> {
  const { mode: command, containerStartup } = readCommand();
  const storageConfig =
    process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated'
      ? getManagedWorkflowStorageConfigFromSettings(readDeploymentStorageBootstrapSettings())
      : getManagedWorkflowStorageConfig();
  const pool = new Pool(getManagedDbPoolConfig(storageConfig));
  let control: LegacyRestoreControl | undefined;
  try {
    if (
      command === 'migrate' &&
      process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated' &&
      process.env.RIVET_LEGACY_RESTORE_ENABLED === '1'
    ) {
      const secret = process.env.RIVET_APP_SETTINGS_ENCRYPTION_KEY || process.env.RIVET_KEY;
      if (!secret) throw new Error('Restore control requires the settings encryption key.');
      control = new LegacyRestoreControl(getManagedDbPoolConfig(storageConfig), secret);
    }
    if (containerStartup && !control)
      throw new Error('Container startup preparation requires managed deployment restore coordination.');
    const prepare = async () => {
      await assertVmMigrationTargetMayServe(pool);
      if (command === 'migrate') await assertManagedSchemaMigrationSafe(pool);
      return withManagedDbRetry(`managed schema ${command}`, () =>
        command === 'migrate' ? migrateManagedWorkflowSchema(pool) : verifyManagedWorkflowSchema(pool),
      );
    };
    let restoreRecovery = false;
    const result = control
      ? await control.withDeploymentMigration(process.env.RIVET_LEGACY_RESTORE_INSTALLATION || '', prepare, {
          ...(containerStartup
            ? {
                verifyUnfinishedRestore: async (operation) => {
                  if (operation.destructive) {
                    const payload = await control!.payload(operation.id);
                    const roots = payload.roots as LegacyRestoreRoots;
                    const paths = [roots?.workflows, roots?.appData, roots?.recordings, roots?.runtimeLibraries];
                    if (!paths.every((value) => typeof value === 'string' && value.length > 0))
                      throw new Error('Restore recovery source roots are invalid.');
                    await assertVmMigrationTargetMayRecoverRestore(pool, {
                      sourceIdentity: migrationSourceIdentity(paths),
                      targetIdentity: migrationTargetIdentity(storageConfig),
                      sourceManifest: payload.sourceManifest as string,
                    });
                  } else {
                    await assertVmMigrationTargetMayServe(pool);
                  }
                  const verified = await withManagedDbRetry('managed schema restore recovery', () =>
                    verifyManagedWorkflowSchema(pool),
                  );
                  restoreRecovery = true;
                  return verified;
                },
              }
            : {}),
        })
      : await prepare();
    if (restoreRecovery) {
      console.log(
        `[managed-workflow-schema] Existing schema verified at version ${result.currentVersion}; unfinished restore requires UI recovery. No migration or settings seeding was performed.`,
      );
      // Private Compose preparation protocol. The shell stops before settings imports;
      // only this verified outcome permits the launcher to start recovery consumers.
      process.exitCode = 75;
      return;
    }
    console.log(`[managed-workflow-schema] ${command} succeeded at version ${result.currentVersion}.`);
  } finally {
    try {
      await control?.dispose();
    } finally {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error('[managed-workflow-schema] Command failed:', error);
  process.exitCode = 1;
});
