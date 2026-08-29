import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertManagedRestoreDriverReport,
  assertManagedRestoreIntegrityReport,
  buildManagedRestoreDrillConfig,
  parseManagedRestoreBackupManifest,
} from '../../../../deploy/studio-server/scripts/lib/kubernetes-managed-restore-drill-config.mjs';
import {
  assertRestoreDriverManifest,
  createRestoreFailureReport,
  createRestoreProbeRequest,
  getRestoreDriverJobState,
  measureRestoreObjectives,
  parseRestoreDriverJsonMarker,
} from '../../../../deploy/studio-server/scripts/kubernetes-managed-restore-drill.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function releaseManifest() {
  return {
    formatVersion: 1,
    state: 'promoted',
    createdAt: '2026-08-01T00:00:00.000Z',
    source: { repository: 'valerypopoff/rivet2.0', ref: 'main', sha: 'a'.repeat(40) },
    chart: { name: 'rivet', version: '1.0.0', contentDigest: digest('b') },
    database: { managedWorkflowSchema: { version: 2, minimumRollbackCompatibleVersion: 2 } },
    images: {
      proxy: { repository: 'example.test/rivet/proxy', digest: digest('c') },
      web: { repository: 'example.test/rivet/web', digest: digest('d') },
      api: { repository: 'example.test/rivet/api', digest: digest('e') },
      executor: { repository: 'example.test/rivet/executor', digest: digest('f') },
    },
    evidence: {
      candidate: { workflow: 'Build Images', runId: '100', runAttempt: 1 },
      promotion: { workflow: 'Build Images', runId: '100', runAttempt: 1, promotedAt: '2026-08-01T00:05:00.000Z' },
    },
  };
}

function backupManifest() {
  return {
    formatVersion: 1,
    createdAt: '2026-08-01T00:10:00.000Z',
    source: { namespace: 'rivet-production', baseUrl: 'https://rivet.example.test' },
    release: releaseManifest(),
    database: {
      provider: 'provider-postgres',
      sourceId: 'rivet-production-postgres',
      recoveryPointId: 'pg-snapshot-20260801',
      recoveryPointAt: '2026-08-01T00:09:00.000Z',
    },
    objectStorage: {
      provider: 'provider-object-storage',
      bucket: 'rivet-production-artifacts',
      prefix: 'rivet/production',
      recoveryPointId: 'objects-version-20260801',
      recoveryPointAt: '2026-08-01T00:08:00.000Z',
      versioningRetentionSeconds: 172800,
    },
    appSettings: { encryptionKeyIds: ['0123456789abcdef', 'fedcba9876543210'] },
  };
}

function configForDrivers() {
  const probe = (name: string) => ({ path: `/api/restore/${name}`, contains: `${name}-restored` });
  return {
    backup: backupManifest(),
    target: {
      namespace: 'rivet-restore-drill',
      release: 'rivet-restore',
      baseUrl: 'https://rivet-restore.example.test',
      databaseId: 'rivet-restore-postgres',
      objectStorage: { bucket: 'rivet-restores', prefix: 'drills/2026-08-01' },
    },
    requestHeaders: { authorization: 'Bearer protected-test-token' },
    probes: Object.fromEntries(
      ['appSettings', 'oauth', 'project', 'workflow', 'webApp', 'recording', 'evaluation', 'runtimeLibrary'].map(
        (name) => [name, probe(name)],
      ),
    ),
    restoreDriver: { applyFile: 'restore.yaml', jobName: 'restore-driver', timeoutSeconds: 900 },
    integrityDriver: { applyFile: 'integrity.yaml', jobName: 'integrity-driver', timeoutSeconds: 900 },
    cleanupDriver: { applyFile: 'cleanup.yaml', jobName: 'cleanup-driver', timeoutSeconds: 300 },
    objectives: { maximumRpoSeconds: 86400, maximumRtoSeconds: 1800 },
  };
}

