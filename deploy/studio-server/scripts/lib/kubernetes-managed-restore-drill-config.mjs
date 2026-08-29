import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import {
  assertStudioServerReleaseManifest,
  STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS,
} from './studio-server-release-manifest.mjs';

export const MANAGED_RESTORE_BACKUP_MANIFEST_VERSION = 1;
export const MANAGED_RESTORE_DRIVER_REPORT_VERSION = 1;
export const MANAGED_RESTORE_INTEGRITY_REPORT_VERSION = 1;
export const MANAGED_RESTORE_REQUIRED_PROBES = [
  'appSettings',
  'oauth',
  'project',
  'workflow',
  'webApp',
  'recording',
  'evaluation',
  'runtimeLibrary',
];

const runnerName = 'kubernetes-managed-restore-drill';
const dnsLabelPattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const restoreNamespacePattern = /^rivet-restore-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const encryptionKeyIdPattern = /^[a-f0-9]{16}$/;

function fail(message) {
  throw new Error(`[${runnerName}] ${message}`);
}

function assertObject(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${description} must be an object`);
  }
  return value;
}

function assertOnlyKeys(value, keys, description) {
  const object = assertObject(value, description);
  const allowed = new Set(keys);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${description} contains unsupported field(s): ${unknown.sort().join(', ')}`);
  }
  return object;
}

function requireString(value, description) {
  if (typeof value !== 'string' || !value.trim()) fail(`${description} is required`);
  if (/\r|\n/u.test(value)) fail(`${description} must not contain a line break`);
  return value.trim();
}

function requireIdentifier(value, description) {
  const normalized = requireString(value, description);
  if (normalized.length > 512) fail(`${description} is too long`);
  return normalized;
}

function requireDnsLabel(value, description) {
  const normalized = requireString(value, description);
  if (normalized.length > 63 || !dnsLabelPattern.test(normalized)) {
    fail(`${description} must be a DNS label of at most 63 characters`);
  }
  return normalized;
}

function requireTimestamp(value, description) {
  const normalized = requireString(value, description);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) fail(`${description} must be an ISO timestamp`);
  return date.toISOString();
}

function requirePositiveInteger(value, description) {
  if (!Number.isInteger(value) || value < 1) fail(`${description} must be a positive integer`);
  return value;
}

function requireNonNegativeInteger(value, description) {
  if (!Number.isInteger(value) || value < 0) fail(`${description} must be a non-negative integer`);
  return value;
}

