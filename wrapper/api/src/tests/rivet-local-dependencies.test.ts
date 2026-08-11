import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getRivetYarnEnvironment,
  hasRivetPnpInstall,
  isExternalRivetWorkspace,
} from '../../../../scripts/lib/rivet-local-dependencies.mjs';

test('embedded Rivet workspaces keep the wrapper node-modules layout', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-wrapper-'));
  const rivetDir = path.join(rootDir, 'rivet');
  fs.mkdirSync(rivetDir);

  assert.equal(isExternalRivetWorkspace(rootDir, rivetDir), false);
  assert.deepEqual(getRivetYarnEnvironment(rootDir, rivetDir), {
    YARN_NODE_LINKER: 'node-modules',
  });
});

test('external Rivet workspaces preserve their configured Yarn linker', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-linked-'));
  const rootDir = path.join(baseDir, 'wrapper');
  const rivetDir = path.join(baseDir, 'upstream');
  fs.mkdirSync(rootDir);
  fs.mkdirSync(rivetDir);

  assert.equal(isExternalRivetWorkspace(rootDir, rivetDir), true);
  assert.deepEqual(getRivetYarnEnvironment(rootDir, rivetDir), {});
});

test('PnP readiness requires both the loader and install-state marker', () => {
  const rivetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-pnp-'));
  const yarnDir = path.join(rivetDir, '.yarn');
  fs.mkdirSync(yarnDir);

  assert.equal(hasRivetPnpInstall(rivetDir), false);
  fs.writeFileSync(path.join(rivetDir, '.pnp.cjs'), '');
  assert.equal(hasRivetPnpInstall(rivetDir), false);
  fs.writeFileSync(path.join(yarnDir, 'install-state.gz'), '');
  assert.equal(hasRivetPnpInstall(rivetDir), true);
});
