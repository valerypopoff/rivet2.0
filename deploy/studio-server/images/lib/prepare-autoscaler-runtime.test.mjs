import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { build } from 'esbuild';
import { prepareAutoscalerRuntime } from './prepare-autoscaler-runtime.mjs';
import { checkAutoscalerStartup } from './check-autoscaler-startup.mjs';

// test-style: fixture-read: executes a freshly packaged runtime outside the checkout.
test('the actual autoscaler bundle boots without source files or rollout implementations', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-autoscaler-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputs = await prepareAutoscalerRuntime(directory);
  assert.ok(inputs.some((input) => input.endsWith('/release-operation-state.mjs')));
  assert.ok(inputs.some((input) => input.endsWith('/kubernetes-response-error.mjs')));
  const apiRequire = createRequire(new URL('../../../../packages/studio-server-api/package.json', import.meta.url));
  // Supply the API image's real third-party dependency, detached from Yarn/PnP.
  await build({
    entryPoints: [apiRequire.resolve('ws')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(directory, 'node_modules/ws/index.js'),
    external: ['bufferutil', 'utf-8-validate'],
  });
  const entry = path.join(directory, 'execution-autoscaler-entry.mjs');
  const options = { env: { ...process.env, NODE_OPTIONS: '' } };
  await checkAutoscalerStartup(entry, options);
  const ws = path.join(directory, 'node_modules/ws');
  // Broken exports prevent an ambient ancestor installation from masking the
  // missing packaged dependency on a developer workstation.
  await fs.writeFile(path.join(ws, 'package.json'), JSON.stringify({ exports: './missing-websocket.cjs' }));
  await assert.rejects(checkAutoscalerStartup(entry, options), /missing-websocket/);
  await fs.unlink(path.join(ws, 'package.json'));
  // An unrelated healthy server cannot satisfy the child's startup proof.
  const occupied = createServer((_req, response) => response.end('autoscaler\n'));
  occupied.listen(9090, '0.0.0.0');
  await once(occupied, 'listening');
  try {
    await assert.rejects(checkAutoscalerStartup(entry, options), /EADDRINUSE/);
  } finally {
    occupied.closeAllConnections();
    await new Promise((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
  }
  // A packaged import omission must fail the same smoke check immediately.
  await fs.writeFile(entry, 'import "./missing-rollout-dependency.mjs";');
  await assert.rejects(checkAutoscalerStartup(entry, options), /ERR_MODULE_NOT_FOUND/);
});
