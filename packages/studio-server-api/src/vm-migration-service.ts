import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { getActiveScheduledRunCount } from './scheduled-runs/activity.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getLocalMetadataServingSelection } from './local-metadata/serving-selection.js';
import { getLocalWorkflowActiveWriteCount } from './routes/workflows/storage-backend.js';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';

import { getAppDataRoot, getWorkflowRecordingsRoot, getWorkflowsRoot } from './security.js';
import { jobRunner as filesystemRuntimeLibraryJobRunner } from './runtime-libraries/job-runner.js';
import { getActiveHttpExecutionCount, beginActiveHttpExecutionDrain } from './active-http-executions.js';
import { getPublishedExecutionAdmission } from './published-execution-admission.js';
import { getWebAppActionWebSocketRuntime } from './web-app-action-websocket.js';
import {
  getWorkflowExecutionRecordingPersistenceMetrics,
  prepareWorkflowRecordingsForVmMigration,
} from './routes/workflows/recordings.js';
import { getWorkflowStorageBackendMode } from './routes/workflows/storage-config.js';
import { getManagedDbPoolConfig } from './routes/workflows/managed/db.js';
import {
  createManagedWorkflowS3ClientConfig,
  S3ManagedWorkflowBlobStore,
} from './routes/workflows/managed/blob-store.js';
import { syncDirectory, writeDurableExclusive } from './routes/workflows/filesystem-transaction-primitives.js';
import {
  readWorkflowMigrationTargetConfig,
  readWorkflowMigrationTargetDatabaseConfig,
  readWorkflowMigrationTargetObjectStorageConfig,
} from './scripts/migrate-workflow-storage-lib.js';
import { inspectVmMigrationSource } from './vm-migration-inventory.js';
import {
  acquireVmMigrationImporterLock,
  assertVmMigrationSourceManifest,
  hasVmMigrationTargetGate,
  invalidateVmMigrationTargetGate,
  migrationSourceIdentity,
  migrationTargetIdentity,
} from './vm-migration-target-gate.js';
import { getServerUiAuthMode } from './server-ui-auth.js';
import { readMigrationProgress } from './scripts/migration-progress.js';
import {
  fingerprintVmMigrationSourceParts,
  readVmMigrationSourceParts,
} from './scripts/vm-migration-source-manifest.js';
import {
  enterVmMigrationMaintenance,
  getVmMigrationActiveRequestCount,
  isVmMigrationMaintenanceActive,
  leaveVmMigrationMaintenance,
  readVmMigrationMaintenance,
} from './vm-migration-maintenance.js';

export type VmMigrationJobStatus = {
  id: string;
  phase:
    | 'precopying'
    | 'precopy_complete'
    | 'copying'
    | 'verifying'
    | 'verified'
    | 'failed'
    | 'interrupted'
    | 'invalidated';
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  precopyCompleted?: boolean;
  finalCopyStarted?: boolean;
  targetIdentity?: string;
  report?: VmMigrationVerificationReport;
  deploymentReview?: { reviewedAt: string; sourceManifestHash: string };
};

export type VmMigrationDeploymentChecks = {
  backupCompleted: boolean;
  deploymentSettingsMatch: boolean;
  functionalRehearsalPassed: boolean;
  externalDependenciesReviewed: boolean;
  rollbackWindowUnderstood: boolean;
};

export type VmMigrationVerificationReport = {
  projects: number;
  folders: number;
  recordings: number;
  publishedEndpoints: number;
  publishedWebApps: number;
  evaluationAndHealthRows: number;
  runtimeLibraryPackages: number;
  appSettingsDomains: number;
  checked: readonly string[];
};

export type TargetInput = {
  databaseUrl: string;
  databaseSslMode: string;
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  settingsEncryptionKey: string;
  targetOffline: boolean;
  runtimePlatformCompatible: boolean;
};

let runningJob: Promise<void> | null = null;
let startingJob = false;
let maintenanceTransition = false;
let runningPreflights = 0;

function statusPath(): string {
  return path.join(getAppDataRoot(), 'vm-migration-job.json');
}

