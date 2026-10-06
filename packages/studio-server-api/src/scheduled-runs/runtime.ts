import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeDurableExclusive, syncDirectory } from '../routes/workflows/filesystem-transaction-primitives.js';
import { Pool } from 'pg';
import { getAppDataRoot } from '../security.js';
import { getLocalMetadataServingSelection } from '../local-metadata/serving-selection.js';
import { assertLocalMetadataWritesAllowed } from '../local-metadata/runtime-control.js';
import { isVmMigrationMaintenanceActive } from '../vm-migration-maintenance.js';
import {
  getManagedWorkflowStorageConfig,
  isManagedWorkflowStorageEnabled,
} from '../routes/workflows/storage-config.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { createHttpError } from '../utils/httpError.js';
import { ScheduledRunStore } from './store.js';
import { ScheduledRunService } from './service.js';
import { runScheduledGraph } from './runner.js';
import { beginScheduledActivity } from './activity.js';
import { settleBeforeDeadline } from '../shutdown-deadline.js';

let service: ScheduledRunService | undefined;
let stopping = false;
let initialization: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let shutdown: Promise<void> | undefined;
function deferInitialization() {
  if (stopping || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void initializeScheduledRuns().catch(() => {
      console.error('[scheduled-runs] Deferred initialization failed; scheduling remains unavailable.');
      deferInitialization();
    });
  }, 2000);
  retryTimer.unref();
}
async function installationIdentity(control: string): Promise<string> {
  try {
    const configuration = JSON.parse(await fs.readFile(path.join(control, 'ui-configuration.json'), 'utf8'));
    const identity =
      configuration.version === 2 && typeof configuration.installationId === 'string'
        ? configuration.installationId
        : configuration.version === 1 && typeof configuration.key === 'string'
          ? createHash('sha256').update(configuration.key).digest('hex')
          : undefined;
    if (!identity) throw new Error('Missing scheduler installation identity.');
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Manually provisioned control roots have no UI-managed configuration.
  const file = path.join(control, 'scheduler-installation-id');
  try {
    await writeDurableExclusive(file, randomUUID(), 0o600);
    await syncDirectory(control);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100)
    throw new Error('Invalid scheduler installation binding.');
  const identity = await fs.readFile(file, 'utf8');
  if (!/^[a-f0-9-]{36}$/.test(identity)) throw new Error('Invalid scheduler installation binding.');
  return identity;
}
export function assertScheduleWritesAllowed() {
  if (isVmMigrationMaintenanceActive())
    throw createHttpError(409, 'Scheduled runs are paused during storage migration.');
  assertLocalMetadataWritesAllowed();
}
export function getScheduledRunService() {
  if (!service)
    throw createHttpError(503, 'Scheduled runs are unavailable while storage is paused or the server is starting.');
  return service;
}
export async function initializeScheduledRuns() {
  if (service || stopping) return;
  if (initialization) return initialization;
  const release = beginScheduledActivity();
  initialization = initializeStore().finally(() => {
    release();
    initialization = undefined;
  });
  return initialization;
}
async function initializeStore() {
  const maxConcurrent = Number(process.env.RIVET_SCHEDULED_RUNS_MAX_CONCURRENT ?? '1');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)
    throw new Error('RIVET_SCHEDULED_RUNS_MAX_CONCURRENT must be 1–8.');
  // No DDL, installation binding or WAL opening on a frozen source. Resume can
  // happen in this process, so arm a small retry rather than requiring a browser.
  try {
    assertScheduleWritesAllowed();
  } catch {
    deferInitialization();
    return;
  }
  let store: ScheduledRunStore;
  if (isManagedWorkflowStorageEnabled()) {
    const pool = new Pool({
      ...getManagedDbPoolConfig(getManagedWorkflowStorageConfig()),
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      await pool.query('SELECT id FROM rivet_schedules LIMIT 0');
      await pool.query('SELECT id FROM rivet_schedule_runs LIMIT 0');
      await pool.query('SELECT id,fingerprint,expires_at,resource_id,json FROM rivet_schedule_requests LIMIT 0');
      await pool.query('SELECT key,value FROM rivet_schedule_installation LIMIT 0');
    } catch (error) {
      await pool.end();
      throw error;
    }
    store = ScheduledRunStore.postgres(pool);
  } else {
    assertLocalMetadataWritesAllowed();
    const root = getLocalMetadataServingSelection()?.operationalRoot ?? getAppDataRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    store = ScheduledRunStore.sqlite(path.join(root, 'scheduled-runs.sqlite'));
    try {
      const control = process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT?.trim();
      if (control) {
        await store.bindInstallation(await installationIdentity(control));
      }
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  if (stopping) {
    await store.close();
    return;
  }
  try {
    assertScheduleWritesAllowed();
  } catch {
    await store.close();
    deferInitialization();
    return;
  }
  service = new ScheduledRunService(
    store,
    (job, owner, signal) => runScheduledGraph(job, store, owner, signal),
    () => {
      try {
        assertScheduleWritesAllowed();
        return true;
      } catch {
        return false;
      }
    },
    maxConcurrent,
  );
  service.start();
}
export function stopScheduledRuns(graceMs = 30_000): Promise<void> {
  return (shutdown ??= stopOnce(Date.now() + Math.max(0, graceMs)));
}
async function stopOnce(deadline: number) {
  stopping = true;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  await settleBeforeDeadline(initialization?.catch(() => undefined) ?? Promise.resolve(), deadline);
  const old = service;
  service = undefined;
  if (old) await old.stop(Math.max(0, deadline - Date.now()));
}
