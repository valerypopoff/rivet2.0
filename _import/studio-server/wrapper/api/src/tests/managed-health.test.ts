import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeHttpHandler } from '@smithy/node-http-handler';

import {
  createManagedObjectStorageHttpHandlerOptions,
  MANAGED_OBJECT_STORAGE_CONNECTION_TIMEOUT_MS,
  MANAGED_OBJECT_STORAGE_SOCKET_TIMEOUT_MS,
  MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
} from '../managed-health.js';
import { createManagedWorkflowS3ClientConfig } from '../routes/workflows/managed/blob-store.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import type { ManagedRuntimeLibrariesConfig } from '../runtime-libraries/config.js';
import { createRuntimeLibrariesS3ClientConfig } from '../runtime-libraries/managed/blob-store.js';
import { getPoolConfig as getRuntimeLibrariesPoolConfig } from '../runtime-libraries/managed/schema.js';

const workflowConfig: ManagedWorkflowStorageConfig = {
  databaseMode: 'managed',
  databaseUrl: 'postgresql://rivet@example.test/rivet',
  databaseSslMode: 'require',
  objectStorageBucket: 'rivet',
  objectStorageRegion: 'us-east-1',
  objectStorageEndpoint: 'https://objects.example.test',
  objectStorageAccessKeyId: 'access',
  objectStorageSecretAccessKey: 'secret',
  objectStoragePrefix: 'workflows/',
  objectStorageForcePathStyle: false,
};

const runtimeLibrariesConfig: ManagedRuntimeLibrariesConfig = {
  ...workflowConfig,
  objectStoragePrefix: 'runtime-libraries/',
  syncPollIntervalMs: 5_000,
  runtimeProcessRole: 'api',
  runtimeReplicaTier: 'endpoint',
  replicaStatusRetentionMs: 60_000,
  replicaStatusCleanupIntervalMs: 60_000,
  jobWorkerEnabled: true,
};

function assertS3HandlerContract(createConfig: () => { requestHandler?: unknown }): void {
  const firstHandler = createConfig().requestHandler;
  const secondHandler = createConfig().requestHandler;
  assert.ok(firstHandler instanceof NodeHttpHandler);
  assert.ok(secondHandler instanceof NodeHttpHandler);

  const firstOptions = createManagedObjectStorageHttpHandlerOptions();
  const secondOptions = createManagedObjectStorageHttpHandlerOptions();
  assert.equal(firstOptions.connectionTimeout, MANAGED_OBJECT_STORAGE_CONNECTION_TIMEOUT_MS);
  assert.equal(firstOptions.socketTimeout, MANAGED_OBJECT_STORAGE_SOCKET_TIMEOUT_MS);
  assert.notEqual(firstOptions.httpsAgent, secondOptions.httpsAgent);

  firstHandler.destroy();
  secondHandler.destroy();
}

test('managed dependency clients bound connection stalls and isolate S3 agents', () => {
  assert.equal(
    getManagedDbPoolConfig(workflowConfig).connectionTimeoutMillis,
    MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
  );
  assert.equal(
    getRuntimeLibrariesPoolConfig(runtimeLibrariesConfig).connectionTimeoutMillis,
    MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
  );
  assertS3HandlerContract(() => createManagedWorkflowS3ClientConfig(workflowConfig));
  assertS3HandlerContract(() => createRuntimeLibrariesS3ClientConfig(runtimeLibrariesConfig));
});