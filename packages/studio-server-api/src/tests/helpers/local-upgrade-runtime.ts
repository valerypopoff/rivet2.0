import assert from 'node:assert/strict';
import { mock } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';
import {
  initializeLocalMetadataServing,
  assertLocalMetadataWritesAllowed,
  withLocalMetadataControl,
  localMetadataSourceRoots,
} from '../../local-metadata/runtime-control.js';
import { getLocalMetadataServingSelection } from '../../local-metadata/serving-selection.js';
import { initializeLocalRuntimeLibraryAuthority } from '../../local-metadata/runtime-library-authority.js';
import {
  getLocalUpgradeStatus,
  getLocalUpgradeSetupStatus,
  getLocalUpgradeReport,
  inspectLocalUpgradeSource,
  pauseLocalUpgradeSource,
  startLocalUpgradeCopy,
  startLocalUpgradeBrowserBackup,
  transitionLocalUpgrade,
} from '../../local-metadata/operator-service.js';
import {
  initializeAppSettingsRepositories,
  disposeAppSettingsRepositories,
  getAppSettingsBackendKind,
} from '../../app-settings/settings-repository.js';
import {
  initializeWorkflowStorage,
  disposeWorkflowStorage,
  loadHostedProject,
  saveHostedProject,
} from '../../routes/workflows/storage-backend.js';
import { fingerprintVmMigrationSource } from '../../scripts/vm-migration-source-manifest.js';
import { createLocalCatalogNativeApi } from '../../local-metadata/execution-io.js';
import { readManifest, getRootPath } from '../../runtime-libraries/manifest.js';
import { localCatalogExecutorIoRouter } from '../../local-metadata/executor-io-route.js';
import { getExpectedExecutorAuthToken, getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../../auth.js';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { runtimeTestEntry, runtimeTestRepo as repo } from './runtime-test-entry.js';
import { allocateDistinctTestPorts, listenTestServer } from './http-server-harness.js';
import { isVmMigrationMaintenanceActive } from '../../vm-migration-maintenance.js';
import { enableWorkflowRecordingMigrationCopyMode } from '../../routes/workflows/recordings.js';
import { initializeRuntimeLibrariesBackend } from '../../runtime-libraries/backend.js';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemRivetLLMProfileHealthStore } from '../../llm-profile-health/filesystem-store.js';
import { format } from 'node:util';

