import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';

import {
  enterVmMigrationMaintenance,
  getVmMigrationActiveRequestCount,
  isVmMigrationMaintenanceActive,
  leaveVmMigrationMaintenance,
  readVmMigrationMaintenance,
  vmMigrationRequestBarrier,
  watchVmMigrationPassiveStream,
} from '../vm-migration-maintenance.js';

async function withAppData(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-vm-migration-'));
  const previous = process.env.RIVET_APP_DATA_ROOT;
  const previousControl = process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
  process.env.RIVET_APP_DATA_ROOT = root;
  // This fixture owns a legacy marker, not the dev container's live transition
  // journal. Never consult real deployment state from a temporary marker test.
  delete process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previous;
    if (previousControl === undefined) delete process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
    else process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = previousControl;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function check(pathname: string, method = 'POST') {
  const req = { path: pathname, method } as Request;
  const response = new EventEmitter() as EventEmitter & { code?: number; body?: unknown };
  const res = Object.assign(response, {
    setHeader: () => response,
    status(code: number) {
      response.code = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    end() {
      response.emit('finish');
      response.emit('close');
      return response;
    },
  }) as unknown as Response;
  let nextCalled = false;
  vmMigrationRequestBarrier(req, res, () => {
    nextCalled = true;
  });
  return { response, nextCalled, res };
}

test('VM maintenance persists across reads, blocks data routes, and permits only recovery controls', async () => {
  await withAppData(async () => {
    assert.equal(readVmMigrationMaintenance(), null);
    const active = check('/api/workflows/save');
    assert.equal(active.nextCalled, true);
    assert.equal(getVmMigrationActiveRequestCount(), 1);

    await enterVmMigrationMaintenance();
    assert.equal(isVmMigrationMaintenanceActive(), true);
    assert.ok(readVmMigrationMaintenance()?.enteredAt);
    assert.equal(check('/api/workflows/save').response.code, 503);
    assert.equal(check('/workflows/test', 'GET').response.code, 503);
    for (const download of [
      '/api/workflows/projects/download',
      '/api/workflows/projects/published-versions/download',
    ]) {
      assert.equal(check(download).nextCalled, true);
      assert.equal(check(`${download}/anything`).response.code, 503);
      assert.equal(check(download, 'PUT').response.code, 503);
    }
    assert.equal(check('/api/workflows/projects/published-versions', 'GET').nextCalled, true);
    const bundlePath = '/api/workflows/project-bundles/12345678-1234-1234-1234-123456789abc';
    assert.equal(check('/api/workflows/project-bundles').nextCalled, true);
    assert.equal(check(bundlePath, 'GET').nextCalled, true);
    assert.equal(check(`${bundlePath}/download`, 'GET').nextCalled, true);
    assert.equal(check(bundlePath, 'DELETE').nextCalled, true);
    assert.equal(check(`${bundlePath}/execute`, 'GET').response.code, 503);
    assert.equal(check(bundlePath, 'PUT').response.code, 503);
    assert.equal(check('/api/workflows/tree', 'GET').nextCalled, true);
    assert.equal(check('/api/workflows/tree').response.code, 503);
    assert.equal(check('/api/workflows/projects/published-versions').response.code, 503);
    assert.equal(getVmMigrationActiveRequestCount(), 1, 'Downloads do not delay the write drain.');
    assert.equal(check('/api/app-settings/vm-migration', 'GET').nextCalled, true);
    assert.equal(check('/api/app-settings/deployment-storage', 'GET').nextCalled, true);
    assert.equal(check('/ui-auth/check', 'GET').nextCalled, true);
    for (const configuration of ['/internal/app-settings/proxy-config', '/internal/executor-runtime-config']) {
      assert.equal(check(configuration, 'GET').nextCalled, true);
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
        assert.equal(check(configuration, method).response.code, 503);
      }
      assert.equal(check(`${configuration}/anything`, 'GET').response.code, 503);
    }
    assert.equal(getVmMigrationActiveRequestCount(), 1, 'Proxy configuration does not delay the write drain.');

    active.response.emit('finish');
    active.response.emit('close');
    assert.equal(getVmMigrationActiveRequestCount(), 0);
    await leaveVmMigrationMaintenance();
    assert.equal(isVmMigrationMaintenanceActive(), false);
  });
});

test('a corrupt maintenance marker fails closed', async () => {
  await withAppData(async (root) => {
    await fs.writeFile(path.join(root, 'vm-migration-maintenance.json'), '{broken');
    assert.equal(isVmMigrationMaintenanceActive(), true);
    assert.equal(check('/api/workflows/save').response.code, 503);
    assert.equal(check('/internal/app-settings/proxy-config', 'GET').nextCalled, true);
    assert.equal(getVmMigrationActiveRequestCount(), 0);
    assert.equal(await fs.readFile(path.join(root, 'vm-migration-maintenance.json'), 'utf8'), '{broken');
    assert.throws(() => readVmMigrationMaintenance());
  });
});

test('maintenance closes passive notification streams but still waits for accepted work', async () => {
  await withAppData(async () => {
    const save = check('/api/workflows/save');
    const tree = check('/api/workflows/tree/events', 'GET');
    const library = check('/api/workflows/evaluation-runs/library/events', 'GET');
    assert.equal(watchVmMigrationPassiveStream(tree.res), true);
    assert.equal(watchVmMigrationPassiveStream(library.res), true);
    // Its async setup has not yet completed: it must not be removed from the
    // drain until the owner finishes setup and attempts to open the stream.
    const late = check('/api/workflows/evaluation-runs/library/events', 'GET');
    assert.equal(getVmMigrationActiveRequestCount(), 4);
    await enterVmMigrationMaintenance();
    assert.equal(getVmMigrationActiveRequestCount(), 2);
    assert.equal(watchVmMigrationPassiveStream(late.res), false);
    assert.equal(getVmMigrationActiveRequestCount(), 1);
    save.response.emit('finish');
    assert.equal(getVmMigrationActiveRequestCount(), 0);
    assert.equal(check('/api/workflows/tree/events', 'GET').response.code, 503);
    await leaveVmMigrationMaintenance();
  });
});
