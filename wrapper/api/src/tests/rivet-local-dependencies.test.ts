import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearEmbeddedRivetPnpArtifacts,
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

test('embedded snapshots discard stale PnP artifacts without touching linked workspaces', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-pnp-cleanup-'));
  const embeddedRootDir = path.join(baseDir, 'wrapper');
  const embeddedRivetDir = path.join(embeddedRootDir, 'rivet');
  const externalRivetDir = path.join(baseDir, 'upstream');

  try {
    for (const rivetDir of [embeddedRivetDir, externalRivetDir]) {
      fs.mkdirSync(path.join(rivetDir, '.yarn'), { recursive: true });
      fs.writeFileSync(path.join(rivetDir, '.pnp.cjs'), 'loader');
      fs.writeFileSync(path.join(rivetDir, '.pnp.loader.mjs'), 'loader');
      fs.writeFileSync(path.join(rivetDir, '.yarn', 'install-state.gz'), 'state');
    }

    assert.equal(clearEmbeddedRivetPnpArtifacts(embeddedRootDir, embeddedRivetDir), true);
    assert.equal(clearEmbeddedRivetPnpArtifacts(embeddedRootDir, embeddedRivetDir), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.cjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.loader.mjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.yarn', 'install-state.gz')), false);

    assert.equal(clearEmbeddedRivetPnpArtifacts(embeddedRootDir, externalRivetDir), false);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.cjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.loader.mjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.yarn', 'install-state.gz')), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