function driverYaml(namespace: string, name: string, role: string): string {
  return [
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    '  labels:',
    '    rivet.restore-drill/owned: "true"',
    `    rivet.restore-drill/role: ${role}`,
    'spec:',
    '  backoffLimit: 0',
    '  template:',
    '    spec:',
    '      restartPolicy: Never',
    '      containers:',
    `        - { name: ${role}, image: example.test/restore-driver@${digest('a')} }`,
    '',
  ].join('\n');
}

function environment(configFile: string, valuesFile: string, overrides: Record<string, string> = {}) {
  return {
    RIVET_K8S_RESTORE_DRILL_CONFIRM: 'restore-disposable-target',
    RIVET_K8S_RESTORE_DRILL_CONTEXT: 'provider-staging',
    RIVET_K8S_RESTORE_DRILL_ALLOW_CONTEXT: 'provider-staging',
    RIVET_K8S_RESTORE_DRILL_CONFIG_FILE: configFile,
    RIVET_K8S_RESTORE_DRILL_VALUES_FILE: valuesFile,
    RIVET_K8S_RESTORE_DRILL_REGISTRY_USERNAME: 'restore-drill',
    RIVET_K8S_RESTORE_DRILL_REGISTRY_PASSWORD: 'restore-drill-token',
    ...overrides,
  };
}

