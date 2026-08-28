import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import s3Pkg from '@aws-sdk/client-s3';
import smithyNodeHttpHandlerPkg from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'node:https';
import pg from 'pg';
import * as tar from 'tar';

import { getManagedRuntimeLibrariesConfig, getManagedRuntimeLibrariesPoolConfig } from './config.mjs';
import {
  currentDir,
  currentNodeModulesPath,
  ensureDirectories,
  jobsRoot,
  promoteCurrentRelease,
  readManifest,
  removeCurrentRelease,
  writeManifest,
} from './state.mjs';

const { S3Client, GetObjectCommand, HeadBucketCommand } = s3Pkg;
const { NodeHttpHandler } = smithyNodeHttpHandlerPkg;

const REPLICA_STATUS_UNDEFINED_TABLE_CODE = '42P01';
const MANAGED_RUNTIME_LIBRARIES_SCHEMA_UNDEFINED_TABLE_CODE = '42P01';

function createS3Client(config) {
  const clientConfig = {
    region: config.objectStorageRegion,
    forcePathStyle: config.objectStorageForcePathStyle,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets: 16,
        keepAliveMsecs: 30_000,
      }),
    }),
    credentials: {
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
    },
  };

  if (config.objectStorageEndpoint) {
    clientConfig.endpoint = config.objectStorageEndpoint;
  }

  return new S3Client(clientConfig);
}

function normalizeBlobKey(key) {
  return key.replace(/^\/+/, '').replace(/\\/g, '/');
}

function prefixedBlobKey(prefix, key) {
  return `${prefix}${normalizeBlobKey(key)}`;
}

function getPgErrorCode(error) {
  return typeof error === 'object' && error != null && 'code' in error ? String(error.code ?? '') : '';
}

async function queryActiveRelease(pool) {
  const result = await pool.query(`
    SELECT r.release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256, r.created_at, a.updated_at
    FROM runtime_library_activation a
    LEFT JOIN runtime_library_releases r ON r.release_id = a.active_release_id
    WHERE a.slot = 'default'
  `);

  return result.rows[0] ?? null;
}

function createReplicaStatusReporter(pool, config) {
  if (config.runtimeReplicaTier === 'none') {
    const noop = async () => {};
    return {
      reportStarting: noop,
      reportSyncing: noop,
      reportReady: noop,
      reportError: noop,
      dispose: noop,
    };
  }

  const hostname = os.hostname();
  const podName = process.env.HOSTNAME?.trim() || null;
  const displayName = podName || `${config.runtimeProcessRole}-${hostname}-${process.pid}`;
  const replicaId = `${config.runtimeProcessRole}-${hostname}-${process.pid}-${randomUUID()}`;
  const tier = config.runtimeReplicaTier;

  let schemaMissingLogged = false;
  let lastCleanupAt = 0;
  let priorReplicaRowsCleared = false;

  const safeReplicaStatusWrite = async (action, fn) => {
    try {
      await fn();
      schemaMissingLogged = false;
    } catch (error) {
      if (getPgErrorCode(error) === REPLICA_STATUS_UNDEFINED_TABLE_CODE) {
        if (!schemaMissingLogged) {
          console.warn(`[runtime-libraries] replica-status reporting skipped during ${action}: runtime_library_replica_status does not exist yet.`);
          schemaMissingLogged = true;
        }
        return;
      }

      console.error(`[runtime-libraries] replica-status reporting failed during ${action}:`, error);
    }
  };

  const upsert = async ({
    targetReleaseId,
    syncedReleaseId,
    syncState,
    lastError,
    lastSyncStartedAt,
    lastSyncCompletedAt,
  }) => {
    await safeReplicaStatusWrite('status upsert', async () => {
      await pool.query(
        `
          INSERT INTO runtime_library_replica_status(
            replica_id,
            tier,
            process_role,
            display_name,
            hostname,
            pod_name,
            target_release_id,
            synced_release_id,
            sync_state,
            last_error,
            last_sync_started_at,
            last_sync_completed_at,
            last_heartbeat_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
          ON CONFLICT (replica_id)
          DO UPDATE SET
            tier = EXCLUDED.tier,
            process_role = EXCLUDED.process_role,
            display_name = EXCLUDED.display_name,
            hostname = EXCLUDED.hostname,
            pod_name = EXCLUDED.pod_name,
            target_release_id = EXCLUDED.target_release_id,
            synced_release_id = EXCLUDED.synced_release_id,
            sync_state = EXCLUDED.sync_state,
            last_error = EXCLUDED.last_error,
            last_sync_started_at = EXCLUDED.last_sync_started_at,
            last_sync_completed_at = EXCLUDED.last_sync_completed_at,
            last_heartbeat_at = NOW(),
            updated_at = NOW()
        `,
        [
          replicaId,
          tier,
          config.runtimeProcessRole,
          displayName,
          hostname,
          podName,
          targetReleaseId,
          syncedReleaseId,
          syncState,
          lastError,
          lastSyncStartedAt,
          lastSyncCompletedAt,
        ],
      );
    });
  };

  const clearPriorReplicaRows = async () => {
    if (priorReplicaRowsCleared) {
      return;
    }

    await safeReplicaStatusWrite('superseded status cleanup', async () => {
      await pool.query(
        `
          DELETE FROM runtime_library_replica_status
          WHERE process_role = $1
            AND display_name = $2
            AND replica_id <> $3
        `,
        [config.runtimeProcessRole, displayName, replicaId],
      );
      priorReplicaRowsCleared = true;
    });
  };

  const cleanupStaleRows = async () => {
    if (Date.now() - lastCleanupAt < config.replicaStatusCleanupIntervalMs) {
      return;
    }

    await safeReplicaStatusWrite('status cleanup', async () => {
      await pool.query(
        `
          DELETE FROM runtime_library_replica_status
          WHERE last_heartbeat_at < NOW() - ($1 * INTERVAL '1 millisecond')
        `,
        [config.replicaStatusRetentionMs],
      );
      lastCleanupAt = Date.now();
    });
  };

  return {
    async reportStarting() {
      await clearPriorReplicaRows();
      await upsert({
        targetReleaseId: null,
        syncedReleaseId: null,
        syncState: 'starting',
        lastError: null,
        lastSyncStartedAt: null,
        lastSyncCompletedAt: null,
      });
      await cleanupStaleRows();
    },
    async reportSyncing({ targetReleaseId, syncedReleaseId, lastSyncStartedAt }) {
      await upsert({
        targetReleaseId,
        syncedReleaseId,
        syncState: 'syncing',
        lastError: null,
        lastSyncStartedAt,
        lastSyncCompletedAt: null,
      });
      await cleanupStaleRows();
    },
    async reportReady({ targetReleaseId, syncedReleaseId, lastSyncStartedAt, lastSyncCompletedAt }) {
      await upsert({
        targetReleaseId,
        syncedReleaseId,
        syncState: 'ready',
        lastError: null,
        lastSyncStartedAt,
        lastSyncCompletedAt,
      });
      await cleanupStaleRows();
    },
    async reportError({ targetReleaseId, syncedReleaseId, lastSyncStartedAt, error }) {
      await upsert({
        targetReleaseId,
        syncedReleaseId,
        syncState: 'error',
        lastError: error instanceof Error ? error.message : String(error),
        lastSyncStartedAt,
        lastSyncCompletedAt: null,
      });
      await cleanupStaleRows();
    },
    async dispose() {
      await safeReplicaStatusWrite('status delete', async () => {
        await pool.query('DELETE FROM runtime_library_replica_status WHERE replica_id = $1', [replicaId]);
      });
    },
  };
}

