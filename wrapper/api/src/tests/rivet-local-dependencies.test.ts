import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearEmbeddedRivetPnpLoaders,
  clearPnpLoaders,
  ensureEmbeddedRivetNodeModulesConfig,
  ensureWorkspaceNodeModulesConfig,
  getRivetYarnEnvironment,
  getRivetYarnInvocation,
  hasRivetPnpInstall,
  isExternalRivetWorkspace,
  stripPnpNodeOptions,
} from '../../../../scripts/lib/rivet-local-dependencies.mjs';

function readYarnrc(workspaceDir: string): string {
  return fs.readFileSync(path.join(workspaceDir, '.yarnrc.yml'), 'utf8');
}

function assertNodeModulesConfig(workspaceDir: string): void {
  const yarnrc = readYarnrc(workspaceDir);
  assert.match(yarnrc, /^nodeLinker: node-modules$/m);
  assert.match(yarnrc, /^pnpEnableEsmLoader: false$/m);
}

test('embedded Rivet workspaces keep the wrapper node-modules layout', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-wrapper-'));
  const rivetDir = path.join(rootDir, 'rivet');
  fs.mkdirSync(rivetDir);

  assert.equal(isExternalRivetWorkspace(rootDir, rivetDir), false);
  const yarnEnvironment = getRivetYarnEnvironment(rootDir, rivetDir);
  assert.equal(yarnEnvironment.YARN_NODE_LINKER, 'node-modules');
  assert.equal(yarnEnvironment.NODE_OPTIONS, stripPnpNodeOptions(process.env.NODE_OPTIONS));
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
  assert.equal(stripPnpNodeOptions('-r /workspace/.pnp.cjs --trace-warnings'), '--trace-warnings');
  assert.equal(stripPnpNodeOptions('--loader file:///workspace/.pnp.loader.mjs --inspect'), '--inspect');
  assert.equal(stripPnpNodeOptions('--require ./instrumentation.cjs'), '--require ./instrumentation.cjs');
});

test('wrapper and embedded snapshots persist node-modules without changing linked checkouts', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-linker-config-'));
  const wrapperRootDir = path.join(baseDir, 'wrapper');
  const embeddedRivetDir = path.join(wrapperRootDir, 'rivet');
  const externalRivetDir = path.join(baseDir, 'upstream');

  try {
    for (const workspaceDir of [wrapperRootDir, embeddedRivetDir, externalRivetDir]) {
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, '.yarnrc.yml'), 'nodeLinker: pnp\npnpEnableEsmLoader: true\n');
    }

    assert.equal(ensureWorkspaceNodeModulesConfig(wrapperRootDir), true);
    assert.equal(ensureWorkspaceNodeModulesConfig(wrapperRootDir), false);
    assertNodeModulesConfig(wrapperRootDir);

    assert.equal(ensureEmbeddedRivetNodeModulesConfig(wrapperRootDir, embeddedRivetDir), true);
    assert.equal(ensureEmbeddedRivetNodeModulesConfig(wrapperRootDir, embeddedRivetDir), false);
    assertNodeModulesConfig(embeddedRivetDir);

    assert.equal(ensureEmbeddedRivetNodeModulesConfig(wrapperRootDir, externalRivetDir), false);
    assert.equal(readYarnrc(externalRivetDir), 'nodeLinker: pnp\npnpEnableEsmLoader: true\n');
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

test('wrapper and embedded snapshots discard PnP loaders without touching linked workspaces or install state', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-pnp-cleanup-'));
  const wrapperRootDir = path.join(baseDir, 'wrapper');
  const embeddedRivetDir = path.join(wrapperRootDir, 'rivet');
  const externalRivetDir = path.join(baseDir, 'upstream');

  try {
    for (const workspaceDir of [wrapperRootDir, embeddedRivetDir, externalRivetDir]) {
      fs.mkdirSync(path.join(workspaceDir, '.yarn'), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, '.pnp.cjs'), 'loader');
      fs.writeFileSync(path.join(workspaceDir, '.pnp.loader.mjs'), 'loader');
      fs.writeFileSync(path.join(workspaceDir, '.yarn', 'install-state.gz'), 'state');
    }

    assert.equal(clearPnpLoaders(wrapperRootDir), true);
    assert.equal(clearPnpLoaders(wrapperRootDir), false);
    assert.equal(fs.existsSync(path.join(wrapperRootDir, '.pnp.cjs')), false);
    assert.equal(fs.existsSync(path.join(wrapperRootDir, '.pnp.loader.mjs')), false);
    assert.equal(fs.existsSync(path.join(wrapperRootDir, '.yarn', 'install-state.gz')), true);

    assert.equal(clearEmbeddedRivetPnpLoaders(wrapperRootDir, embeddedRivetDir), true);
    assert.equal(clearEmbeddedRivetPnpLoaders(wrapperRootDir, embeddedRivetDir), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.cjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.pnp.loader.mjs')), false);
    assert.equal(fs.existsSync(path.join(embeddedRivetDir, '.yarn', 'install-state.gz')), true);

    assert.equal(clearEmbeddedRivetPnpLoaders(wrapperRootDir, externalRivetDir), false);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.cjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.pnp.loader.mjs')), true);
    assert.equal(fs.existsSync(path.join(externalRivetDir, '.yarn', 'install-state.gz')), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