test('managed restore drill requires a non-secret backup manifest, fresh target, every durable-surface probe, and bounded RPO/RTO', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-restore-drill-test-'));
  const configFile = path.join(directory, 'restore-drill.json');
  const valuesFile = path.join(directory, 'values.yaml');
  const config = configForDrivers();
  try {
    await Promise.all([
      fs.writeFile(configFile, JSON.stringify(config)),
      fs.writeFile(valuesFile, 'vault:\n  enabled: true\n'),
      fs.writeFile(
        path.join(directory, 'restore.yaml'),
        driverYaml('rivet-restore-drill', 'restore-driver', 'restore'),
      ),
      fs.writeFile(
        path.join(directory, 'integrity.yaml'),
        driverYaml('rivet-restore-drill', 'integrity-driver', 'integrity'),
      ),
      fs.writeFile(
        path.join(directory, 'cleanup.yaml'),
        driverYaml('rivet-restore-drill', 'cleanup-driver', 'cleanup'),
      ),
    ]);
    const parsed = buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) });
    assert.equal(parsed.target.namespace, 'rivet-restore-drill');
    assert.equal(parsed.backup.release.state, 'promoted');
    assert.deepEqual(parsed.backup.appSettings.encryptionKeyIds, ['0123456789abcdef', 'fedcba9876543210']);
    assert.equal(parsed.probes.runtimeLibrary.contains, 'runtimeLibrary-restored');

    await fs.writeFile(
      configFile,
      JSON.stringify({ ...config, target: { ...config.target, baseUrl: 'https://rivet.example.test:8443' } }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /HTTPS hostname must differ/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({ ...config, target: { ...config.target, baseUrl: 'https://rivet.example.test.' } }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /HTTPS hostname must differ/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({ ...config, target: { ...config.target, baseUrl: 'https://[::1]' } }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /must use a non-local HTTPS DNS hostname/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        target: { ...config.target, databaseId: config.backup.database.sourceId.toUpperCase() },
      }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /databaseId must differ.*letter case/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        target: {
          ...config.target,
          objectStorage: {
            bucket: config.backup.objectStorage.bucket.toUpperCase(),
            prefix: config.backup.objectStorage.prefix,
          },
        },
      }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /bucket\/prefix must differ.*letter case/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({ ...config, target: { ...config.target, namespace: 'rivet-production' } }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /must start with rivet-restore-/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        backup: { ...config.backup, database: { ...config.backup.database, password: 'not-allowed' } },
      }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /unsupported field\(s\): password/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        backup: { ...config.backup, objectStorage: { ...config.backup.objectStorage, versioningRetentionSeconds: 60 } },
      }),
    );
    assert.throws(
      () => buildManagedRestoreDrillConfig({ rootDir, env: environment(configFile, valuesFile) }),
      /versioning retention must be at least the configured maximum RPO/,
    );
    await fs.writeFile(configFile, JSON.stringify(config));
    assert.throws(
      () =>
        buildManagedRestoreDrillConfig({
          rootDir,
          env: environment(configFile, valuesFile, { RIVET_K8S_RESTORE_DRILL_ARTIFACTS_DIR: '..' }),
        }),
      /ARTIFACTS_DIR must remain inside the repository/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('managed restore drill requires recovery points, schema, target identities, and encryption-key identifiers to match', () => {
  const backup = parseManagedRestoreBackupManifest(backupManifest());
  const target = {
    databaseId: 'rivet-restore-postgres',
    objectStorage: { bucket: 'rivet-restores', prefix: 'drills/2026-08-01' },
  };
  const driverReport = assertManagedRestoreDriverReport(
    {
      formatVersion: 1,
      completedAt: '2026-08-01T00:20:00.000Z',
      database: {
        recoveryPointId: 'pg-snapshot-20260801',
        targetId: 'rivet-restore-postgres',
        managedWorkflowSchemaVersion: 2,
      },
      objectStorage: {
        recoveryPointId: 'objects-version-20260801',
        bucket: 'rivet-restores',
        prefix: 'drills/2026-08-01',
        objectsRestored: 42,
      },
      encryptionKeyIds: ['fedcba9876543210', '0123456789abcdef'],
    },
    { backup, target, startedAt: '2026-08-01T00:11:00.000Z' },
  ) as { objectStorage: { objectsRestored: number } };
  assert.equal(driverReport.objectStorage.objectsRestored, 42);
  assert.throws(
    () =>
      assertManagedRestoreDriverReport(
        {
          formatVersion: 1,
          completedAt: '2026-08-01T00:20:00.000Z',
          database: { recoveryPointId: 'wrong', targetId: 'rivet-restore-postgres', managedWorkflowSchemaVersion: 2 },
          objectStorage: {
            recoveryPointId: 'objects-version-20260801',
            bucket: 'rivet-restores',
            prefix: 'drills/2026-08-01',
            objectsRestored: 42,
          },
          encryptionKeyIds: ['0123456789abcdef', 'fedcba9876543210'],
        },
        { backup, target, startedAt: '2026-08-01T00:11:00.000Z' },
      ),
    /recoveryPointId does not match/,
  );
  assert.throws(
    () =>
      assertManagedRestoreDriverReport(
        {
          formatVersion: 1,
          completedAt: '2026-08-01T00:20:00.000Z',
          database: {
            recoveryPointId: 'pg-snapshot-20260801',
            targetId: 'rivet-restore-postgres',
            managedWorkflowSchemaVersion: 2,
          },
          objectStorage: {
            recoveryPointId: 'objects-version-20260801',
            bucket: 'rivet-restores',
            prefix: 'drills/2026-08-01',
            objectsRestored: 0,
          },
          encryptionKeyIds: ['0123456789abcdef', 'fedcba9876543210'],
        },
        { backup, target, startedAt: '2026-08-01T00:11:00.000Z' },
      ),
    /objectsRestored must be a positive integer/,
  );
});

test('managed restore drill fails missing referenced objects precisely and requires a successful negative probe', () => {
  const complete = assertManagedRestoreIntegrityReport({
    formatVersion: 1,
    checkedAt: '2026-08-01T00:22:00.000Z',
    referencedObjectCount: 42,
    missingReferences: [],
    orphanObjectCount: 3,
    negativeProbe: { missingReference: 'workflow-revisions/project-1/revision-1.json', detected: true, restored: true },
  }) as { orphanObjectCount: number };
  assert.equal(complete.orphanObjectCount, 3);
  assert.throws(
    () =>
      assertManagedRestoreIntegrityReport({
        formatVersion: 1,
        checkedAt: '2026-08-01T00:22:00.000Z',
        referencedObjectCount: 42,
        missingReferences: ['workflow-revisions/project-1/revision-1.json'],
        orphanObjectCount: 0,
        negativeProbe: {
          missingReference: 'workflow-revisions/project-1/revision-1.json',
          detected: true,
          restored: true,
        },
      }),
    /missing referenced object\(s\): workflow-revisions\/project-1\/revision-1\.json/,
  );
  assert.throws(
    () =>
      assertManagedRestoreIntegrityReport({
        formatVersion: 1,
        checkedAt: '2026-08-01T00:22:00.000Z',
        referencedObjectCount: 42,
        missingReferences: [],
        orphanObjectCount: 0,
        negativeProbe: {
          missingReference: 'workflow-revisions/project-1/revision-1.json',
          detected: true,
          restored: false,
        },
      }),
    /must prove that a missing referenced object was detected and restored/,
  );
  assert.throws(
    () =>
      assertManagedRestoreIntegrityReport({
        formatVersion: 1,
        checkedAt: '2026-08-01T00:22:00.000Z',
        referencedObjectCount: 0,
        missingReferences: [],
        orphanObjectCount: 0,
        negativeProbe: {
          missingReference: 'workflow-revisions/project-1/revision-1.json',
          detected: true,
          restored: true,
        },
      }),
    /referencedObjectCount must be a positive integer/,
  );
});

test('managed restore drill validates an owned single-attempt Job and measures the conservative cross-store RPO/RTO', () => {
  const driver = { role: 'restore' as const, jobName: 'restore-driver' };
  assertRestoreDriverManifest(
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        namespace: 'rivet-restore-drill',
        name: 'restore-driver',
        labels: { 'rivet.restore-drill/owned': 'true', 'rivet.restore-drill/role': 'restore' },
      },
      spec: { backoffLimit: 0, template: { spec: { restartPolicy: 'Never' } } },
    },
    { namespace: 'rivet-restore-drill', driver },
  );
  assert.throws(
    () =>
      assertRestoreDriverManifest(
        { kind: 'Job', metadata: { namespace: 'rivet-restore-drill', name: 'restore-driver' }, spec: {} },
        { namespace: 'rivet-restore-drill', driver },
      ),
    /backoffLimit 0 and restartPolicy Never/,
  );
  const probeRequest = createRestoreProbeRequest({
    baseUrl: 'https://rivet-restore.example.test',
    requestHeaders: { authorization: 'Bearer protected-test-token' },
    probe: { path: '/api/restore/project', method: 'POST', body: { id: 'fixture' } },
  });
  assert.equal(probeRequest.url.href, 'https://rivet-restore.example.test/api/restore/project');
  assert.equal(probeRequest.init.redirect, 'error');
  assert.equal((probeRequest.init.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(probeRequest.init.body as string), { id: 'fixture' });
  assert.deepEqual(getRestoreDriverJobState({ status: { succeeded: 1 } }), { state: 'completed' });
  assert.deepEqual(
    getRestoreDriverJobState({
      status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] },
    }),
    { state: 'failed', reason: 'BackoffLimitExceeded' },
  );
  assert.deepEqual(getRestoreDriverJobState({ status: { active: 1 } }), { state: 'running' });
  const failureReport = createRestoreFailureReport({
    startedAt: '2026-08-01T00:10:00.000Z',
    failedAt: '2026-08-01T00:12:00.000Z',
    failureStage: 'restore provider backup',
    target: configForDrivers().target,
  });
  assert.equal(failureReport.status, 'failed');
  assert.equal(failureReport.failureStage, 'restore provider backup');
  assert.doesNotMatch(JSON.stringify(failureReport), /provider-password|raw-command-output/);
  assert.deepEqual(
    parseRestoreDriverJsonMarker(
      'info\nRIVET_RESTORE_DRIVER_REPORT={"ok":true}\n',
      'RIVET_RESTORE_DRIVER_REPORT=',
      'restore',
    ),
    { ok: true },
  );
  assert.deepEqual(
    measureRestoreObjectives({
      startedAtMs: Date.parse('2026-08-01T00:20:00.000Z'),
      completedAtMs: Date.parse('2026-08-01T00:24:01.000Z'),
      databaseRecoveryPointAt: '2026-08-01T00:10:00.000Z',
      objectStorageRecoveryPointAt: '2026-08-01T00:08:00.000Z',
    }),
    { achievedRpoSeconds: 720, achievedRtoSeconds: 241 },
  );
});