function reportPath(): string {
  return path.join(getAppDataRoot(), 'vm-migration-verification-report.json');
}

function progressPath(jobId: string): string {
  return path.join(getAppDataRoot(), `vm-migration-progress-${jobId}.jsonl`);
}

async function readReport(): Promise<VmMigrationVerificationReport> {
  const report = JSON.parse(await fs.readFile(reportPath(), 'utf8')) as VmMigrationVerificationReport;
  if (
    !report ||
    ![
      report.projects,
      report.folders,
      report.recordings,
      report.publishedEndpoints,
      report.publishedWebApps,
      report.evaluationAndHealthRows,
      report.runtimeLibraryPackages,
      report.appSettingsDomains,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Array.isArray(report.checked) ||
    !report.checked.every((value) => typeof value === 'string')
  ) {
    throw new Error('Migration verification report is invalid.');
  }
  return report;
}

async function persistJob(status: VmMigrationJobStatus): Promise<void> {
  const filePath = statusPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeDurableExclusive(temporaryPath, JSON.stringify(status), 0o600);
  await fs.rename(temporaryPath, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function readJob(): Promise<VmMigrationJobStatus | null> {
  try {
    const value = JSON.parse(await fs.readFile(statusPath(), 'utf8')) as VmMigrationJobStatus;
    if (
      !value ||
      typeof value.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
      ![
        'precopying',
        'precopy_complete',
        'copying',
        'verifying',
        'verified',
        'failed',
        'interrupted',
        'invalidated',
      ].includes(value.phase) ||
      typeof value.startedAt !== 'string' ||
      (value.precopyCompleted !== undefined && typeof value.precopyCompleted !== 'boolean') ||
      (value.finalCopyStarted !== undefined && typeof value.finalCopyStarted !== 'boolean') ||
      (value.targetIdentity !== undefined && !/^[a-f0-9]{64}$/.test(value.targetIdentity)) ||
      (value.deploymentReview !== undefined &&
        (typeof value.deploymentReview.reviewedAt !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.deploymentReview.sourceManifestHash))) ||
      (value.finishedAt !== null && typeof value.finishedAt !== 'string')
    ) {
      throw new Error('Invalid VM migration job status.');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function targetEnvironment(input: TargetInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    RIVET_MIGRATION_TARGET_DATABASE_URL: input.databaseUrl,
    RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: input.databaseSslMode,
    RIVET_MIGRATION_TARGET_S3_BUCKET: input.bucket,
    RIVET_MIGRATION_TARGET_S3_ENDPOINT: input.endpoint,
    RIVET_MIGRATION_TARGET_S3_REGION: input.region,
    RIVET_MIGRATION_TARGET_S3_PREFIX: input.prefix,
    RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: String(input.forcePathStyle),
    RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: input.accessKeyId,
    RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: input.secretAccessKey,
    RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY: input.settingsEncryptionKey,
  };
  readWorkflowMigrationTargetConfig(env);
  if (!input.settingsEncryptionKey.trim()) throw new Error('Destination settings encryption key is required.');
  return env;
}

function assertAvailable(): void {
  if (
    process.env.RIVET_VM_MIGRATION_ENABLED !== '1' ||
    !!process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT ||
    getServerUiAuthMode() === 'none' ||
    process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated' ||
    process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL !== '1' ||
    getWorkflowStorageBackendMode() !== 'filesystem'
  ) {
    throw new Error('VM migration must be explicitly enabled on a combined filesystem-backed single-host source.');
  }
}

export async function getVmMigrationSourceInventory() {
  assertAvailable();
  return inspectVmMigrationSource();
}

async function editorLeaseCount(): Promise<number> {
  const root = path.join(getAppDataRoot(), 'vm-migration-active-editor-runs');
  try {
    return (await fs.readdir(root)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export async function localStorageDrainSnapshot(): Promise<{ ready: boolean; blockers: string[] }> {
  const blockers: string[] = [];
  if (getVmMigrationActiveRequestCount() > 0) blockers.push('HTTP requests');
  if (getActiveScheduledRunCount() > 0) blockers.push('Scheduled runs');
  if (getActiveHttpExecutionCount() > 0) blockers.push('HTTP graph runs');
  if ((getWebAppActionWebSocketRuntime()?.getActiveRunCount() ?? 0) > 0) blockers.push('web-app actions');
  if ((await editorLeaseCount()) > 0) blockers.push('editor graph runs');
  if (runningPreflights > 0) blockers.push('destination connection test');
  if (getLocalWorkflowActiveWriteCount() > 0) blockers.push('SQLite catalog writes');
  const recordings = getWorkflowExecutionRecordingPersistenceMetrics();
  if (recordings.activeWrites > 0 || recordings.pendingWrites > 0) blockers.push('recording writes');
  // Migration only runs with filesystem storage. Query the local job runner
  // directly: getState() creates staging directories and would mutate a frozen source.
  if (filesystemRuntimeLibraryJobRunner.isRunning()) blockers.push('runtime-library job');
  return { ready: blockers.length === 0, blockers };
}
const drainSnapshot = localStorageDrainSnapshot;
export async function freezeLocalStorageSource(): Promise<void> {
  await enterVmMigrationMaintenance();
  beginActiveHttpExecutionDrain();
  getPublishedExecutionAdmission().beginDrain();
  getWebAppActionWebSocketRuntime()?.drain();
  await prepareWorkflowRecordingsForVmMigration();
}

export async function getVmMigrationStatus() {
  const maintenance = readVmMigrationMaintenance();
  const job = await readJob();
  return {
    available:
      !getLocalMetadataServingSelection() &&
      !process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT &&
      process.env.RIVET_VM_MIGRATION_ENABLED === '1' &&
      getServerUiAuthMode() !== 'none' &&
      process.env.RIVET_DEPLOYMENT_TOPOLOGY !== 'replicated' &&
      process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL === '1' &&
      getWorkflowStorageBackendMode() === 'filesystem',
    maintenance,
    drain: maintenance ? await drainSnapshot() : null,
    job:
      job && !startingJob && runningJob === null && ['precopying', 'copying', 'verifying'].includes(job.phase)
        ? {
            ...job,
            phase: 'interrupted' as const,
            message: 'The server stopped during migration. Retry against the same offline target.',
            progress: await readMigrationProgress(progressPath(job.id), job.id),
          }
        : job
          ? { ...job, progress: await readMigrationProgress(progressPath(job.id), job.id) }
          : null,
  };
}

export async function enterVmMigrationMode(): Promise<ReturnType<typeof getVmMigrationStatus>> {
  assertAvailable();
  if (maintenanceTransition || startingJob || runningJob) throw new Error('Migration state is changing.');
  maintenanceTransition = true;
  try {
    await freezeLocalStorageSource();
    return await getVmMigrationStatus();
  } finally {
    maintenanceTransition = false;
  }
}

export async function leaveVmMigrationMode(input?: TargetInput): Promise<void> {
  if (maintenanceTransition || startingJob || runningJob) throw new Error('Migration state is changing.');
  maintenanceTransition = true;
  try {
    const job = await readJob();
    if (job?.phase === 'copying' || job?.phase === 'verifying') {
      throw new Error('An interrupted migration requires operator recovery before maintenance can be removed.');
    }
    // A verify child can open the target gate and crash before the local job
    // record advances from verifying to verified. A failed final copy therefore
    // needs the same gate-closing step before the source is resumed.
    if (
      job?.phase === 'verified' ||
      (job?.phase === 'failed' &&
        (job.finalCopyStarted || (job.finalCopyStarted === undefined && job.precopyCompleted)))
    ) {
      if (!input?.targetOffline) {
        throw new Error('Confirm the destination is stopped and re-enter its credentials before resuming this VM.');
      }
      const env = targetEnvironment(input);
      const target = readWorkflowMigrationTargetConfig(env);
      const targetIdentity = migrationTargetIdentity(target);
      if (targetIdentity !== job.targetIdentity) throw new Error('Destination differs from the verified copy.');
      const runtimeRoot = process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim();
      if (!runtimeRoot) throw new Error('Runtime-library source root is not configured.');
      const sourceIdentity = migrationSourceIdentity(
        [getWorkflowsRoot(), getAppDataRoot(), getWorkflowRecordingsRoot(), runtimeRoot].map((root) =>
          path.resolve(root),
        ),
      );
      const pool = new Pool(getManagedDbPoolConfig(target));
      try {
        const releaseLock = await acquireVmMigrationImporterLock(pool);
        try {
          // Source validation can fail before beginVmMigrationTarget creates
          // the gate. The importer creates no managed content before that
          // point, so there is nothing to close in this case.
          if (await hasVmMigrationTargetGate(pool)) {
            await invalidateVmMigrationTargetGate(pool, sourceIdentity, targetIdentity);
          } else if (job.phase === 'verified' || job.precopyCompleted) {
            throw new Error('A started destination copy has no startup gate.');
          }
        } finally {
          await releaseLock();
        }
      } catch {
        throw new Error('Could not close the destination startup gate. The VM remains paused.');
      } finally {
        await pool.end();
      }
      await persistJob({
        ...job,
        phase: 'invalidated',
        finishedAt: new Date().toISOString(),
        deploymentReview: undefined,
        message: 'Source resumed; destination gate is closed. Use a fresh target for a later migration.',
      });
    }
    await leaveVmMigrationMaintenance();
    // Process-local admission drains are intentionally not reversed. Restart the
    // backend before serving again; otherwise an old WebSocket could be reused.
  } finally {
    maintenanceTransition = false;
  }
}

export async function acknowledgeInterruptedVmMigration(importerStopped: boolean): Promise<void> {
  if (maintenanceTransition || startingJob || runningJob || !importerStopped) {
    throw new Error('Confirm the previous importer process is stopped before recovery.');
  }
  maintenanceTransition = true;
  try {
    const job = await readJob();
    if (job?.phase !== 'precopying' && job?.phase !== 'copying' && job?.phase !== 'verifying') {
      throw new Error('There is no interrupted migration to recover.');
    }
    if (job.phase !== 'precopying' && !isVmMigrationMaintenanceActive()) {
      throw new Error('Maintenance must remain active while recovering the final copy.');
    }
    await persistJob({
      ...job,
      phase: 'failed',
      finishedAt: new Date().toISOString(),
      message: 'Previous importer was confirmed stopped. Retry against the same offline target or abandon this copy.',
    });
  } finally {
    maintenanceTransition = false;
  }
}

export async function testVmMigrationDatabase(
  input: Pick<TargetInput, 'databaseUrl' | 'databaseSslMode'>,
): Promise<void> {
  assertAvailable();
  if (startingJob || runningJob) throw new Error('Migration is already running.');
  runningPreflights += 1;
  try {
    const target = readWorkflowMigrationTargetDatabaseConfig({
      RIVET_MIGRATION_TARGET_DATABASE_URL: input.databaseUrl,
      RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: input.databaseSslMode,
    });
    const pool = new Pool({ ...getManagedDbPoolConfig(target), connectionTimeoutMillis: 10_000, max: 1 });
    try {
      const databaseClient = await pool.connect();
      try {
        const testTable = `rivet_vm_migration_preflight_${randomUUID().replaceAll('-', '')}`;
        await databaseClient.query('BEGIN');
        await databaseClient.query(`CREATE TABLE public.${testTable} (value TEXT NOT NULL)`);
        await databaseClient.query(`INSERT INTO public.${testTable} (value) VALUES ('test')`);
        const result = await databaseClient.query<{ value: string }>(`SELECT value FROM public.${testTable}`);
        if (result.rows[0]?.value !== 'test') throw new Error('PostgreSQL test read differed from test write.');
      } finally {
        await databaseClient.query('ROLLBACK').finally(() => databaseClient.release());
      }
    } finally {
      await pool.end();
    }
  } finally {
    runningPreflights -= 1;
  }
}

export async function testVmMigrationObjectStorage(
  input: Pick<
    TargetInput,
    'bucket' | 'endpoint' | 'region' | 'prefix' | 'forcePathStyle' | 'accessKeyId' | 'secretAccessKey'
  >,
): Promise<void> {
  assertAvailable();
  if (startingJob || runningJob) throw new Error('Migration is already running.');
  runningPreflights += 1;
  try {
    const target = readWorkflowMigrationTargetObjectStorageConfig({
      RIVET_MIGRATION_TARGET_S3_BUCKET: input.bucket,
      RIVET_MIGRATION_TARGET_S3_ENDPOINT: input.endpoint,
      RIVET_MIGRATION_TARGET_S3_REGION: input.region,
      RIVET_MIGRATION_TARGET_S3_PREFIX: input.prefix,
      RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: String(input.forcePathStyle),
      RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: input.accessKeyId,
      RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: input.secretAccessKey,
    });
    const s3 = new S3Client(createManagedWorkflowS3ClientConfig(target));
    const workflowStore = new S3ManagedWorkflowBlobStore(target);
    try {
      // The importer can create a missing bucket. Test that same first-install
      // path before writing disposable objects into its two namespaces.
      await workflowStore.initialize();
      for (const prefix of [target.objectStoragePrefix, 'runtime-libraries/']) {
        const key = `${prefix}migration-preflight/${randomUUID()}`;
        let created = false;
        try {
          await s3.send(new PutObjectCommand({ Bucket: target.objectStorageBucket, Key: key, Body: 'test' }));
          created = true;
          const response = await s3.send(new GetObjectCommand({ Bucket: target.objectStorageBucket, Key: key }));
          if ((await response.Body?.transformToString()) !== 'test')
            throw new Error('S3 test read differed from test write.');
        } finally {
          if (created) await s3.send(new DeleteObjectCommand({ Bucket: target.objectStorageBucket, Key: key }));
        }
      }
    } finally {
      workflowStore.dispose();
      s3.destroy();
    }
  } finally {
    runningPreflights -= 1;
  }
}

function importerCommand(mode: 'precopy' | 'migrate' | 'verify'): { command: string; args: string[] } {
  const compiled = fileURLToPath(new URL('./scripts/migrate-workflow-storage.js', import.meta.url));
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled, mode] };
  const source = fileURLToPath(new URL('./scripts/migrate-workflow-storage.ts', import.meta.url));
  return { command: process.execPath, args: ['--import', 'tsx', source, mode] };
}

async function runImporter(mode: 'precopy' | 'migrate' | 'verify', env: NodeJS.ProcessEnv): Promise<void> {
  const { command, args } = importerCommand(mode);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${mode} process exited with code ${code ?? 'unknown'}`)),
    );
  });
}

export async function startVmMigrationPrecopy(input: TargetInput): Promise<VmMigrationJobStatus> {
  assertAvailable();
  if (maintenanceTransition || isVmMigrationMaintenanceActive()) {
    throw new Error('Pre-copy must run before entering maintenance mode.');
  }
  if (!input.targetOffline) throw new Error('Confirm the destination API and execution pods are stopped.');
  if (startingJob || runningJob || runningPreflights > 0) throw new Error('Migration state is changing.');
  startingJob = true;
  try {
    const previous = await readJob();
    if (previous && !['failed', 'invalidated', 'precopy_complete'].includes(previous.phase)) {
      throw new Error('Recover the interrupted importer or finish the current migration first.');
    }
    const env = targetEnvironment(input);
    const targetIdentity = migrationTargetIdentity(readWorkflowMigrationTargetConfig(env));
    const job: VmMigrationJobStatus = {
      id: randomUUID(),
      phase: 'precopying',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      precopyCompleted: false,
      targetIdentity,
    };
    await persistJob(job);
    runningJob = (async () => {
      try {
        await runImporter('precopy', {
          ...env,
          RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT: getWorkflowsRoot(),
          RIVET_MIGRATION_SOURCE_APP_DATA_ROOT: getAppDataRoot(),
          RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT: getWorkflowRecordingsRoot(),
          RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT: process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '',
          RIVET_MIGRATION_TARGET_OFFLINE: '1',
        });
        await persistJob({
          ...job,
          phase: 'precopy_complete',
          precopyCompleted: true,
          finishedAt: new Date().toISOString(),
        });
      } catch {
        console.error('[vm-migration] Pre-copy failed; inspect target connectivity and retry.');
        await persistJob({
          ...job,
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          message: 'Pre-copy failed. Correct the destination and retry.',
        });
      } finally {
        runningJob = null;
      }
    })();
    return job;
  } finally {
    startingJob = false;
  }
}

export async function startVmMigration(input: TargetInput): Promise<VmMigrationJobStatus> {
  assertAvailable();
  if (maintenanceTransition) throw new Error('Wait for the maintenance transition to finish.');
  if (!isVmMigrationMaintenanceActive()) throw new Error('Enter maintenance mode before migrating.');
  if (!input.targetOffline) throw new Error('Confirm the destination API and execution pods are stopped.');
  if (startingJob || runningJob) throw new Error('Migration is already running.');
  startingJob = true;
  try {
    const previous = await readJob();
    if (previous?.phase === 'precopying' || previous?.phase === 'copying' || previous?.phase === 'verifying') {
      throw new Error('Recover the interrupted importer before retrying.');
    }
    if (previous?.phase === 'verified') throw new Error('This source was already copied and verified.');
    await prepareWorkflowRecordingsForVmMigration();
    const drain = await drainSnapshot();
    if (!drain.ready) throw new Error(`Wait for active work to finish: ${drain.blockers.join(', ')}`);
    const env = targetEnvironment(input);
    const targetIdentity = migrationTargetIdentity(readWorkflowMigrationTargetConfig(env));
    if (previous?.precopyCompleted && previous.targetIdentity !== targetIdentity) {
      throw new Error('Destination changed since pre-copy. Run pre-copy again for this destination.');
    }
    const job: VmMigrationJobStatus = {
      id: randomUUID(),
      phase: 'copying',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      precopyCompleted: previous?.precopyCompleted === true || previous?.phase === 'precopy_complete',
      finalCopyStarted: true,
      targetIdentity,
    };
    await persistJob(job);
    const sourceEnv: NodeJS.ProcessEnv = {
      ...env,
      RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT: getWorkflowsRoot(),
      RIVET_MIGRATION_SOURCE_APP_DATA_ROOT: getAppDataRoot(),
      RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT: getWorkflowRecordingsRoot(),
      RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT: process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '',
      RIVET_MIGRATION_SOURCE_QUIESCED: '1',
      RIVET_MIGRATION_TARGET_OFFLINE: '1',
      RIVET_MIGRATION_RUNTIME_PLATFORM_ACK: input.runtimePlatformCompatible ? '1' : '0',
      RIVET_MIGRATION_REPORT_PATH: reportPath(),
      RIVET_MIGRATION_PROGRESS_PATH: progressPath(job.id),
      RIVET_MIGRATION_PROGRESS_JOB_ID: job.id,
    };
    runningJob = (async () => {
      try {
        await fs.rm(reportPath(), { force: true });
        await runImporter('migrate', sourceEnv);
        await persistJob({ ...job, phase: 'verifying' });
        await runImporter('verify', sourceEnv);
        await persistJob({
          ...job,
          phase: 'verified',
          finishedAt: new Date().toISOString(),
          report: await readReport(),
        });
      } catch (error) {
        // Never persist a child error: upstream library errors can include the
        // target URL or credentials. The CLI can be retried against partial data.
        console.error('[vm-migration] Copy or verification failed; inspect target connectivity and retry.');
        await persistJob({
          ...job,
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          message: 'Copy or verification failed. Correct the destination and retry.',
        });
      } finally {
        runningJob = null;
      }
    })();
    return job;
  } finally {
    startingJob = false;
  }
}

/** A second exact check after the isolated deployment rehearsal; this records operator evidence, not an automatic traffic switch. */
export async function reviewVmMigrationDeployment(
  input: TargetInput,
  checks: VmMigrationDeploymentChecks,
): Promise<VmMigrationJobStatus> {
  assertAvailable();
  if (startingJob || runningJob || maintenanceTransition) throw new Error('Migration state is changing.');
  if (!isVmMigrationMaintenanceActive()) throw new Error('The VM must remain in maintenance mode.');
  if (!input.targetOffline) throw new Error('Stop the destination candidate before the final comparison.');
  if (!Object.values(checks).every((value) => value === true)) {
    throw new Error('Complete every deployment review check before approving cutover.');
  }
  startingJob = true;
  try {
    const job = await readJob();
    if (job?.phase !== 'verified' || !job.report) throw new Error('Copy and exact verification must pass first.');
    const env = targetEnvironment(input);
    const target = readWorkflowMigrationTargetConfig(env);
    if (migrationTargetIdentity(target) !== job.targetIdentity)
      throw new Error('Destination differs from the verified copy.');
    const drain = await drainSnapshot();
    if (!drain.ready) throw new Error(`Wait for active work to finish: ${drain.blockers.join(', ')}`);
    const runtimeRoot = process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim();
    if (!runtimeRoot) throw new Error('Runtime-library source root is not configured.');
    const sourceRoots = [getWorkflowsRoot(), getAppDataRoot(), getWorkflowRecordingsRoot(), runtimeRoot].map((root) =>
      path.resolve(root),
    );
    await persistJob({ ...job, phase: 'verifying', finishedAt: null, message: null, deploymentReview: undefined });
    try {
      await runImporter('verify', {
        ...env,
        RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT: sourceRoots[0],
        RIVET_MIGRATION_SOURCE_APP_DATA_ROOT: sourceRoots[1],
        RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT: sourceRoots[2],
        RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT: sourceRoots[3],
        RIVET_MIGRATION_SOURCE_QUIESCED: '1',
        RIVET_MIGRATION_TARGET_OFFLINE: '1',
        RIVET_MIGRATION_RUNTIME_PLATFORM_ACK: input.runtimePlatformCompatible ? '1' : '0',
        RIVET_MIGRATION_REPORT_PATH: reportPath(),
      });
      const sourceManifestHash = fingerprintVmMigrationSourceParts(
        await readVmMigrationSourceParts({
          workflows: sourceRoots[0]!,
          appData: sourceRoots[1]!,
          recordings: sourceRoots[2]!,
          runtimeLibraries: sourceRoots[3]!,
        }),
      );
      const pool = new Pool(getManagedDbPoolConfig(target));
      try {
        await assertVmMigrationSourceManifest(
          pool,
          migrationSourceIdentity(sourceRoots),
          job.targetIdentity!,
          sourceManifestHash,
        );
      } finally {
        await pool.end();
      }
      const reviewed: VmMigrationJobStatus = {
        ...job,
        report: await readReport(),
        deploymentReview: { reviewedAt: new Date().toISOString(), sourceManifestHash },
      };
      await persistJob(reviewed);
      return reviewed;
    } catch {
      // The child normally closes the gate before its first read. Close it
      // again here in case the child never started or a post-verify step failed.
      let gateClosed = false;
      const pool = new Pool(getManagedDbPoolConfig(target));
      try {
        const releaseLock = await acquireVmMigrationImporterLock(pool);
        try {
          await invalidateVmMigrationTargetGate(pool, migrationSourceIdentity(sourceRoots), job.targetIdentity!);
          gateClosed = true;
        } finally {
          await releaseLock();
        }
      } catch {
        console.error('[vm-migration] Could not confirm destination gate closure after final comparison failure.');
      } finally {
        await pool.end().catch(() => undefined);
      }
      await persistJob({
        ...job,
        phase: 'failed',
        finalCopyStarted: true,
        finishedAt: new Date().toISOString(),
        deploymentReview: undefined,
        report: undefined,
        message: gateClosed
          ? 'Final comparison failed; the destination gate is closed. Inspect the target before retrying.'
          : 'Final comparison failed; destination gate closure is unconfirmed. Keep destination pods stopped.',
      });
      console.error('[vm-migration] Final deployment review failed; keep the VM paused and inspect the destination.');
      throw new Error('Final comparison failed. The copy is not approved for cutover.');
    }
  } finally {
    startingJob = false;
  }
}
