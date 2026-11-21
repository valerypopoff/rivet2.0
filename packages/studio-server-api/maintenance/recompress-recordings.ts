import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  assertRecordingReaderInventory,
  assertRecordingReleaseSettled,
} from '../../../deploy/studio-server/scripts/lib/recording-reader-inventory.mjs';
import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from '../../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs';
import { getManagedDbPoolConfig } from '../src/routes/workflows/managed/db.js';
import { S3ManagedWorkflowBlobStore } from '../src/routes/workflows/managed/blob-store.js';
import {
  createManagedWorkflowMaintenance,
  getManagedWorkflowMaintenanceConfig,
} from '../src/routes/workflows/managed/maintenance.js';
import {
  CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  verifyManagedWorkflowSchema,
} from '../src/routes/workflows/managed/schema-migrations.js';
import {
  inventoryRecordingEncodings,
  readRecordingRestoreIdentity,
  recompressRecordingBatch,
  type RecordingRecompressionCursor,
} from './recording-recompression.js';
import {
  readRecordingStorageConfig,
  recordingOperatorTransaction,
  recordingStorageIdentity,
  withRecordingOperatorLease,
} from './recording-storage-operator.js';

type Receipt = {
  version: 1;
  codec: 'br4';
  storage: string;
  restore: string;
  cutoff: string;
  workflow: string | null;
  after?: RecordingRecompressionCursor;
  exhausted?: boolean;
};

async function main() {
  // Yarn workspace commands run from the package; operator paths are repo-relative.
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      apply: { type: 'boolean' },
      receipt: { type: 'string' },
      limit: { type: 'string', default: '100' },
      'max-seconds': { type: 'string', default: '30' },
      'max-object-mib': { type: 'string', default: '32' },
      'workflow-id': { type: 'string' },
      'reader-manifest': { type: 'string' },
      context: { type: 'string' },
      namespace: { type: 'string' },
      release: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'Default: read-only inventory. Apply one bounded batch: --apply --receipt <private.json> --reader-manifest <promoted.json> --context <kube-context> --namespace <namespace> --release <release> [--limit 1..1000] [--max-seconds 1..120] [--max-object-mib 1..100] [--workflow-id <id>]. Reuse the receipt to resume; start a new receipt for another pass.',
    );
    return;
  }
  const integer = (value: string, maximum: number) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error('Invalid recompression budget.');
    return n;
  };
  const limit = integer(values.limit!, 1000),
    seconds = integer(values['max-seconds']!, 120),
    maxObject = integer(values['max-object-mib']!, 100);
  if (
    values.apply &&
    (!values.receipt || !values['reader-manifest'] || !values.context || !values.namespace || !values.release)
  )
    throw new Error(
      'Apply requires a private resume receipt and an explicit installed-reader manifest/Kubernetes identity.',
    );
  const config = await readRecordingStorageConfig();
  if (!values.apply) {
    const pool = new Pool({
      ...getManagedDbPoolConfig(config),
      options: '-c default_transaction_read_only=on -c statement_timeout=15000',
      max: 1,
    });
    try {
      console.log(
        JSON.stringify({
          mode: 'inventory',
          recordings: await inventoryRecordingEncodings({ pool }, values['workflow-id']),
        }),
      );
    } finally {
      await pool.end();
    }
    return;
  }
  const manifest = assertStudioServerReleaseManifest(
    JSON.parse(await fs.readFile(values['reader-manifest']!, 'utf8')),
    { requirePromoted: true },
  );
  const readerDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
  const kube = (resource: string, filterByRelease = true) => {
    try {
      return JSON.parse(
        execFileSync(
          'kubectl',
          [
            '--context',
            values.context!,
            '--namespace',
            values.namespace!,
            '--request-timeout=10s',
            'get',
            resource,
            ...(filterByRelease ? ['-l', `app.kubernetes.io/instance=${values.release}`] : []),
            '-o',
            'json',
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      );
    } catch {
      throw new Error('Could not verify the selected Kubernetes reader inventory.');
    }
  };
  const assertReaders = async () => {
    const maps = kube('configmaps', false).items;
    assertRecordingReleaseSettled(maps, values.release!, values.namespace!, readerDigest);
    if (
      !maps.some(
        (item: { metadata?: { labels?: Record<string, string> }; data?: Record<string, string> }) =>
          item.metadata?.labels?.['app.kubernetes.io/instance'] === values.release &&
          item.data?.['release-manifest-digest'] === readerDigest,
      )
    )
      throw new Error('Reader manifest is not installed in the selected namespace.');
    assertRecordingReaderInventory(
      manifest,
      kube('pods,deployments,statefulsets,jobs,cronjobs').items,
      values.release!,
    );
  };
  const receiptPath = path.resolve(values.receipt!);
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Recompression interrupted.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const blobStore = new S3ManagedWorkflowBlobStore(config);
  try {
    await withRecordingOperatorLease(config, 'converter', async (pool, leaseSignal, check, client) => {
      const existing = await fs
        .readFile(receiptPath, 'utf8')
        .then((text) => JSON.parse(text) as Receipt)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      await verifyManagedWorkflowSchema(pool, {
        compatibilityWindow: {
          minimumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
          maximumVersion: CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
        },
      });
      const restore = await readRecordingRestoreIdentity(client);
      if (JSON.parse(restore).deployment !== `${values.namespace}/${values.release}`)
        throw new Error('The configured database belongs to another deployment.');
      const storage = recordingStorageIdentity(config),
        workflow = values['workflow-id'] ?? null;
      const receipt: Receipt = existing ?? {
        version: 1,
        codec: 'br4',
        storage,
        restore,
        workflow,
        cutoff: (
          await client.query<{ cutoff: string }>(
            `SELECT TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`,
          )
        ).rows[0]!.cutoff,
      };
      if (
        receipt.version !== 1 ||
        receipt.codec !== 'br4' ||
        receipt.storage !== storage ||
        receipt.restore !== restore ||
        receipt.workflow !== workflow ||
        !Number.isFinite(Date.parse(receipt.cutoff)) ||
        (receipt.exhausted !== undefined && typeof receipt.exhausted !== 'boolean')
      )
        throw new Error('Receipt belongs to a different storage, restore epoch or workflow scope.');
      const signal = AbortSignal.any([stop.signal, leaseSignal]);
      const context = {
        pool,
        blobStore,
        withTransaction: recordingOperatorTransaction(client),
        maintenance: createManagedWorkflowMaintenance({
          pool,
          blobStore,
          config: getManagedWorkflowMaintenanceConfig(),
        }),
      };
      const result = receipt.exhausted
        ? null
        : await recompressRecordingBatch(context, {
            cutoff: receipt.cutoff,
            restoreIdentity: restore,
            signal,
            limit,
            after: receipt.after,
            workflowId: values['workflow-id'],
            maxDecodedBytes: maxObject * 1024 * 1024,
            deadline: Date.now() + seconds * 1000,
            assertReaders: async () => {
              await check();
              await assertReaders();
            },
          });
      await check();
      if (result) {
        receipt.after = result.after;
        receipt.exhausted = result.exhausted;
      }
      await fs.mkdir(path.dirname(receiptPath), { recursive: true });
      const temporary = receiptPath + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, receiptPath);
      console.log(
        JSON.stringify({
          mode: 'apply',
          result,
          inventory: await inventoryRecordingEncodings({ pool }, values['workflow-id']),
          note: 'Queued bytes are reclaimed by normal maintenance. Held or late-imported recordings need another explicit pass.',
        }),
      );
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    blobStore.dispose();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Recording recompression stopped.');
  process.exitCode = 1;
});