function optionalString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function requireSafePrefix(value, description) {
  const prefix = requireString(value, description)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${description} must be a non-empty object-storage prefix without dot segments`);
  }
  return prefix;
}

function normalizeKeyIds(value, description) {
  if (!Array.isArray(value) || value.length === 0) fail(`${description} must contain at least one key id`);
  const keyIds = value.map((item, index) => {
    const keyId = requireString(item, `${description}[${index}]`).toLowerCase();
    if (!encryptionKeyIdPattern.test(keyId)) {
      fail(`${description}[${index}] must be a 16-character lowercase hexadecimal key id`);
    }
    return keyId;
  });
  if (new Set(keyIds).size !== keyIds.length) fail(`${description} must not contain duplicates`);
  return keyIds.sort();
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseJsonFile(filePath, description) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`could not read ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${description} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertPathInside(directory, candidate, description) {
  const resolved = path.resolve(directory, requireString(candidate, description));
  const relative = path.relative(directory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${description} must remain inside ${directory}`);
  }
  return resolved;
}

function assertExistingRegularFile(filePath, description) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    fail(`${description} must identify a readable regular file`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`${description} must identify a readable non-symlink regular file`);
  }
  return filePath;
}

function assertExistingRegularFileInside(directory, candidate, description) {
  const filePath = assertExistingRegularFile(assertPathInside(directory, candidate, description), description);
  return assertPathInside(fs.realpathSync(directory), fs.realpathSync(filePath), description);
}

function assertArtifactPath(rootDir, candidate) {
  const realRootDir = fs.realpathSync(rootDir);
  const resolved = path.resolve(realRootDir, requireString(candidate, 'RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR'));
  const relative = path.relative(realRootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR must remain inside the repository');
  }
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      fail('RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR must resolve from an existing repository directory');
    }
    existingAncestor = parent;
  }
  const ancestorStats = fs.lstatSync(existingAncestor);
  if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink()) {
    fail('RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR must not use a symlink or non-directory ancestor');
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  const rootRelative = path.relative(realRootDir, realAncestor);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) {
    fail('RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR must not resolve outside the repository');
  }
  return resolved;
}

function normalizeHttpsOrigin(value, description) {
  let url;
  try {
    url = new URL(requireString(value, description));
  } catch {
    fail(`${description} must be a valid HTTPS URL`);
  }
  // A DNS root-label dot does not identify a different host. Normalize it before
  // comparing the backup source and the disposable restore target.
  const hostname = url.hostname.replace(/\.+$/u, '').toLowerCase();
  const bareHostname = hostname.replace(/^\[|\]$/gu, '');
  if (url.protocol !== 'https:' || !hostname || hostname === 'localhost' || isIP(bareHostname) !== 0) {
    fail(`${description} must use a non-local HTTPS DNS hostname`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    fail(`${description} must contain only an HTTPS origin`);
  }
  url.hostname = hostname;
  return url.origin;
}

function normalizeProbe(value, description) {
  const probe = assertOnlyKeys(value, ['path', 'method', 'body', 'expectedStatus', 'contains'], description);
  const pathValue = requireString(probe.path, `${description}.path`);
  if (!pathValue.startsWith('/') || pathValue.startsWith('//') || pathValue.includes('://')) {
    fail(`${description}.path must be an absolute path on the restore target host`);
  }
  const method = String(probe.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) fail(`${description}.method must be GET or POST`);
  const expectedStatus = probe.expectedStatus ?? 200;
  if (!Number.isInteger(expectedStatus) || expectedStatus < 200 || expectedStatus > 299) {
    fail(`${description}.expectedStatus must be a 2xx status`);
  }
  const contains = requireString(probe.contains, `${description}.contains`);
  return { path: pathValue, method, body: probe.body, expectedStatus, contains };
}

function normalizeDriver(value, description, configDirectory, role) {
  const driver = assertOnlyKeys(value, ['applyFile', 'jobName', 'timeoutSeconds'], description);
  return {
    applyFile: assertExistingRegularFileInside(configDirectory, driver.applyFile, `${description}.applyFile`),
    jobName: requireDnsLabel(driver.jobName, `${description}.jobName`),
    timeoutSeconds: requirePositiveInteger(driver.timeoutSeconds ?? 900, `${description}.timeoutSeconds`),
    role,
  };
}

export function parseManagedRestoreBackupManifest(value) {
  const manifest = assertOnlyKeys(
    value,
    ['formatVersion', 'createdAt', 'source', 'release', 'database', 'objectStorage', 'appSettings'],
    'backup manifest',
  );
  if (manifest.formatVersion !== MANAGED_RESTORE_BACKUP_MANIFEST_VERSION) {
    fail(`backup manifest.formatVersion must be ${MANAGED_RESTORE_BACKUP_MANIFEST_VERSION}`);
  }
  const source = assertOnlyKeys(manifest.source, ['namespace', 'baseUrl'], 'backup manifest.source');
  const database = assertOnlyKeys(
    manifest.database,
    ['provider', 'sourceId', 'recoveryPointId', 'recoveryPointAt'],
    'backup manifest.database',
  );
  const objectStorage = assertOnlyKeys(
    manifest.objectStorage,
    ['provider', 'bucket', 'prefix', 'recoveryPointId', 'recoveryPointAt', 'versioningRetentionSeconds'],
    'backup manifest.objectStorage',
  );
  const appSettings = assertOnlyKeys(manifest.appSettings, ['encryptionKeyIds'], 'backup manifest.appSettings');
  const release = assertStudioServerReleaseManifest(manifest.release, { requirePromoted: true });
  const normalized = {
    formatVersion: MANAGED_RESTORE_BACKUP_MANIFEST_VERSION,
    createdAt: requireTimestamp(manifest.createdAt, 'backup manifest.createdAt'),
    source: {
      namespace: requireDnsLabel(source.namespace, 'backup manifest.source.namespace'),
      baseUrl: normalizeHttpsOrigin(source.baseUrl, 'backup manifest.source.baseUrl'),
    },
    release,
    database: {
      provider: requireIdentifier(database.provider, 'backup manifest.database.provider'),
      sourceId: requireIdentifier(database.sourceId, 'backup manifest.database.sourceId'),
      recoveryPointId: requireIdentifier(database.recoveryPointId, 'backup manifest.database.recoveryPointId'),
      recoveryPointAt: requireTimestamp(database.recoveryPointAt, 'backup manifest.database.recoveryPointAt'),
    },
    objectStorage: {
      provider: requireIdentifier(objectStorage.provider, 'backup manifest.objectStorage.provider'),
      bucket: requireIdentifier(objectStorage.bucket, 'backup manifest.objectStorage.bucket'),
      prefix: requireSafePrefix(objectStorage.prefix, 'backup manifest.objectStorage.prefix'),
      recoveryPointId: requireIdentifier(
        objectStorage.recoveryPointId,
        'backup manifest.objectStorage.recoveryPointId',
      ),
      recoveryPointAt: requireTimestamp(objectStorage.recoveryPointAt, 'backup manifest.objectStorage.recoveryPointAt'),
      versioningRetentionSeconds: requirePositiveInteger(
        objectStorage.versioningRetentionSeconds,
        'backup manifest.objectStorage.versioningRetentionSeconds',
      ),
    },
    appSettings: {
      encryptionKeyIds: normalizeKeyIds(appSettings.encryptionKeyIds, 'backup manifest.appSettings.encryptionKeyIds'),
    },
  };
  const newestRecoveryPoint = Math.max(
    Date.parse(normalized.database.recoveryPointAt),
    Date.parse(normalized.objectStorage.recoveryPointAt),
  );
  if (Date.parse(normalized.createdAt) < newestRecoveryPoint) {
    fail('backup manifest.createdAt cannot precede either recovery point');
  }
  return normalized;
}

export function assertManagedRestoreDriverReport(value, { backup, target, startedAt }) {
  const report = assertOnlyKeys(
    value,
    ['formatVersion', 'completedAt', 'database', 'objectStorage', 'encryptionKeyIds'],
    'restore driver report',
  );
  if (report.formatVersion !== MANAGED_RESTORE_DRIVER_REPORT_VERSION) {
    fail(`restore driver report.formatVersion must be ${MANAGED_RESTORE_DRIVER_REPORT_VERSION}`);
  }
  const database = assertOnlyKeys(
    report.database,
    ['recoveryPointId', 'targetId', 'managedWorkflowSchemaVersion'],
    'restore driver report.database',
  );
  const objectStorage = assertOnlyKeys(
    report.objectStorage,
    ['recoveryPointId', 'bucket', 'prefix', 'objectsRestored'],
    'restore driver report.objectStorage',
  );
  const normalized = {
    formatVersion: MANAGED_RESTORE_DRIVER_REPORT_VERSION,
    completedAt: requireTimestamp(report.completedAt, 'restore driver report.completedAt'),
    database: {
      recoveryPointId: requireIdentifier(database.recoveryPointId, 'restore driver report.database.recoveryPointId'),
      targetId: requireIdentifier(database.targetId, 'restore driver report.database.targetId'),
      managedWorkflowSchemaVersion: requirePositiveInteger(
        database.managedWorkflowSchemaVersion,
        'restore driver report.database.managedWorkflowSchemaVersion',
      ),
    },
    objectStorage: {
      recoveryPointId: requireIdentifier(
        objectStorage.recoveryPointId,
        'restore driver report.objectStorage.recoveryPointId',
      ),
      bucket: requireIdentifier(objectStorage.bucket, 'restore driver report.objectStorage.bucket'),
      prefix: requireSafePrefix(objectStorage.prefix, 'restore driver report.objectStorage.prefix'),
      objectsRestored: requirePositiveInteger(
        objectStorage.objectsRestored,
        'restore driver report.objectStorage.objectsRestored',
      ),
    },
    encryptionKeyIds: normalizeKeyIds(report.encryptionKeyIds, 'restore driver report.encryptionKeyIds'),
  };
  if (normalized.database.recoveryPointId !== backup.database.recoveryPointId) {
    fail('restore driver report.database.recoveryPointId does not match the backup manifest');
  }
  if (normalized.database.targetId !== target.databaseId) {
    fail('restore driver report.database.targetId does not match the restore target');
  }
  if (normalized.database.managedWorkflowSchemaVersion !== backup.release.database.managedWorkflowSchema.version) {
    fail('restore driver report.database.managedWorkflowSchemaVersion does not match the backup release manifest');
  }
  if (normalized.objectStorage.recoveryPointId !== backup.objectStorage.recoveryPointId) {
    fail('restore driver report.objectStorage.recoveryPointId does not match the backup manifest');
  }
  if (
    normalized.objectStorage.bucket !== target.objectStorage.bucket ||
    normalized.objectStorage.prefix !== target.objectStorage.prefix
  ) {
    fail('restore driver report.objectStorage does not match the restore target');
  }
  if (!sameStringSet(normalized.encryptionKeyIds, backup.appSettings.encryptionKeyIds)) {
    fail('restore driver report.encryptionKeyIds must exactly match the backup manifest');
  }
  if (Date.parse(normalized.completedAt) < Date.parse(startedAt)) {
    fail('restore driver report.completedAt cannot precede the drill start');
  }
  return normalized;
}

export function assertManagedRestoreIntegrityReport(value) {
  const report = assertOnlyKeys(
    value,
    ['formatVersion', 'checkedAt', 'referencedObjectCount', 'missingReferences', 'orphanObjectCount', 'negativeProbe'],
    'restore integrity report',
  );
  if (report.formatVersion !== MANAGED_RESTORE_INTEGRITY_REPORT_VERSION) {
    fail(`restore integrity report.formatVersion must be ${MANAGED_RESTORE_INTEGRITY_REPORT_VERSION}`);
  }
  if (!Array.isArray(report.missingReferences)) fail('restore integrity report.missingReferences must be an array');
  const missingReferences = report.missingReferences.map((reference, index) =>
    requireIdentifier(reference, `restore integrity report.missingReferences[${index}]`),
  );
  const negativeProbe = assertOnlyKeys(
    report.negativeProbe,
    ['missingReference', 'detected', 'restored'],
    'restore integrity report.negativeProbe',
  );
  const normalized = {
    formatVersion: MANAGED_RESTORE_INTEGRITY_REPORT_VERSION,
    checkedAt: requireTimestamp(report.checkedAt, 'restore integrity report.checkedAt'),
    referencedObjectCount: requirePositiveInteger(
      report.referencedObjectCount,
      'restore integrity report.referencedObjectCount',
    ),
    missingReferences,
    orphanObjectCount: requireNonNegativeInteger(
      report.orphanObjectCount,
      'restore integrity report.orphanObjectCount',
    ),
    negativeProbe: {
      missingReference: requireIdentifier(
        negativeProbe.missingReference,
        'restore integrity report.negativeProbe.missingReference',
      ),
      detected: negativeProbe.detected === true,
      restored: negativeProbe.restored === true,
    },
  };
  if (!normalized.negativeProbe.detected || !normalized.negativeProbe.restored) {
    fail(
      'restore integrity report.negativeProbe must prove that a missing referenced object was detected and restored',
    );
  }
  if (normalized.missingReferences.length > 0) {
    fail(`restore integrity check found missing referenced object(s): ${normalized.missingReferences.join(', ')}`);
  }
  return normalized;
}

export function buildManagedRestoreDrillConfig({ rootDir, env = process.env } = {}) {
  if (!rootDir) fail('rootDir is required');
  if (String(env.RIVET_K8S_RESTORE_DRILL_CONFIRM ?? '') !== 'restore-disposable-target') {
    fail('RIVET_K8S_RESTORE_DRILL_CONFIRM must equal restore-disposable-target');
  }
  const context = requireString(env.RIVET_K8S_RESTORE_DRILL_CONTEXT, 'RIVET_K8S_RESTORE_DRILL_CONTEXT');
  const allowedContext = requireString(
    env.RIVET_K8S_RESTORE_DRILL_ALLOW_CONTEXT,
    'RIVET_K8S_RESTORE_DRILL_ALLOW_CONTEXT',
  );
  if (context !== allowedContext)
    fail('RIVET_K8S_RESTORE_DRILL_CONTEXT and RIVET_K8S_RESTORE_DRILL_ALLOW_CONTEXT must match exactly');
  const configFile = path.resolve(
    requireString(env.RIVET_K8S_RESTORE_DRILL_CONFIG_FILE, 'RIVET_K8S_RESTORE_DRILL_CONFIG_FILE'),
  );
  const configDirectory = path.dirname(configFile);
  const rawConfig = assertOnlyKeys(
    parseJsonFile(configFile, 'RIVET_K8S_RESTORE_DRILL_CONFIG_FILE'),
    ['backup', 'target', 'requestHeaders', 'probes', 'restoreDriver', 'integrityDriver', 'cleanupDriver', 'objectives'],
    'restore drill config',
  );
  const backup = parseManagedRestoreBackupManifest(rawConfig.backup);
  const targetValue = assertOnlyKeys(
    rawConfig.target,
    ['namespace', 'release', 'baseUrl', 'databaseId', 'objectStorage'],
    'restore drill config.target',
  );
  const targetStorage = assertOnlyKeys(
    targetValue.objectStorage,
    ['bucket', 'prefix'],
    'restore drill config.target.objectStorage',
  );
  const target = {
    namespace: requireDnsLabel(targetValue.namespace, 'restore drill config.target.namespace'),
    release: requireDnsLabel(targetValue.release, 'restore drill config.target.release'),
    baseUrl: normalizeHttpsOrigin(targetValue.baseUrl, 'restore drill config.target.baseUrl'),
    databaseId: requireIdentifier(targetValue.databaseId, 'restore drill config.target.databaseId'),
    objectStorage: {
      bucket: requireIdentifier(targetStorage.bucket, 'restore drill config.target.objectStorage.bucket'),
      prefix: requireSafePrefix(targetStorage.prefix, 'restore drill config.target.objectStorage.prefix'),
    },
  };
  if (!restoreNamespacePattern.test(target.namespace)) {
    fail('restore drill config.target.namespace must start with rivet-restore-');
  }
  if (
    target.namespace === backup.source.namespace ||
    new URL(target.baseUrl).hostname === new URL(backup.source.baseUrl).hostname
  ) {
    fail('restore target namespace and HTTPS hostname must differ from the backup source');
  }
  if (target.databaseId.toLowerCase() === backup.database.sourceId.toLowerCase()) {
    fail('restore target databaseId must differ from the backup source database, including letter case');
  }
  if (
    target.objectStorage.bucket.toLowerCase() === backup.objectStorage.bucket.toLowerCase() &&
    target.objectStorage.prefix === backup.objectStorage.prefix
  ) {
    fail(
      'restore target object-storage bucket/prefix must differ from the backup source, including bucket letter case',
    );
  }

  const objectivesValue = assertOnlyKeys(
    rawConfig.objectives,
    ['maximumRpoSeconds', 'maximumRtoSeconds'],
    'restore drill config.objectives',
  );
  const objectives = {
    maximumRpoSeconds: requirePositiveInteger(
      objectivesValue.maximumRpoSeconds,
      'restore drill config.objectives.maximumRpoSeconds',
    ),
    maximumRtoSeconds: requirePositiveInteger(
      objectivesValue.maximumRtoSeconds,
      'restore drill config.objectives.maximumRtoSeconds',
    ),
  };
  if (backup.objectStorage.versioningRetentionSeconds < objectives.maximumRpoSeconds) {
    fail('backup manifest object-storage versioning retention must be at least the configured maximum RPO');
  }

  const requestHeaders =
    rawConfig.requestHeaders === undefined
      ? {}
      : assertObject(rawConfig.requestHeaders, 'restore drill config.requestHeaders');
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value !== 'string' || /\r|\n/u.test(value))
      fail(`restore drill config.requestHeaders.${name} must be a single-line string`);
  }
  const probesValue = assertOnlyKeys(rawConfig.probes, MANAGED_RESTORE_REQUIRED_PROBES, 'restore drill config.probes');
  const missingProbeNames = MANAGED_RESTORE_REQUIRED_PROBES.filter((name) => !Object.hasOwn(probesValue, name));
  if (missingProbeNames.length > 0)
    fail(`restore drill config.probes is missing required probe(s): ${missingProbeNames.join(', ')}`);
  const probes = Object.fromEntries(
    MANAGED_RESTORE_REQUIRED_PROBES.map((name) => [
      name,
      normalizeProbe(probesValue[name], `restore drill config.probes.${name}`),
    ]),
  );
  const valuesFile = assertExistingRegularFile(
    path.resolve(requireString(env.RIVET_K8S_RESTORE_DRILL_VALUES_FILE, 'RIVET_K8S_RESTORE_DRILL_VALUES_FILE')),
    'RIVET_K8S_RESTORE_DRILL_VALUES_FILE',
  );
  const registry = {
    server: optionalString(env.RIVET_K8S_RESTORE_DRILL_REGISTRY_SERVER, 'ghcr.io'),
    username: requireString(env.RIVET_K8S_RESTORE_DRILL_REGISTRY_USERNAME, 'RIVET_K8S_RESTORE_DRILL_REGISTRY_USERNAME'),
    password: requireString(env.RIVET_K8S_RESTORE_DRILL_REGISTRY_PASSWORD, 'RIVET_K8S_RESTORE_DRILL_REGISTRY_PASSWORD'),
    secretName: requireDnsLabel(
      optionalString(env.RIVET_K8S_RESTORE_DRILL_REGISTRY_SECRET_NAME, 'rivet-managed-restore-drill-registry'),
      'RIVET_K8S_RESTORE_DRILL_REGISTRY_SECRET_NAME',
    ),
  };
  return {
    context,
    allowedContext,
    configFile,
    configDirectory,
    valuesFile,
    registry,
    backup,
    target,
    objectives,
    requestHeaders,
    probes,
    restoreDriver: normalizeDriver(
      rawConfig.restoreDriver,
      'restore drill config.restoreDriver',
      configDirectory,
      'restore',
    ),
    integrityDriver: normalizeDriver(
      rawConfig.integrityDriver,
      'restore drill config.integrityDriver',
      configDirectory,
      'integrity',
    ),
    cleanupDriver: normalizeDriver(
      rawConfig.cleanupDriver,
      'restore drill config.cleanupDriver',
      configDirectory,
      'cleanup',
    ),
    artifactsDir: assertArtifactPath(
      rootDir,
      String(env.RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR ?? 'artifacts/kubernetes-managed-restore-drill').trim(),
    ),
  };
}

export function releaseImagesForRestore(release) {
  return Object.fromEntries(
    STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS.map((component) => [
      component,
      {
        repository: release.images[component].repository,
        digest: release.images[component].digest,
        pullPolicy: 'Always',
      },
    ]),
  );
}
