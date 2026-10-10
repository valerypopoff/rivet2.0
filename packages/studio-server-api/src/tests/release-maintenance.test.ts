import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApiApp } from '../app.js';
import { isReleaseMaintenanceActive } from '../release-maintenance.js';
import { getHostedEvaluationsCoordinatorConfig } from '../hosted-evaluations-config.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { getExpectedExecutorAuthToken, getExpectedProxyAuthToken } from '../auth.js';
import { deploymentStorageSettingsRepository } from '../deployment-storage-settings.js';
import { nodeExecutorProxySettingsRepository } from '../node-executor-proxy-settings.js';

test('release validation keeps probes available, denies application traffic and stops Evaluation claims', async () => {
  assert.throws(() => isReleaseMaintenanceActive({ RIVET_RELEASE_MAINTENANCE: 'maybe' }), /true or false/);
  assert.equal(isReleaseMaintenanceActive({}), false);
  const config = getHostedEvaluationsCoordinatorConfig(
    { RIVET_HOSTED_EVALUATIONS_ENABLED: 'true', RIVET_RELEASE_MAINTENANCE: 'true' },
    'evaluation',
    true,
  );
  assert.equal(config.enabled, false);
  assert.equal(config.workerEnabled, false);
  await withEnvOverride('RIVET_RELEASE_MAINTENANCE', 'true', async () => {
    const server = http.createServer(createApiApp('control'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status, 200);
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}/internal/executor-runtime-config`)).status,
        403,
        'bootstrap passes the barrier but remains protected by its owning authentication',
      );
      for (const suffix of ['/ui-auth/check', '/internal/executor-runtime-config/other'])
        assert.equal((await fetch(`http://127.0.0.1:${address.port}${suffix}`)).status, 503);
      for (const method of ['GET', 'POST']) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/tree`, { method });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'release_maintenance');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('paused control API permits authenticated executor bootstrap without permitting executor clients', async (t) => {
  t.mock.method(deploymentStorageSettingsRepository, 'readSync', () => ({
    value: {
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseSslMode: 'verify-full',
      databaseConnectionString: 'fixture',
      objectStorageBucket: 'fixture',
      objectStorageRegion: 'us-east-1',
      objectStorageForcePathStyle: false,
      storageAccessKeyId: 'fixture',
      storageAccessKey: 'fixture',
    },
  }));
  t.mock.method(nodeExecutorProxySettingsRepository, 'readSync', () => ({ value: {} }));
  await withEnvOverride('RIVET_RELEASE_MAINTENANCE', 'true', () =>
    withEnvOverride('RIVET_DEPLOYMENT_TOPOLOGY', 'replicated', () =>
      withEnvOverride('RIVET_KEY', 'fixture-key', async () => {
        const server = http.createServer(createApiApp('control'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const headers = {
          'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
          'x-rivet-executor-auth': getExpectedExecutorAuthToken(),
        };
        try {
          const bootstrap = await fetch(`${base}/internal/executor-runtime-config`, { headers });
          assert.equal(bootstrap.status, 200);
          assert.equal((await bootstrap.json()).protocolVersion, 1);
          assert.equal((await fetch(`${base}/ui-auth/check`, { headers })).status, 503);
          assert.equal(
            (await fetch(`${base}/internal/executor-runtime-config`, { headers, method: 'POST' })).status,
            503,
          );
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }),
    ),
  );
});
