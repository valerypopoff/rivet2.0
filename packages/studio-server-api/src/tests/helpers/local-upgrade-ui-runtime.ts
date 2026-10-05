import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../../auth.js';
import { listenTestServer } from './http-server-harness.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const { runBackendSupervisor } = await import(
  pathToFileURL(path.join(repo, 'deploy/studio-server/images/api/backend-supervisor.mjs')).href
);
const freePort = async () => {
  const server = await listenTestServer(http.createServer());
  const port = server.port;
  await server.close();
  return port;
};
const apiPort = await freePort(),
  executorPort = await freePort(),
  healthPort = await freePort();
const ownedRoot = path.dirname(process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT!);
const volume = path.join(ownedRoot, 'ui-control');
const executorData = path.join(ownedRoot, 'ui-executor');
await fs.mkdir(volume);
await fs.mkdir(executorData);
const signals = new EventEmitter();
const completed = runBackendSupervisor({
  env: {
    ...process.env,
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: '',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '',
    RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '0',
    RIVET_LOCAL_METADATA_UI_ROOT: volume,
  },
  apiCommand: [
    process.execPath,
    '--import',
    pathToFileURL(path.join(repo, 'packages/studio-server-bootstrap/bootstrap.mjs')).href,
    '--import',
    'tsx',
    path.join(repo, 'packages/studio-server-api/src/server.ts'),
  ],
  executorCommand: [
    process.execPath,
    '--import',
    pathToFileURL(path.join(repo, 'packages/studio-server-bootstrap/bootstrap.mjs')).href,
    path.join(repo, 'packages/studio-server-executor/dist/executor-bundle.cjs'),
  ],
  executorCwd: repo,
  executorEnvOverrides: { RIVET_APP_DATA_ROOT: executorData },
  signalSource: signals,
  localUpgradeProvisionCommand: [
    process.execPath,
    '--import',
    'tsx',
    path.join(repo, 'packages/studio-server-api/src/scripts/local-metadata-control.ts'),
    '--provision',
  ],
  apiStartupTimeoutMs: 45000,
  shutdownTimeoutMs: 10000,
});
const headers = {
  'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
  'X-Rivet-Migration-Intent': '1',
  'Content-Type': 'application/json',
};
const base = `http://127.0.0.1:${apiPort}/api/app-settings/local-upgrade`;
const request = (suffix = '', body?: unknown) =>
  fetch(`${base}${suffix}`, {
    headers,
    signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
async function json(suffix = '') {
  const response = await request(suffix);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function post(suffix: string, body: unknown, status = 202) {
  const response = await request(suffix, body);
  assert.equal(response.status, status, await response.text());
}
async function waitFor(read: () => Promise<any>, matches: (state: any) => boolean) {
  const end = Date.now() + 55000;
  while (Date.now() < end) {
    try {
      const state = await read();
      if (matches(state)) return state;
    } catch {
      /* Backend may be restarting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('UI migration stage did not settle.');
}
let completionCode: number | undefined;
try {
  await waitFor(
    () => json('/setup'),
    (s) => s.uiPreparationAvailable,
  );
  assert.equal(
    (
      await fetch(`${base}/prepare`, {
        method: 'POST',
        headers: { ...headers, 'X-Rivet-Migration-Intent': '' },
        body: '{}',
      })
    ).status,
    403,
  );
  await post('/prepare', {});
  let status = await waitFor(
    () => json(),
    (s) => s.available && s.uiRestartAvailable,
  );
  assert.equal(status.transition.phase, 'legacy');
  await post('/prepare', {}, 409);
  await post('/restart', { revision: status.transition.revision }, 409);
  assert.equal((await json('/inventory')).capacity.fits, true);
  await post('/pause', {}, 204);
  status = await waitFor(
    () => json(),
    (s) => s.drain?.ready,
  );
  await post('/backup', { revision: status.transition.revision });
  status = await waitFor(
    () => json(),
    (s) => s.backup?.phase === 'ready',
  );
  const backup = status.backup;
  const keyResponse = await request(`/backup/key?id=${backup.id}`);
  assert.equal(keyResponse.status, 200);
  assert.match(await keyResponse.text(), /^[a-f0-9]{64}$/);
  const archive = await request(`/backup/download?id=${backup.id}`);
  assert.equal(archive.status, 200);
  await archive.arrayBuffer();
  await post('/copy', {
    revision: status.transition.revision,
    backupReference: `browser-backup:${backup.id}:${backup.archiveHash}`,
    backupSourceFingerprint: backup.sourceFingerprint,
    backupRestored: true,
    encryptionKeyBackedUp: true,
  });
  status = await waitFor(
    () => json(),
    (s) => s.transition?.phase === 'verified',
  );
  await post('/action', { action: 'activate', revision: status.transition.revision }, 204);
  status = await json();
  assert.equal(status.restartRequired, true);
  await post('/restart', { revision: status.transition.revision - 1 }, 409);
  await post('/restart', { revision: status.transition.revision });
  status = await waitFor(
    () => json(),
    (s) => s.runningBackend === 'sqlite' && !s.restartRequired && s.runtimeReady,
  );
  await post('/action', { action: 'validate', revision: status.transition.revision }, 204);
  status = await json();
  assert.equal(status.transition.validated, true);
  assert.ok(status.maintenance);
  await post('/action', { action: 'resume', revision: status.transition.revision }, 204);
  status = await json();
  assert.equal(status.restartRequired, true);
  await post('/restart', { revision: status.transition.revision });
  status = await waitFor(
    () => json(),
    (s) => s.transition?.phase === 'sqlite-live' && !s.restartRequired && !s.maintenance && s.runtimeReady,
  );
  assert.equal(status.transition.canReturnToLegacy, false);
  const tree = await fetch(`http://127.0.0.1:${apiPort}/api/workflows/tree`, { headers });
  assert.equal(tree.status, 200);
  assert.deepEqual(
    (await tree.json()).projects.map((project: { relativePath: string }) => project.relativePath),
    ['story.rivet-project'],
  );
} finally {
  signals.emit('SIGTERM');
  completionCode = await completed;
}
assert.equal(completionCode, 0);
