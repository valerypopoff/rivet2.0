import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearEmbeddedRivetPnpLoaders,
  ensureEmbeddedRivetNodeModulesConfig,
  getRivetYarnEnvironment,
  getRivetYarnInvocation,
  hasRivetPnpInstall,
  isExternalRivetWorkspace,
  stripPnpNodeOptions,
} from '../../../../scripts/lib/rivet-local-dependencies.mjs';

test('embedded Rivet workspaces keep the wrapper node-modules layout', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-wrapper-'));
  const rivetDir = path.join(rootDir, 'rivet');
  fs.mkdirSync(rivetDir);

  assert.equal(isExternalRivetWorkspace(rootDir, rivetDir), false);
  assert.deepEqual(getRivetYarnEnvironment(rootDir, rivetDir), {
    NODE_OPTIONS: '',
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

test('embedded snapshots preserve non-PnP Node options while removing PnP preloads', () => {
  assert.equal(
    stripPnpNodeOptions('--max-old-space-size=8192 --require /workspace/.pnp.cjs --trace-warnings'),
    '--max-old-space-size=8192 --trace-warnings',
  );
  assert.equal(
    stripPnpNodeOptions('--import="file:///workspace/.pnp.loader.mjs" --inspect=9229'),
    '--inspect=9229',
  );
  assert.equal(stripPnpNodeOptions('--require ./instrumentation.cjs'), '--require ./instrumentation.cjs');
});

test('embedded snapshots persist node-modules without changing linked checkouts', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-linker-config-'));
  const embeddedRootDir = path.join(baseDir, 'wrapper');
  const embeddedRivetDir = path.join(embeddedRootDir, 'rivet');
  const externalRivetDir = path.join(baseDir, 'upstream');

  try {
    fs.mkdirSync(embeddedRivetDir, { recursive: true });
    fs.mkdirSync(externalRivetDir, { recursive: true });
    fs.writeFileSync(path.join(embeddedRivetDir, '.yarnrc.yml'), 'nodeLinker: pnp\npnpEnableEsmLoader: true\n');
    fs.writeFileSync(path.join(externalRivetDir, '.yarnrc.yml'), 'nodeLinker: pnp\n');

    assert.equal(ensureEmbeddedRivetNodeModulesConfig(embeddedRootDir, embeddedRivetDir), true);
    assert.equal(ensureEmbeddedRivetNodeModulesConfig(embeddedRootDir, embeddedRivetDir), false);
    assert.match(fs.readFileSync(path.join(embeddedRivetDir, '.yarnrc.yml'), 'utf8'), /^nodeLinker: node-modules$/m);

    assert.equal(ensureEmbeddedRivetNodeModulesConfig(embeddedRootDir, externalRivetDir), false);
    assert.equal(fs.readFileSync(path.join(externalRivetDir, '.yarnrc.yml'), 'utf8'), 'nodeLinker: pnp\n');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Rivet commands use the upstream checkout\'s pinned Yarn release', () => {
  const rivetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-yarn-release-'));
  const yarnReleasePath = path.join(rivetDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');

  try {
    fs.mkdirSync(path.dirname(yarnReleasePath), { recursive: true });
    fs.writeFileSync(path.join(rivetDir, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.17.1.cjs\n');
    fs.writeFileSync(yarnReleasePath, '');

    assert.deepEqual(getRivetYarnInvocation(rivetDir), {
      command: process.execPath,
      args: [yarnReleasePath],
    });
  } finally {
    fs.rmSync(rivetDir, { recursive: true, force: true });
  }
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

test('embedded snapshots discard PnP loaders without touching linked workspaces or install state', () => {
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

    assert.equal(clearEmbeddedRivetPnpLoaders(embeddedRootDir, embeddedRivetDir), true);
    assert.equal(clearEmbeddedRivetPnpLoaders(embeddedRootDir, embeddedRivetDir), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.cjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.loader.mjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.yarn', 'install-state.gz')), true);

    assert.equal(clearEmbeddedRivetPnpLoaders(embeddedRootDir, externalRivetDir), false);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.cjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.loader.mjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.yarn', 'install-state.gz')), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
