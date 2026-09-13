import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Explicit opt-in: this is a disposable integration server, not a deployment.
if (process.env.RIVET_TRUSTED_CLIENT_BROWSER_FIXTURE !== '1') {
  throw new Error('Set RIVET_TRUSTED_CLIENT_BROWSER_FIXTURE=1 to start this test fixture');
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-trust-browser-'));
Object.assign(process.env, {
  RIVET_APP_DATA_ROOT: path.join(root, 'app'),
  RIVET_WORKSPACE_ROOT: root,
  RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
  RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
  RIVET_STORAGE_MODE: 'filesystem',
  RIVET_KEY: 'fixture-key',
  RIVET_SERVER_UI_AUTH_MODE: 'key',
});
await fs.mkdir(path.join(root, 'app', 'settings'), { recursive: true });
await fs.mkdir(path.join(root, 'workflows'), { recursive: true });
// Verify normal login survives a malformed bypass policy.
await fs.writeFile(path.join(root, 'app', 'settings', 'trusted-hosts.json'), '{"trustedClients":["broken-hostname"]}');
const { createApiApp } = await import('../../app.js');
const { initializeWorkflowStorage, disposeWorkflowStorage } = await import('../../routes/workflows/storage-backend.js');
const { disposeAppSettingsRepositories } = await import('../../app-settings/settings-repository.js');
await initializeWorkflowStorage();
const server = http.createServer(createApiApp('combined'));
server.listen(Number(process.env.RIVET_TRUSTED_CLIENT_BROWSER_PORT ?? 0), '0.0.0.0', () => {
  console.log('TRUST_BROWSER_API_PORT=' + (server.address() as import('node:net').AddressInfo).port);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disposeWorkflowStorage();
  await disposeAppSettingsRepositories();
  await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
