import assert from 'node:assert/strict';
import http from 'node:http';
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
  getLocalUpgradeReport,
  inspectLocalUpgradeSource,
  pauseLocalUpgradeSource,
  startLocalUpgradeCopy,
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
import { assertLocalMetadataExecutorAdmission } from '../../../../app-executor/bin/localMetadataAdmission.mjs';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenTestServer } from './http-server-harness.js';
import { isVmMigrationMaintenanceActive } from '../../vm-migration-maintenance.js';
import { enableWorkflowRecordingMigrationCopyMode } from '../../routes/workflows/recordings.js';
import { initializeRuntimeLibrariesBackend } from '../../runtime-libraries/backend.js';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemRivetLLMProfileHealthStore } from '../../llm-profile-health/filesystem-store.js';
import { format } from 'node:util';

const command = process.argv[2];
const faultHooks = {
  checkpoint: async (checkpoint: string) => {
    if (checkpoint !== process.env.REHEARSAL_FAULT_POINT) return;
    if (process.env.REHEARSAL_FAULT_MODE === 'kill') process.kill(process.pid, 'SIGKILL');
    throw Object.assign(new Error('secret-fixture-error: password=never-persist-error-content'), {
      code: process.env.REHEARSAL_FAULT_MODE,
    });
  },
};
if (command === 'supervised') {
  // Actual container-runtime processes, not a stub health responder. All
  // authoritative paths and executor app-data belong to this temporary fixture.
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
  const { startBackendSupervisor } = await import(
    pathToFileURL(path.join(repo, 'deploy/studio-server/images/api/backend-supervisor.mjs')).href
  );
  const freePort = async () => {
    const listener = await listenTestServer(http.createServer());
    const port = listener.port;
    await listener.close();
    return port;
  };
  const apiPort = await freePort(),
    executorPort = await freePort(),
    healthPort = await freePort();
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
      '--import',
      'tsx',
      path.join(repo, 'packages/studio-server-api/src/server.ts'),
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
          headers: { 'x-rivet-proxy-auth': getExpectedProxyAuthToken() },
        })
      ).status,
      503,
      'Paused real startup must not admit data requests.',
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
  if (command === 'inspect-capacity') {
    const inspected = await inspectLocalUpgradeSource();
    assert.equal(inspected.capacity.fits, false);
    assert.ok(inspected.capacity.reasons.includes('payload-budget'));
    assert.equal(inspected.inventory, null, 'Oversized project bytes must not reach the aggregate inventory parser.');
    assert.equal(isVmMigrationMaintenanceActive(), false);
    assert.equal((await getLocalUpgradeStatus()).job, null);
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
  } else if (command === 'copy-invalid-key') {
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(localMetadataSourceRoots());
    const { createApiApp } = await import('../../app.js');
    const listener = await listenTestServer(http.createServer(createApiApp('combined')));
    const previousKey = process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
    try {
      for (const key of ['', 'bad', 'x'.repeat(31)]) {
        process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY = key;
        const before = await getLocalUpgradeStatus();
        assert.equal(before.copyConfigurationReady, false);
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
            encryptionKeyBackedUp: true,
          }),
        });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.code, 'local-encryption-key-required');
        assert.match(body.error, /No copy was started/);
        const after = await getLocalUpgradeStatus();
        assert.equal(after.job, null);
        assert.deepEqual(after.transition, before.transition);
        assert.equal(isVmMigrationMaintenanceActive(), true);
        assert.equal(await fingerprintVmMigrationSource(localMetadataSourceRoots()), fingerprint);
      }
    } finally {
      if (previousKey === undefined) delete process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
      else process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY = previousKey;
      await listener.close();
    }
    assert.equal((await getLocalUpgradeStatus()).copyConfigurationReady, true);
  } else if (
    command === 'copy' ||
    command === 'copy-fault' ||
    command === 'copy-retry' ||
    command === 'copy-operation-status'
  ) {
    await pauseLocalUpgradeSource();
    const fingerprint = await fingerprintVmMigrationSource(localMetadataSourceRoots());
    const previousJob = (await getLocalUpgradeStatus()).job;
    // Rejected backup certification must not start a durable job.
    await assert.rejects(
      startLocalUpgradeCopy({
        revision: state.revision,
        backupReference: 'fixture-restored-copy',
        backupSourceFingerprint: '0'.repeat(64),
        backupRestored: true,
        encryptionKeyBackedUp: true,
      }),
      /fingerprint/,
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
