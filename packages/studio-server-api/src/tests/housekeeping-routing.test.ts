import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { routeMaintenanceOwner } from '../ha-maintenance-routing.js';
import { createHousekeepingIncarnationGuard, getHousekeepingReadiness } from '../housekeeping-owner.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
test('real streamed maintenance forwarding binds owner identity and never retries an accepted write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-http-'));
  const before = { ...process.env };
  const namespace = randomUUID(),
    incarnation = randomUUID(),
    capability = 'a'.repeat(64);
  let writes = 0,
    accepting = true;
  const workerApp = express();
  workerApp.use(
    createHousekeepingIncarnationGuard(
      {
        RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap',
        RIVET_HA_MAINTENANCE: '1',
        RIVET_PROCESS_INCARNATION: incarnation,
        RIVET_HOUSEKEEPING_CAPABILITY: capability,
      },
      () => accepting,
    ),
  );
  workerApp.post('/api/workflows/project-bundles/container', express.text(), (req, res) => {
    writes++;
    if (req.body === 'disconnect after acceptance') {
      res.destroy();
      return;
    }
    res.json({ body: req.body });
  });
  const podUid = randomUUID();
  workerApp.get('/internal/ha/runtime-contract', (_req, res) =>
    res.json({
      maintenanceOwner: true,
      housekeepingIdentity: { podUid, incarnation },
      housekeepingAdmission: accepting ? 'ready' : 'handover',
    }),
  );
  const worker = createServer(workerApp),
    frontendApp = express();
  frontendApp.use(routeMaintenanceOwner);
  frontendApp.use((_req, res) => res.sendStatus(500));
  const frontend = createServer(frontendApp);
  try {
    const workerPort = await listen(worker),
      port = await listen(frontend);
    Object.assign(process.env, {
      RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
      RIVET_HA_DEPLOYMENT: '1',
      RIVET_HA_MAINTENANCE: '0',
      RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap',
      RIVET_LEGACY_RESTORE_ROOT: root,
      RIVET_NAMESPACE_UID: namespace,
    });
    const file = path.join(root, 'housekeeping-owner.json');
    const descriptor = {
      protocol: 1,
      state: 'owner',
      address: '127.0.0.1',
      port: workerPort,
      namespaceUid: namespace,
      podUid,
      incarnation,
      capability,
    };
    await fs.writeFile(file, JSON.stringify(descriptor));
    assert.equal((await getHousekeepingReadiness()).state, 'ready');
    const url = `http://127.0.0.1:${port}/api/workflows/project-bundles/container`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'one accepted upload',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { body: 'one accepted upload' });
    assert.equal(writes, 1);
    accepting = false;
    assert.equal((await getHousekeepingReadiness()).state, 'handover');
    assert.equal((await fetch(url, { method: 'POST', body: 'handover must reject new preparation' })).status, 503);
    assert.equal(writes, 1);
    accepting = true;
    const uncertain = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'disconnect after acceptance',
    });
    assert.equal(uncertain.status, 503);
    const outcome = await uncertain.json();
    assert.equal(outcome.code, 'housekeeping_owner_unavailable');
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(writes, 2, 'an uncertain accepted write is never sent twice');
    await fs.writeFile(file, JSON.stringify({ ...descriptor, incarnation: randomUUID() }));
    assert.equal((await getHousekeepingReadiness()).state, 'unavailable');
    assert.equal((await fetch(url, { method: 'POST', body: 'must not execute' })).status, 503);
    assert.equal(writes, 2);
    await fs.writeFile(file, JSON.stringify({ ...descriptor, namespaceUid: randomUUID() }));
    assert.equal((await fetch(url, { method: 'POST' })).status, 503);
    assert.equal((await fetch(url, { headers: { 'x-rivet-housekeeping-incarnation': incarnation } })).status, 409);
    await fs.unlink(file);
    const absent = await fetch(url, { method: 'POST' });
    assert.equal(absent.status, 503);
    assert.equal((await absent.json()).code, 'housekeeping_handover');
    assert.equal(writes, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    worker.closeAllConnections();
    frontend.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => worker.close(() => r())),
      new Promise<void>((r) => frontend.close(() => r())),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