export function createManagedRuntimeLibrariesSyncController() {
  const config = getManagedRuntimeLibrariesConfig();
  if (!config.objectStorageBucket || !config.objectStorageAccessKeyId || !config.objectStorageSecretAccessKey) {
    throw new Error('Managed runtime-library sync requires object-storage bucket and credentials');
  }

  ensureDirectories();
  const pool = new pg.Pool(getManagedRuntimeLibrariesPoolConfig(config));
  const s3 = createS3Client(config);
  const reporter = createReplicaStatusReporter(pool, config);
  let syncPromise = null;
  let lastSyncCheckAt = 0;
  let schemaMissingLogged = false;

  const queryActiveReleaseOrSkip = async () => {
    try {
      const activeRelease = await queryActiveRelease(pool);
      schemaMissingLogged = false;
      return activeRelease;
    } catch (error) {
      if (getPgErrorCode(error) === MANAGED_RUNTIME_LIBRARIES_SCHEMA_UNDEFINED_TABLE_CODE) {
        if (!schemaMissingLogged) {
          console.warn('[runtime-libraries] managed runtime-library tables do not exist yet; bootstrap sync will retry after schema initialization.');
          schemaMissingLogged = true;
        }
        return undefined;
      }

      throw error;
    }
  };

  const syncCurrentRelease = async (force = false) => {
    if (syncPromise) {
      if (!force) {
        return syncPromise;
      }

      await syncPromise;
    }

    if (!force && Date.now() - lastSyncCheckAt < config.syncPollIntervalMs) {
      return;
    }

    const run = (async () => {
      const syncStartedAt = new Date().toISOString();
      let activeRelease = null;
      let cachedReleaseId = null;
      let nextReleaseId = null;
      let nextPackages = {};

      try {
        activeRelease = await queryActiveReleaseOrSkip();
        if (activeRelease === undefined) {
          return;
        }
        const manifest = readManifest();
        cachedReleaseId = manifest.activeReleaseId ?? null;
        nextReleaseId = activeRelease?.release_id ?? null;
        nextPackages = activeRelease?.packages_json && typeof activeRelease.packages_json === 'object'
          ? activeRelease.packages_json
          : {};

        if (!nextReleaseId) {
          if (cachedReleaseId || currentNodeModulesPath()) {
            await reporter.reportSyncing({
              targetReleaseId: null,
              syncedReleaseId: cachedReleaseId,
              lastSyncStartedAt: syncStartedAt,
            });
            removeCurrentRelease();
            writeManifest({ packages: {}, updatedAt: new Date().toISOString() });
          }

          lastSyncCheckAt = Date.now();
          const completedAt = new Date().toISOString();
          await reporter.reportReady({
            targetReleaseId: null,
            syncedReleaseId: null,
            lastSyncStartedAt: syncStartedAt,
            lastSyncCompletedAt: completedAt,
          });
          return;
        }

        if (Object.keys(nextPackages).length === 0) {
          if (cachedReleaseId !== nextReleaseId || currentNodeModulesPath()) {
            await reporter.reportSyncing({
              targetReleaseId: nextReleaseId,
              syncedReleaseId: cachedReleaseId,
              lastSyncStartedAt: syncStartedAt,
            });
            removeCurrentRelease();
            writeManifest({
              packages: {},
              updatedAt: activeRelease.updated_at ? new Date(activeRelease.updated_at).toISOString() : new Date().toISOString(),
              activeReleaseId: nextReleaseId,
            });
          }

          lastSyncCheckAt = Date.now();
          const completedAt = new Date().toISOString();
          await reporter.reportReady({
            targetReleaseId: nextReleaseId,
            syncedReleaseId: nextReleaseId,
            lastSyncStartedAt: syncStartedAt,
            lastSyncCompletedAt: completedAt,
          });
          return;
        }

        if (
          cachedReleaseId === nextReleaseId &&
          currentNodeModulesPath() &&
          fs.existsSync(path.join(currentDir(), 'package.json'))
        ) {
          lastSyncCheckAt = Date.now();
          const completedAt = new Date().toISOString();
          await reporter.reportReady({
            targetReleaseId: nextReleaseId,
            syncedReleaseId: nextReleaseId,
            lastSyncStartedAt: syncStartedAt,
            lastSyncCompletedAt: completedAt,
          });
          return;
        }

        await reporter.reportSyncing({
          targetReleaseId: nextReleaseId,
          syncedReleaseId: cachedReleaseId,
          lastSyncStartedAt: syncStartedAt,
        });

        if (!activeRelease.artifact_blob_key) {
          throw new Error(`Active runtime-library release ${nextReleaseId} is missing its artifact pointer`);
        }

        const response = await s3.send(new GetObjectCommand({
          Bucket: config.objectStorageBucket,
          Key: prefixedBlobKey(config.objectStoragePrefix, activeRelease.artifact_blob_key),
        }));

        if (!response.Body) {
          throw new Error(`Object body missing for runtime-library artifact ${activeRelease.artifact_blob_key}`);
        }

        const archiveBuffer = Buffer.from(await response.Body.transformToByteArray());
        const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');
        if (activeRelease.artifact_sha256 && archiveSha256 !== activeRelease.artifact_sha256) {
          throw new Error(`Runtime-library artifact checksum mismatch for release ${nextReleaseId}`);
        }

        const tempRoot = fs.mkdtempSync(path.join(jobsRoot(), `sync-${nextReleaseId}-`));
        const archivePath = path.join(tempRoot, 'release.tar');
        const extractedDir = path.join(tempRoot, 'candidate');

        try {
          fs.mkdirSync(extractedDir, { recursive: true });
          fs.writeFileSync(archivePath, archiveBuffer);

          await tar.x({
            file: archivePath,
            cwd: extractedDir,
          });

          promoteCurrentRelease(extractedDir);
          writeManifest({
            packages: nextPackages,
            updatedAt: activeRelease.updated_at ? new Date(activeRelease.updated_at).toISOString() : new Date().toISOString(),
            activeReleaseId: nextReleaseId,
          });
          lastSyncCheckAt = Date.now();
          const completedAt = new Date().toISOString();
          await reporter.reportReady({
            targetReleaseId: nextReleaseId,
            syncedReleaseId: nextReleaseId,
            lastSyncStartedAt: syncStartedAt,
            lastSyncCompletedAt: completedAt,
          });
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      } catch (error) {
        const latestManifest = readManifest();
        await reporter.reportError({
          targetReleaseId: nextReleaseId,
          syncedReleaseId: latestManifest.activeReleaseId ?? cachedReleaseId,
          lastSyncStartedAt: syncStartedAt,
          error,
        });
        throw error;
      }
    })();

    syncPromise = run.finally(() => {
      syncPromise = null;
    });

    return syncPromise;
  };

  return {
    config,
    syncCurrentRelease,
    async initialize() {
      await s3.send(new HeadBucketCommand({ Bucket: config.objectStorageBucket }));
      await reporter.reportStarting();
      await syncCurrentRelease(true);
    },
    async dispose() {
      syncPromise = null;
      lastSyncCheckAt = 0;
      await reporter.dispose();
      await pool.end().catch(() => {});
    },
  };
}
