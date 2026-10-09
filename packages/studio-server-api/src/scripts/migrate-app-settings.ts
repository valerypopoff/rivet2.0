import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { PostgresAppSettingsBackend } from '../app-settings/managed-settings-store.js';
import {
  parseSettingsTextForMigration,
  type SettingsRepositoryDescriptor,
} from '../app-settings/settings-repository.js';
import {
  deploymentStorageSettingsRepository,
  type DeploymentStorageRuntimeSettings,
} from '../deployment-storage-settings.js';
import { environmentVariableSettingsRepository } from '../environment-variable-settings.js';
import { executorUrlOverrideSettingsRepository } from '../executor-url-override-settings.js';
import { nodeExecutorProxySettingsRepository } from '../node-executor-proxy-settings.js';
import { buildLegacyStorageUrl } from '../object-storage-location.js';
import { parseLegacyPublicRouteSettingsForMigration, publicRouteSettingsRepository } from '../public-route-settings.js';
import { runtimeLimitSettingsRepository } from '../runtime-limit-settings.js';
import { trustedClientSettingsRepository } from '../trusted-client-settings.js';
import { webAppAuthSettingsRepository } from '../web-app-auth-settings.js';
import { workflowEndpointAuthSettingsRepository } from '../workflow-endpoint-auth-settings.js';
import { runRecordingsSettingsRepository } from '../routes/workflows/recordings-config.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import { decodeMigrationSourceUtf8 } from './migration-source-utf8.js';
import { chargeLocalSourceBytes } from '../local-metadata/source-budget.js';
import type { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';

const descriptors: ReadonlyArray<SettingsRepositoryDescriptor<unknown>> = [
  deploymentStorageSettingsRepository.descriptor,
  environmentVariableSettingsRepository.descriptor,
  executorUrlOverrideSettingsRepository.descriptor,
  nodeExecutorProxySettingsRepository.descriptor,
  publicRouteSettingsRepository.descriptor,
  runtimeLimitSettingsRepository.descriptor,
  trustedClientSettingsRepository.descriptor,
  webAppAuthSettingsRepository.descriptor,
  workflowEndpointAuthSettingsRepository.descriptor,
  runRecordingsSettingsRepository.descriptor,
];

export type SettingsRow = {
  key: string;
  schemaVersion: number;
  value: Record<string, unknown>;
  sourceHash: string | null;
};

function canonicalSettingsValue(descriptor: SettingsRepositoryDescriptor<unknown>, value: unknown): string {
  return JSON.stringify({ version: descriptor.currentVersion, ...descriptor.serialize(value) });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readSourceSettingsFile(filePath: string, mayBeMissing: boolean): Promise<string | null> {
  let before: Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (mayBeMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('must be a regular file');
  chargeLocalSourceBytes(before.size);
  const handle = await fs.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error('changed before it could be read');
    const contents = decodeMigrationSourceUtf8(await handle.readFile(), filePath);
    const after = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    if (!sameFile(opened, after) || !afterPath.isFile() || !sameFile(opened, afterPath)) {
      throw new Error('changed while it was read');
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function collectSourceAppSettings(
  sourceRoot: string,
  target?: ManagedWorkflowStorageConfig,
  catalog?: SqliteAppSettingsBackend,
): Promise<SettingsRow[]> {
  const resolvedRoot = path.resolve(sourceRoot);
  const settingsRoot = path.join(resolvedRoot, 'settings');
  const knownNames = new Set(descriptors.map((descriptor) => path.basename(descriptor.getPath())));
  knownNames.add('web-app-routes.json'); // Legacy routes are folded into the public-route domain.
  if (catalog)
    for (const key of catalog.listKeys()) {
      if (!descriptors.some((descriptor) => descriptor.key === key))
        throw new Error(`Unrecognized source App Settings domain: ${key}`);
    }
  const entries = catalog
    ? []
    : await fs.readdir(settingsRoot, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
  const initialNames = entries.map((entry) => entry.name).sort();
  const presentNames = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (!knownNames.has(entry.name)) throw new Error(`Unrecognized source App Settings file: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Source App Settings entry must be a regular file: ${entry.name}`);
  }
  const legacyRoutesPath = path.join(settingsRoot, 'web-app-routes.json');
  const legacyRoutesRaw = presentNames.has('web-app-routes.json')
    ? await readSourceSettingsFile(legacyRoutesPath, false)
    : null;

  const rows: SettingsRow[] = [];
  for (const descriptor of descriptors) {
    const sourcePath = path.join(settingsRoot, path.basename(descriptor.getPath()));
    let raw: string | null = null;
    try {
      if (catalog) {
        const stored = await catalog.read(descriptor.key);
        raw = stored ? JSON.stringify(stored.value) : null;
      } else raw = await readSourceSettingsFile(sourcePath, !presentNames.has(path.basename(sourcePath)));
    } catch (error) {
      throw new Error(`Cannot read source App Settings domain ${descriptor.key}`, { cause: error });
    }
    const sourceValue =
      raw == null
        ? descriptor.key === 'public route'
          ? parseLegacyPublicRouteSettingsForMigration(legacyRoutesRaw)
          : descriptor.getDefault()
        : parseSettingsTextForMigration(descriptor, raw);
    if (
      descriptor.key === 'deployment storage' &&
      (sourceValue as DeploymentStorageRuntimeSettings).storageMode !== 'filesystem'
    ) {
      throw new Error('This importer requires a filesystem source; the VM is already configured for managed storage.');
    }
    const value =
      target && descriptor.key === 'deployment storage'
        ? descriptor.parseStored({
            version: descriptor.currentVersion,
            ...descriptor.serialize(sourceValue),
            storageMode: 'managed',
            databaseMode: 'managed',
            databaseConnectionString: target.databaseUrl,
            databaseSslMode: target.databaseSslMode,
            storageUrl: buildLegacyStorageUrl({
              ...target,
              objectStorageEndpoint: target.objectStorageEndpoint ?? '',
            }),
            objectStorageBucket: target.objectStorageBucket,
            objectStorageEndpoint: target.objectStorageEndpoint ?? '',
            objectStorageRegion: target.objectStorageRegion,
            objectStoragePrefix: target.objectStoragePrefix,
            objectStorageForcePathStyle: target.objectStorageForcePathStyle,
            storageAccessKeyId: target.objectStorageAccessKeyId,
            storageAccessKey: target.objectStorageSecretAccessKey,
          })
        : sourceValue;
    const sourceTextForHash = raw ?? (descriptor.key === 'public route' ? legacyRoutesRaw : null);
    rows.push({
      key: descriptor.key,
      schemaVersion: descriptor.currentVersion,
      value: JSON.parse(canonicalSettingsValue(descriptor, value)) as Record<string, unknown>,
      sourceHash: sourceTextForHash === null ? null : createHash('sha256').update(sourceTextForHash).digest('hex'),
    });
  }
  const finalNames = catalog
    ? []
    : (
        await fs.readdir(settingsRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })
      ).sort();
  if (finalNames.length !== initialNames.length || finalNames.some((name, index) => name !== initialNames[index])) {
    throw new Error('Source App Settings directory changed while it was read.');
  }
  return rows;
}

/** Import absent encrypted rows only. Existing target policy is never overwritten or silently accepted. */
export async function migrateAppSettings(options: {
  sourceRoot: string;
  target: ManagedWorkflowStorageConfig;
  encryptionKey: string;
  verifyOnly?: boolean;
  sourceCatalog?: SqliteAppSettingsBackend;
}): Promise<number> {
  const rows = await collectSourceAppSettings(options.sourceRoot, options.target, options.sourceCatalog);
  const pool = new Pool(getManagedDbPoolConfig(options.target));
  const backend = new PostgresAppSettingsBackend({
    poolConfig: getManagedDbPoolConfig(options.target),
    encryptionSecret: options.encryptionKey,
  });
  try {
    const expectedKeys = new Set(rows.map((row) => row.key));
    const existingKeys = await pool.query<{ setting_key: string }>('SELECT setting_key FROM app_settings');
    for (const existing of existingKeys.rows) {
      if (!expectedKeys.has(existing.setting_key)) {
        throw new Error(`Unexpected managed App Settings domain: ${existing.setting_key}`);
      }
    }
    await backend.initialize();
    for (const row of rows) {
      let stored = await backend.read(row.key);
      if (!stored && !options.verifyOnly) {
        stored = await backend.write({
          key: row.key,
          expectedRevision: null,
          schemaVersion: row.schemaVersion,
          value: row.value,
          sourceHash: row.sourceHash,
        });
        stored ??= await backend.read(row.key);
      }
      if (
        !stored ||
        stored.schemaVersion !== row.schemaVersion ||
        canonicalJson(stored.value) !== canonicalJson(row.value)
      ) {
        throw new Error(`Managed App Settings domain differs from the source: ${row.key}`);
      }
    }
    return rows.length;
  } finally {
    await backend.dispose();
    await pool.end();
  }
}