const command = process.argv[2];
const { assertLocalMetadataExecutorAdmission } = (await import(
  pathToFileURL(path.join(repo, 'packages/app-executor/bin/localMetadataAdmission.mts')).href
)) as typeof import('../../../../app-executor/bin/localMetadataAdmission.mjs');
const faultHooks = {
  checkpoint: async (checkpoint: string) => {
    if (checkpoint !== process.env.REHEARSAL_FAULT_POINT) return;
    if (process.env.REHEARSAL_FAULT_MODE === 'kill') process.kill(process.pid, 'SIGKILL');
    throw Object.assign(new Error('secret-fixture-error: password=never-persist-error-content'), {
      code: process.env.REHEARSAL_FAULT_MODE,
    });
  },
};
if (command === 'ui-workflow') {
  await import('./local-upgrade-ui-runtime.js');
  console.log('rehearsal:ui-workflow:ok');
  process.exit(0);
} else if (command === 'supervised') {
  // Actual container-runtime processes, not a stub health responder. All
  // authoritative paths and executor app-data belong to this temporary fixture.
  const { startBackendSupervisor } = await import(
    pathToFileURL(path.join(repo, 'deploy/studio-server/images/api/backend-supervisor.mjs')).href
  );
  const [apiPort, executorPort, healthPort] = await allocateDistinctTestPorts(3);
  const supervisor = await startBackendSupervisor({
    env: {
      ...process.env,
      RIVET_BACKEND_API_PORT: String(apiPort),
      RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
      RIVET_BACKEND_HEALTH_PORT: String(healthPort),
      RIVET_EXECUTOR_RUNTIME_CONFIG_URL: '',
      RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    },
    apiCommand: [
      process.execPath,
      '--import',
      path.join(repo, 'packages/studio-server-bootstrap/bootstrap.mjs'),
      ...runtimeTestEntry('server.js'),
    ],
    executorCommand: [
      process.execPath,
      '--import',
      path.join(repo, 'packages/studio-server-bootstrap/bootstrap.mjs'),
      path.join(repo, 'packages/studio-server-executor/dist/executor-bundle.cjs'),
    ],
    executorCwd: repo,
    executorEnvOverrides: {
      RIVET_APP_DATA_ROOT: path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'test-executor-cache'),
    },
    apiStartupTimeoutMs: 45_000,
    shutdownTimeoutMs: 10_000,
  });
  try {
    const deadline = Date.now() + 50_000;
    let ready = false;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        ready = (await fetch(`http://127.0.0.1:${healthPort}/readyz`)).ok;
      } catch {
        /* Starting. */
      }
    } while (!ready && Date.now() < deadline);
    assert.equal(ready, true, 'Real API and executor must agree on selected SQLite startup.');
    const response = await fetch(`http://127.0.0.1:${apiPort}/internal/executor-runtime-config`, {
      headers: {
        'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
        'x-rivet-executor-auth': getExpectedExecutorAuthToken(),
      },
    });
    assert.equal(response.status, 200);
    const config = (await response.json()) as { protocolVersion: number; generationId: string };
    assert.equal(config.protocolVersion, 2);
    assert.ok(config.generationId);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${apiPort}/api/workflows/tree`, {
          headers: {
            'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
            cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
          },
        })
      ).status,
      200,
      'Paused real startup permits read-only tree browsing for downloads.',
    );
  } finally {
    await supervisor.stop(0);
    await supervisor.completed;
  }
  console.log('rehearsal:supervised:ok');
  process.exit(0);
}
const state = await withLocalMetadataControl(async (journal) => journal.read(), true);
process.env.RIVET_LOCAL_METADATA_BOOT_REVISION = String(state.revision);
process.env.RIVET_LOCAL_METADATA_BOOT_GENERATION = state.backend === 'sqlite' ? state.generation!.id : '';
await initializeLocalMetadataServing();
await initializeAppSettingsRepositories();
if (isVmMigrationMaintenanceActive()) enableWorkflowRecordingMigrationCopyMode();
let disposeLibraries: (() => void) | undefined;
let health: Awaited<ReturnType<typeof listenTestServer>> | undefined;
try {
  const selected = getLocalMetadataServingSelection();
  if (selected)
    disposeLibraries = await initializeLocalRuntimeLibraryAuthority(selected, assertLocalMetadataWritesAllowed);
  if (command === 'setup-status') {
    const { createApiApp } = await import('../../app.js');
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    const original = {
      enabled: process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED,
      root: process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT,
      key: process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY,
      topology: process.env.RIVET_DEPLOYMENT_TOPOLOGY,
      prepare: process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE,
      restart: process.env.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE,
      token: process.env.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN,
    };
    const setupUrl = `${listener.baseUrl}/api/app-settings/local-upgrade/setup`;
    const headers = {
      'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
      cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
    };
    try {
      process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED = '0';
      process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = '';
      process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY = '';
      process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = '0';
      process.env.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE = '0';
      process.env.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN = 'private-setup-fixture-capability';
      const response = await fetch(setupUrl, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        eligible: true,
        upgradeEnabled: true,
        controlRootConfigured: false,
        encryptionKeyReady: true,
        sqliteSelected: false,
        liveSqlite: false,
        uiPreparationAvailable: false,
        uiRestartAvailable: false,
      });
      // Keep an exact public contract: paths, encryption keys and the private
      // supervisor token must never become part of this onboarding response.
      for (const [prepare, restart] of [
        ['1', '0'],
        ['0', '1'],
        ['1', '1'],
      ]) {
        process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = prepare;
        process.env.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE = restart;
        const capable = await fetch(setupUrl, { headers });
        assert.equal(capable.status, 200);
        assert.deepEqual(await capable.json(), {
          eligible: true,
          upgradeEnabled: true,
          controlRootConfigured: false,
          encryptionKeyReady: true,
          sqliteSelected: false,
          liveSqlite: false,
          uiPreparationAvailable: prepare === '1',
          uiRestartAvailable: restart === '1',
        });
      }
      assert.equal(
        (await fetch(setupUrl, { headers: { 'x-rivet-proxy-auth': headers['x-rivet-proxy-auth'] } })).status,
        403,
      );
      const unprepared = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade`, { headers });
      assert.equal(unprepared.status, 200);
      assert.equal((await unprepared.json()).available, false);

      process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED = '1';
      process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = original.root;
      process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY = original.key;
      process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = '0';
      process.env.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE = '0';
      const ready = await fetch(setupUrl, { headers });
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
        eligible: true,
        upgradeEnabled: true,
        controlRootConfigured: true,
        encryptionKeyReady: true,
        sqliteSelected: false,
        liveSqlite: false,
        uiPreparationAvailable: false,
        uiRestartAvailable: false,
      });
      process.env.RIVET_DEPLOYMENT_TOPOLOGY = 'replicated';
      assert.equal(((await (await fetch(setupUrl, { headers })).json()) as { eligible: boolean }).eligible, false);
    } finally {
      for (const [name, value] of [
        ['RIVET_LOCAL_METADATA_UPGRADE_ENABLED', original.enabled],
        ['RIVET_LOCAL_METADATA_CONTROL_ROOT', original.root],
        ['RIVET_LOCAL_METADATA_ENCRYPTION_KEY', original.key],
        ['RIVET_DEPLOYMENT_TOPOLOGY', original.topology],
        ['RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE', original.prepare],
        ['RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE', original.restart],
        ['RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN', original.token],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await listener.close();
    }
  } else if (command === 'inspect-capacity') {
    const inspected = await inspectLocalUpgradeSource();
    assert.equal(inspected.capacity.fits, false);
    assert.ok(inspected.capacity.reasons.includes('payload-budget'));
    assert.equal(inspected.inventory, null, 'Oversized project bytes must not reach the aggregate inventory parser.');
    assert.equal(isVmMigrationMaintenanceActive(), false);
    assert.equal((await getLocalUpgradeStatus()).job, null);
  } else if (command === 'copy-capacity-refusal') {
    await initializeAppSettingsRepositories();
    await pauseLocalUpgradeSource();
    const source = localMetadataSourceRoots();
    const fingerprint = await fingerprintVmMigrationSource(source);
    const before = await getLocalUpgradeStatus();
    const { createApiApp } = await import('../../app.js');
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    const disk = await fs.statfs(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!);
    let releaseCapacity!: () => void, capacityArrived!: () => void;
    const capacityHeld = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    const capacityReached = new Promise<void>((resolve) => {
      capacityArrived = resolve;
    });
    const statfs = mock.method(fs, 'statfs', async () => {
      capacityArrived();
      await capacityHeld;
      return { ...disk, bavail: 0, bfree: 0 };
    });
    try {
      const response = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade/copy`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
          'Content-Type': 'application/json',
          'X-Rivet-Migration-Intent': '1',
          Origin: listener.baseUrl,
        },
        body: JSON.stringify({
          revision: before.transition!.revision,
          backupReference: 'fixture-restored-backup',
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
          encryptionKeyBackedUp: true,
        }),
      });
      assert.equal(response.status, 202);
      await response.json();
      await capacityReached;
      const preparing = await getLocalUpgradeStatus();
      assert.equal(preparing.operation, 'copy');
      assert.equal(preparing.job?.phase, 'copying');
      assert.equal(preparing.job?.stage, 'capacity');
      await assert.rejects(
        startLocalUpgradeCopy({
          revision: before.transition!.revision,
          backupReference: 'fixture-restored-backup',
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
          encryptionKeyBackedUp: true,
        }),
        { status: 409, code: 'local-upgrade-busy' },
      );
      releaseCapacity();
      const deadline = Date.now() + 10_000;
      let after;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        after = await getLocalUpgradeStatus();
      } while (after.operation && Date.now() < deadline);
      assert.equal(after.job?.phase, 'failed');
      assert.equal(after.job?.stage, 'capacity');
      assert.equal(after.job?.failure?.reason, 'capacity-refused');
      for (const privateValue of [...Object.values(source), 'never-return-this-secret'])
        assert.equal(JSON.stringify(after.job).includes(privateValue), false);
      assert.equal(after.operation, null);
      assert.deepEqual(after.transition, before.transition);
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      assert.equal(isVmMigrationMaintenanceActive(), true);
      await assert.rejects(fs.stat(path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'generations')), {
        code: 'ENOENT',
      });
    } finally {
      releaseCapacity();
      statfs.mock.restore();
      await listener.close();
    }
  } else if (command === 'copy-fingerprint-mismatch' || command === 'copy-source-diagnostic') {
    await pauseLocalUpgradeSource();
    const source = localMetadataSourceRoots();
    const fingerprint = await fingerprintVmMigrationSource(source);
    const input = {
      revision: state.revision,
      backupReference: 'fixture-restored-copy',
      backupSourceFingerprint: command === 'copy-fingerprint-mismatch' ? '0'.repeat(64) : fingerprint,
      backupRestored: true,
      encryptionKeyBackedUp: true,
    };
    const logs: string[] = [];
    const warning = mock.method(console, 'warn', (...values: unknown[]) => {
      logs.push(format(...values));
    });
    const waitForTerminal = async () => {
      const deadline = Date.now() + 15_000;
      let status;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await getLocalUpgradeStatus();
      } while (status.operation && Date.now() < deadline);
      assert.equal(status.operation, null);
      assert.equal(status.job?.phase, 'failed', JSON.stringify(status));
      return status;
    };
    try {
      await startLocalUpgradeCopy(input);
      const failed = await waitForTerminal();
      assert.equal(failed.job?.stage, command === 'copy-fingerprint-mismatch' ? 'source-fingerprint' : 'workflows');
      assert.equal(
        failed.job?.failure?.reason,
        command === 'copy-fingerprint-mismatch' ? 'source-fingerprint-mismatch' : 'project-parse-failed',
      );
      assert.equal(failed.transition?.generationId, null);
      assert.equal(failed.runningBackend, 'legacy');
      assert.equal(isVmMigrationMaintenanceActive(), true);
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      assert.equal(JSON.stringify(await getLocalUpgradeReport()).includes('private-malformed-fixture'), false);
      assert.equal(logs.join('\n').includes('private-malformed-fixture'), false);
      if (command === 'copy-fingerprint-mismatch') {
        await assert.rejects(fs.stat(path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'generations')), {
          code: 'ENOENT',
        });
      } else {
        await startLocalUpgradeCopy({ ...input, retryJobId: failed.job!.id });
        const retried = await waitForTerminal();
        assert.equal(retried.job?.id, failed.job!.id);
        assert.deepEqual(retried.job?.failure, failed.job!.failure);
        const { createApiApp } = await import('../../app.js');
        const listener = await listenTestServer(http.createServer(createApiApp('combined')));
        const headers = {
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
        };
        try {
          const url = `${listener.baseUrl}/api/app-settings/local-upgrade/project-reference?reference=${failed.job!.failure!.sourceReference}`;
          const response = await fetch(url, { headers });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.deepEqual((await response.json()).paths, ['invalid.rivet-project']);
          assert.equal((await fetch(url)).status, 403);
        } finally {
          await listener.close();
        }
      }
    } finally {
      warning.mock.restore();
    }
  } else if (command === 'inspect-error-redacted') {
    const { createApiApp } = await import('../../app.js');
    await initializeAppSettingsRepositories();
    const logs: string[] = [];
    const originalLog = console.error;
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    try {
      console.error = (...values) => logs.push(format(...values));
      const response = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade/inventory`, {
        headers: {
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
        },
      });
      assert.equal(response.status, 500);
      assert.equal((await response.text()).includes('LEAKME42'), false);
      assert.ok(logs.length > 0, 'A fixed failure code and correlation ID must remain available.');
      assert.equal(
        logs.join('\n').includes('LEAKME42'),
        false,
        'Parser snippets must not expose source values in logs.',
      );
      assert.match(logs.join('\n'), /invalid-data/);
      assert.equal((await getLocalUpgradeStatus()).job, null);
      assert.equal(isVmMigrationMaintenanceActive(), false);
    } finally {
      console.error = originalLog;
      await listener.close();
    }
  } else if (command === 'browser-backup') {
    await initializeWorkflowStorage();
    const { createReviewedBackendPublicationFixtures } = await import('./reviewed-publication.js');
    const reviewed = createReviewedBackendPublicationFixtures(
      await import('../../routes/workflows/storage-backend.js'),
    );
    await reviewed.publishWorkflowProjectItemWithBackend('story.rivet-project', {
      endpointName: 'browser-backup-fixture',
    });
    const history = await reviewed.listWorkflowPublishedVersionsWithBackend('story.rivet-project');
    // Force a cold tree projection after freezing; it must not write a cache.
    const source = localMetadataSourceRoots();
    const statsPath = path.join(source.workflows, 'story.rivet-project.wrapper-stats.json');
    await fs.rm(statsPath, { force: true });
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(source);
    const original = await fs.readFile(path.join(source.workflows, 'story.rivet-project'), 'utf8');
    const { createApiApp } = await import('../../app.js');
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    const headers = {
      'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
      cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
    };
    const mutationHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'X-Rivet-Migration-Intent': '1',
      Origin: listener.baseUrl,
    };
    const url = `${listener.baseUrl}/api/app-settings/local-upgrade`;
    try {
      assert.equal((await fetch(`${listener.baseUrl}/api/workflows/tree`, { headers })).status, 200);
      await assert.rejects(fs.stat(statsPath), { code: 'ENOENT' });
      assert.equal(
        await fetch(`${listener.baseUrl}/api/workflows/projects/download`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ relativePath: 'story.rivet-project', version: 'live' }),
        }).then(async (response) => {
          assert.equal(response.status, 200);
          return response.text();
        }),
        original,
      );
      const versions = await fetch(
        `${listener.baseUrl}/api/workflows/projects/published-versions?relativePath=story.rivet-project`,
        { headers },
      );
      assert.equal(versions.status, 200);
      assert.deepEqual(await versions.json(), history);
      for (const [endpoint, body] of [
        ['projects/download', { relativePath: 'story.rivet-project', version: 'published' }],
        [
          'projects/published-versions/download',
          { relativePath: 'story.rivet-project', versionId: history.versions[0]!.id },
        ],
      ] as const) {
        const response = await fetch(`${listener.baseUrl}/api/workflows/${endpoint}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), original);
      }
      assert.equal((await fetch(`${listener.baseUrl}/workflows/browser-backup-fixture`, { headers })).status, 503);
      assert.equal(
        (
          await fetch(`${listener.baseUrl}/api/workflows/projects/upload`, {
            method: 'POST',
            headers: mutationHeaders,
            body: '{}',
          })
        ).status,
        503,
      );
      assert.equal(
        (
          await fetch(`${url}/backup`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ revision: state.revision }),
          })
        ).status,
        403,
      );
      const backupStatePath = path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'browser-backup.json');
      await fs.writeFile(backupStatePath, '{corrupt optional backup status');
      const damagedStatusResponse = await fetch(url, { headers });
      assert.equal(damagedStatusResponse.status, 200);
      const damagedStatus = await damagedStatusResponse.json();
      assert.equal(damagedStatus.available, true);
      assert.equal(damagedStatus.backup, null);
      assert.equal(damagedStatus.backupStatusUnreadable, true);
      assert.equal(damagedStatus.transition.phase, 'legacy');
      // Model a process restart with durable creating state and partial output.
      const interruptedId = randomUUID();
      const interruptedDirectory = path.join(
        process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!,
        'browser-backups',
        interruptedId,
      );
      await fs.mkdir(interruptedDirectory, { recursive: true });
      await fs.writeFile(path.join(interruptedDirectory, 'backup.tar.gz'), 'partial fixture');
      await fs.writeFile(
        backupStatePath,
        JSON.stringify({
          id: interruptedId,
          revision: state.revision,
          pausedAt: damagedStatus.maintenance.enteredAt,
          phase: 'creating',
          sourceFingerprint: fingerprint,
          archiveHash: null,
          bytes: 0,
          createdAt: new Date().toISOString(),
        }),
      );
      const interrupted = await getLocalUpgradeStatus();
      assert.equal(interrupted.operation, null);
      assert.equal(interrupted.backup?.phase, 'interrupted');
      assert.equal((await fetch(`${url}/backup/download?id=${interruptedId}`, { headers })).status, 409);
      assert.equal(
        (
          await fetch(`${url}/backup`, {
            method: 'POST',
            headers: mutationHeaders,
            body: JSON.stringify({ revision: state.revision }),
          })
        ).status,
        202,
      );
      const deadline = Date.now() + 30_000;
      let status;
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = await getLocalUpgradeStatus();
      } while (status.operation && Date.now() < deadline);
      assert.equal(status.backup?.phase, 'ready', JSON.stringify(status));
      assert.equal(status.backupStatusUnreadable, false);
      assert.equal(status.backup?.sourceFingerprint, fingerprint);
      assert.equal(JSON.stringify(status).includes(process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY!), false);
      const id = status.backup!.id;
      assert.notEqual(id, interruptedId);
      assert.equal(await fs.readFile(path.join(interruptedDirectory, 'backup.tar.gz'), 'utf8'), 'partial fixture');
      assert.equal(
        (
          await fetch(`${url}/backup/download?id=${id}`, {
            headers: { 'x-rivet-proxy-auth': headers['x-rivet-proxy-auth'] },
          })
        ).status,
        403,
      );
      const forbiddenHeaders: Record<string, string>[] = [
        { 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Site': 'same-site' },
        { Origin: 'https://another-host.invalid' },
        { Origin: 'not an origin' },
      ];
      for (const endpoint of ['key', 'download']) {
        for (const forbidden of forbiddenHeaders)
          assert.equal(
            (await fetch(`${url}/backup/${endpoint}?id=${id}`, { headers: { ...headers, ...forbidden } })).status,
            403,
          );
      }
      const download = await fetch(`${url}/backup/download?id=${id}`, { headers });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition')!, /attachment/);
      assert.equal(download.headers.get('cache-control'), 'no-store');
      const archive = Buffer.from(await download.arrayBuffer());
      assert.equal(createHash('sha256').update(archive).digest('hex'), status.backup!.archiveHash);
      const keyDownload = await fetch(`${url}/backup/key?id=${id}`, { headers });
      assert.equal(keyDownload.status, 200);
      assert.equal(keyDownload.headers.get('cache-control'), 'no-store');
      assert.match(keyDownload.headers.get('content-disposition')!, /attachment/);
      assert.equal(await keyDownload.text(), process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY);
      assert.equal(
        await fingerprintVmMigrationSource(source),
        fingerprint,
        'Tree, exports and backup cannot alter frozen files.',
      );
      await assert.rejects(
        startLocalUpgradeCopy({
          revision: state.revision,
          backupReference: `browser-backup:${id}:${'0'.repeat(64)}`,
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
          encryptionKeyBackedUp: true,
        }),
        /stale or unverified/,
      );
      const validBackupStatus = await fs.readFile(backupStatePath, 'utf8');
      await fs.writeFile(backupStatePath, '{corrupt optional backup status');
      assert.equal((await getLocalUpgradeStatus()).backupStatusUnreadable, true);
      await assert.rejects(
        startLocalUpgradeCopy({
          revision: state.revision,
          backupReference: `browser-backup:${id}:${status.backup!.archiveHash}`,
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
          encryptionKeyBackedUp: true,
        }),
      );
      assert.equal((await getLocalUpgradeStatus()).job, null);
      await fs.writeFile(
        backupStatePath,
        JSON.stringify({ ...JSON.parse(validBackupStatus), pausedAt: 'a different maintenance session' }),
      );
      await assert.rejects(
        startLocalUpgradeCopy({
          revision: state.revision,
          backupReference: `browser-backup:${id}:${status.backup!.archiveHash}`,
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
          encryptionKeyBackedUp: true,
        }),
        /stale or unverified/,
      );
      await fs.writeFile(backupStatePath, validBackupStatus);
      const copyInput = {
        revision: state.revision,
        backupReference: `browser-backup:${id}:${status.backup!.archiveHash}`,
        backupSourceFingerprint: fingerprint,
        backupRestored: true,
        encryptionKeyBackedUp: true,
      };
      const archivePath = path.join(
        process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!,
        'browser-backups',
        id,
        'backup.tar.gz',
      );
      await fs.appendFile(archivePath, 'tampered before copy');
      await startLocalUpgradeCopy(copyInput);
      const failureDeadline = Date.now() + 30_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = await getLocalUpgradeStatus();
      } while (status.operation && Date.now() < failureDeadline);
      assert.equal(status.job?.phase, 'failed', JSON.stringify(status));
      assert.equal(status.job?.failure?.reason, 'backup-archive-mismatch');
      assert.equal(status.job?.stage, 'backup-verification');
      assert.equal(status.transition?.generationId, null);
      await assert.rejects(fs.stat(path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'generations')), {
        code: 'ENOENT',
      });
      const failedJobId = status.job!.id;
      await fs.writeFile(archivePath, archive);
      await startLocalUpgradeCopy({ ...copyInput, retryJobId: failedJobId });
      const copyDeadline = Date.now() + 30_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = await getLocalUpgradeStatus();
      } while (status.operation && Date.now() < copyDeadline);
      assert.equal(status.job?.phase, 'verified', JSON.stringify(status));
      assert.equal(status.job?.id, failedJobId);
      assert.match(
        ((await getLocalUpgradeReport()) as { backupCertification: string }).backupCertification,
        /Server restored and verified/,
      );
      await fs.appendFile(
        path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'browser-backups', id, 'backup.tar.gz'),
        'tampered',
      );
      assert.equal((await fetch(`${url}/backup/download?id=${id}`, { headers })).status, 409);
    } finally {
      await listener.close();
    }
  } else if (command === 'copy-without-key') {
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(localMetadataSourceRoots());
    const { createApiApp } = await import('../../app.js');
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    const previousKey = process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
    const previousEnabled = process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED;
    try {
      delete process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
      delete process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED;
      const before = await getLocalUpgradeStatus();
      assert.equal(before.copyConfigurationReady, true);
      assert.equal(before.settingsEncryptionRequired, false);
      const response = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rivet-Migration-Intent': '1',
          Origin: listener.baseUrl,
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
        },
        body: JSON.stringify({
          revision: state.revision,
          backupReference: 'fixture-restored-copy',
          backupSourceFingerprint: fingerprint,
          backupRestored: true,
        }),
      });
      assert.equal(response.status, 202);
      let after = await getLocalUpgradeStatus();
      const deadline = Date.now() + 60_000;
      while (after.operation && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        after = await getLocalUpgradeStatus();
      }
      assert.equal(after.job?.phase, 'verified', JSON.stringify(after));
      assert.equal(after.transition?.backend, before.transition?.backend);
      assert.equal(after.transition?.phase, 'verified');
      assert.equal(isVmMigrationMaintenanceActive(), true);
      assert.equal(await fingerprintVmMigrationSource(localMetadataSourceRoots()), fingerprint);
    } finally {
      if (previousKey === undefined) delete process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
      else process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY = previousKey;
      if (previousEnabled === undefined) delete process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED;
      else process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED = previousEnabled;
      await listener.close();
    }
    assert.equal((await getLocalUpgradeStatus()).copyConfigurationReady, true);
  } else if (command === 'backup-status-race') {
    await pauseLocalUpgradeSource();
    const backupPath = path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'browser-backup.json');
    const latch = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release: () => release() };
    };
    const publicationReached = latch(),
      publicationHeld = latch();
    const readReached = latch(),
      readHeld = latch();
    const rename = fs.rename;
    const readFile = fs.readFile;
    const heldPublication = mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
      if (String(args[1]) === backupPath && JSON.parse(await readFile(args[0], 'utf8')).phase === 'ready') {
        publicationReached.release();
        await publicationHeld.promise;
      }
      return rename(...args);
    });
    let heldRead: ReturnType<typeof mock.method> | undefined;
    let pendingStatus: ReturnType<typeof getLocalUpgradeStatus> | undefined;
    try {
      await startLocalUpgradeBrowserBackup(state.revision);
      await publicationReached.promise;
      let delayOnce = true;
      heldRead = mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
        const bytes = await readFile(...args);
        if (delayOnce && String(args[0]) === backupPath) {
          delayOnce = false;
          readReached.release();
          await readHeld.promise;
        }
        return bytes;
      });
      pendingStatus = getLocalUpgradeStatus();
      await readReached.promise;
      publicationHeld.release();
      const deadline = Date.now() + 10_000;
      let finished;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = await getLocalUpgradeStatus();
      } while (finished.operation && Date.now() < deadline);
      assert.equal(finished.operation, null);
      assert.equal(finished.backup?.phase, 'ready');
      readHeld.release();
      const snapshot = await pendingStatus;
      assert.equal(snapshot.backup?.phase, 'ready', 'Completed backup must not be classified as interrupted.');
      assert.equal(snapshot.backupStatusUnreadable, false);
      assert.equal(snapshot.backup?.id, finished.backup.id);
      heldRead.mock.restore();
      let reads = 0;
      heldRead = mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
        const bytes = await readFile(...args);
        if (String(args[0]) === backupPath) {
          reads++;
          // Each preflight attempt changes activity while this read is held,
          // without replacing the completed archive or changing authority.
          await assert.rejects(startLocalUpgradeBrowserBackup(state.revision + 1), /Reload status/);
        }
        return bytes;
      });
      const unstable = await getLocalUpgradeStatus();
      assert.equal(reads, 2, 'Backup evidence retries must remain bounded.');
      assert.equal(unstable.backup, null);
      assert.equal(unstable.backupStatusUnreadable, true);
      assert.equal(unstable.transition?.revision, state.revision);
      heldRead.mock.restore();
      heldRead = undefined;
      const recovered = await getLocalUpgradeStatus();
      assert.equal(recovered.backupStatusUnreadable, false);
      assert.equal(recovered.backup?.id, finished.backup.id);
      assert.equal(recovered.backup?.phase, 'ready');
    } finally {
      publicationHeld.release();
      readHeld.release();
      await pendingStatus?.catch(() => undefined);
      heldRead?.mock.restore();
      heldPublication.mock.restore();
    }
  } else if (command === 'copy-status-race') {
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(localMetadataSourceRoots());
    let releaseCopy!: () => void;
    let copyArrived!: () => void;
    const copyHeld = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const copyReached = new Promise<void>((resolve) => {
      copyArrived = resolve;
    });
    await startLocalUpgradeCopy(
      {
        revision: state.revision,
        backupReference: 'fixture-restored-copy',
        backupSourceFingerprint: fingerprint,
        backupRestored: true,
        encryptionKeyBackedUp: true,
      },
      {
        checkpoint: async (point) => {
          if (point !== 'copy:preflight') return;
          copyArrived();
          await copyHeld;
          throw Object.assign(new Error('fixture copy failure'), { code: 'ENOSPC' });
        },
      },
    );
    await copyReached;
    let releaseRead!: () => void;
    let readArrived!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readReached = new Promise<void>((resolve) => {
      readArrived = resolve;
    });
    const lstat = fs.lstat;
    let delayOnce = true;
    const delayed = mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
      if (
        delayOnce &&
        String(args[0]) === path.join(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!, 'browser-backup.json')
      ) {
        delayOnce = false;
        readArrived();
        await readHeld;
      }
      return lstat(...args);
    });
    let pendingStatus: ReturnType<typeof getLocalUpgradeStatus> | undefined;
    try {
      pendingStatus = getLocalUpgradeStatus();
      await readReached;
      releaseCopy();
      const deadline = Date.now() + 10_000;
      let finished;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = await getLocalUpgradeStatus();
      } while (finished.operation && Date.now() < deadline);
      assert.equal(finished.job?.phase, 'failed');
      assert.equal(finished.operation, null);
      releaseRead();
      const snapshot = await pendingStatus;
      assert.equal(snapshot.operation, 'copy');
      assert.equal(snapshot.job?.phase, 'copying');
      assert.equal((await getLocalUpgradeStatus()).job?.phase, 'failed');
    } finally {
      releaseCopy();
      releaseRead();
      // Close the held status' control handles even when an assertion fails.
      await pendingStatus?.catch(() => undefined);
      delayed.mock.restore();
    }
  } else if (
    command === 'copy' ||
    command === 'copy-fault' ||
    command === 'copy-retry' ||
    command === 'copy-operation-status'
  ) {
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(localMetadataSourceRoots());
    const previousJob = (await getLocalUpgradeStatus()).job;
    // Malformed admission evidence is rejected before durable work starts.
    // Full fingerprint verification belongs to the background job below.
    await assert.rejects(
      startLocalUpgradeCopy({
        revision: state.revision,
        backupReference: 'fixture-restored-copy',
        backupSourceFingerprint: '0'.repeat(64),
        backupRestored: false,
        encryptionKeyBackedUp: true,
      }),
      /must be certified/,
    );
    assert.deepEqual((await getLocalUpgradeStatus()).job, previousJob);
    await startLocalUpgradeCopy(
      {
        revision: state.revision,
        backupReference: 'fixture-restored-copy',
        backupSourceFingerprint: fingerprint,
        backupRestored: true,
        encryptionKeyBackedUp: true,
        ...(command === 'copy-retry' ? { retryJobId: (await getLocalUpgradeStatus()).job!.id } : {}),
      },
      command === 'copy-fault' ? faultHooks : {},
    );
    const deadline = Date.now() + 60_000;
    let status;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await getLocalUpgradeStatus();
    } while ((status.job?.phase === 'copying' || status.operation !== null) && Date.now() < deadline);
    assert.equal(status.operation, null);
    assert.equal(status.job?.phase, command === 'copy-fault' ? 'failed' : 'verified', JSON.stringify(status));
    if (command === 'copy-fault') {
      assert.ok(status.job?.failure);
      assert.equal(
        status.job.failure.code,
        process.env.REHEARSAL_FAULT_MODE === 'ENOSPC' ? 'disk-full' : 'permission-denied',
      );
      assert.equal(JSON.stringify(status).includes('never-persist-error-content'), false);
      const report = await getLocalUpgradeReport();
      assert.equal('verified' in report && report.verified, false);
      assert.equal('job' in report && report.job?.id, status.job.id);
      assert.equal(JSON.stringify(report).includes('never-persist-error-content'), false);
    }
    assert.equal(status.runningBackend, 'legacy');
    assert.equal(await fingerprintVmMigrationSource(localMetadataSourceRoots()), fingerprint);
    if (command === 'copy') {
      await assert.rejects(transitionLocalUpgrade('activate', state.revision), /Stale/);
      await transitionLocalUpgrade('activate', status.transition!.revision);
    }
    if (command === 'copy-operation-status') {
      let release!: () => void;
      let arrived!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const activation = transitionLocalUpgrade('activate', status.transition!.revision, {
        checkpoint: async (point) => {
          if (point === 'activate:before-commit') {
            arrived();
            await held;
          }
        },
      });
      const { createApiApp } = await import('../../app.js');
      const listener = await listenTestServer(http.createServer(createApiApp('combined')));
      try {
        await reached;
        const headers = {
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
        };
        const current = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade`, { headers });
        assert.equal(current.status, 200);
        const visible = await current.json();
        assert.equal(visible.operation, 'activate');
        assert.equal(JSON.stringify(visible).includes('never-return-this-secret'), false);
        const competing = await fetch(`${listener.baseUrl}/api/app-settings/local-upgrade/inventory`, { headers });
        assert.equal(competing.status, 409);
        assert.equal((await competing.json()).code, 'local-upgrade-busy');
        assert.equal((await getLocalUpgradeStatus()).operation, 'activate');
      } finally {
        release();
        try {
          await activation;
        } finally {
          await listener.close();
        }
      }
      assert.equal((await getLocalUpgradeStatus()).operation, null);
      assert.equal((await getLocalUpgradeStatus()).restartRequired, true);
    }
    if (command !== 'copy-fault')
      assert.throws(
        () => assertLocalMetadataExecutorAdmission({ ...process.env, RIVET_RUNTIME_PROCESS_ROLE: 'executor' }),
        /paused|restart/,
      );
    assert.equal(isVmMigrationMaintenanceActive(), true);
  } else {
    await initializeWorkflowStorage();
    if (
      [
        'validate',
        'resume',
        'resume-refence',
        'return',
        'activate-fault',
        'resume-fault',
        'assert-interrupted',
      ].includes(command!)
    ) {
      health = await listenTestServer(http.createServer((_req, response) => response.writeHead(200).end()));
      process.env.RIVET_BACKEND_HEALTH_PORT = String(health.port);
      if (command === 'assert-interrupted') {
        const status = await getLocalUpgradeStatus();
        assert.equal(status.job?.phase, state.phase === 'verified' ? 'verified' : 'interrupted');
        assert.equal(status.runningBackend, 'legacy');
        assert.equal(isVmMigrationMaintenanceActive(), true);
      } else if (command === 'activate-fault') await transitionLocalUpgrade('activate', state.revision, faultHooks);
      else if (command === 'resume-fault') await transitionLocalUpgrade('resume', state.revision, faultHooks);
      else if (command === 'return') await transitionLocalUpgrade('return-to-legacy', state.revision);
      else if (command === 'validate') {
        assert.throws(assertLocalMetadataWritesAllowed, /paused/);
        await transitionLocalUpgrade('validate', state.revision);
      } else {
        assert.ok(state.validationEvidenceHash);
        await transitionLocalUpgrade('resume', state.revision);
        assert.throws(assertLocalMetadataWritesAllowed, /restart/);
        assert.equal(getLocalUpgradeSetupStatus().liveSqlite, false);
        assert.throws(
          () => assertLocalMetadataExecutorAdmission({ ...process.env, RIVET_RUNTIME_PROCESS_ROLE: 'executor' }),
          /restart/,
        );
        if (command === 'resume-refence') {
          await pauseLocalUpgradeSource();
          assert.equal(isVmMigrationMaintenanceActive(), true);
          assert.throws(assertLocalMetadataWritesAllowed, /paused/);
        }
      }
    } else if (command === 'live') {
      assert.equal(getAppSettingsBackendKind(), 'sqlite');
      assertLocalMetadataWritesAllowed();
      assert.equal(getLocalUpgradeSetupStatus().liveSqlite, true);
      const previousPreparationCapability = process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE;
      try {
        process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = '1';
        assert.equal(getLocalUpgradeSetupStatus().uiPreparationAvailable, false);
      } finally {
        if (previousPreparationCapability === undefined) delete process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE;
        else process.env.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = previousPreparationCapability;
      }
      const { readDeploymentStorageSettings, writeDeploymentStorageSettings } = await import(
        '../../deployment-storage-settings.js'
      );
      const storageBefore = await readDeploymentStorageSettings();
      assert.match(storageBefore.storageModeChangeBlockedReason!, /separate verified managed migration/);
      await assert.rejects(
        writeDeploymentStorageSettings({ storageMode: 'managed', storageModeChangeBlockedReason: null }),
        /separate verified managed migration/,
      );
      assert.deepEqual(await readDeploymentStorageSettings(), storageBefore);
      assertLocalMetadataExecutorAdmission({ ...process.env, RIVET_RUNTIME_PROCESS_ROLE: 'executor' });
      const original = await loadHostedProject(path.join(localMetadataSourceRoots().workflows, 'story.rivet-project'));
      const [project, attached] = loadProjectAndAttachedDataFromString(original.contents);
      project.metadata.description = 'saved-in-selected-sqlite';
      await saveHostedProject({
        projectPath: path.join(localMetadataSourceRoots().workflows, 'story.rivet-project'),
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: original.revisionId,
      });
      const native = createLocalCatalogNativeApi();
      assert.match(
        await native.readTextFile(path.join(localMetadataSourceRoots().workflows, 'story.rivet-project')),
        /saved-in-selected-sqlite/,
      );
      await assert.rejects(
        native.writeTextFile(path.join(localMetadataSourceRoots().workflows, 'story.rivet-project'), 'bad'),
        /project operations/,
      );
      assert.ok(readManifest().packages.example);
      const require = createRequire(path.join(getRootPath(), 'current', 'package.json'));
      assert.equal(require('example'), 42);
      // Real HTTP boundary: browser-style proxy authentication alone is denied.
      const app = express();
      app.use('/io', localCatalogExecutorIoRouter);
      const listener = await listenTestServer(http.createServer(app));
      try {
        const request = {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rivet-proxy-auth': getExpectedProxyAuthToken() },
          body: JSON.stringify({
            action: 'read-text',
            path: path.join(localMetadataSourceRoots().workflows, 'story.rivet-project'),
          }),
        };
        assert.equal((await fetch(`${listener.baseUrl}/io`, request)).status, 403);
        const response = await fetch(`${listener.baseUrl}/io`, {
          ...request,
          headers: { ...request.headers, 'x-rivet-executor-auth': getExpectedExecutorAuthToken() },
        });
        assert.equal(response.status, 200);
        assert.match(((await response.json()) as { result: string }).result, /saved-in-selected-sqlite/);
        assert.equal(
          (
            await fetch(`${listener.baseUrl}/io`, {
              ...request,
              headers: { ...request.headers, 'x-rivet-executor-auth': getExpectedExecutorAuthToken() },
              body: JSON.stringify({
                action: 'read-text',
                path: path.join(localMetadataSourceRoots().appData, 'settings', 'environment-variables.json'),
              }),
            })
          ).status,
          403,
        );
      } finally {
        await listener.close();
      }
      await assert.rejects(transitionLocalUpgrade('return-to-legacy', state.revision), /Pause writes/);
      // An authoritative operational table must not be rebuilt as empty.
      const operationalPath = path.join(selected!.operationalRoot, 'llm-profile-health.sqlite');
      const damaged = new DatabaseSync(operationalPath);
      try {
        damaged.exec('DROP TABLE llm_profile_health');
      } finally {
        damaged.close();
      }
      const operational = new FilesystemRivetLLMProfileHealthStore(operationalPath);
      try {
        await assert.rejects(operational.list(), /unexpected or missing tables/);
      } finally {
        await operational.dispose();
      }
      const inspection = new DatabaseSync(operationalPath, { readOnly: true });
      try {
        assert.equal(
          inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='llm_profile_health'").get(),
          undefined,
        );
      } finally {
        inspection.close();
      }
    } else if (command === 'legacy' || command === 'legacy-fenced') {
      assert.equal(getAppSettingsBackendKind(), 'file');
      await initializeRuntimeLibrariesBackend();
      if (command === 'legacy-fenced') {
        assert.equal(isVmMigrationMaintenanceActive(), true);
        assert.throws(assertLocalMetadataWritesAllowed, /paused/);
      }
    } else throw new Error('Unknown rehearsal command.');
  }
  console.log(`rehearsal:${command}:ok`);
} finally {
  await health?.close();
  await disposeWorkflowStorage();
  disposeLibraries?.();
  await disposeAppSettingsRepositories();
}
