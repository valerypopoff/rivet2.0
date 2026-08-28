import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const pluginInstaller = await import('../routes/plugin-installer.js');

test('plugin installer encodes scoped package metadata URLs', () => {
  assert.equal(
    pluginInstaller.getPluginRegistryMetadataUrl('@scope/example-plugin', 'latest'),
    'https://registry.npmjs.org/%40scope%2Fexample-plugin/latest',
  );
});

test('plugin installer rejects invalid package names and tags', () => {
  assert.throws(() => pluginInstaller.normalizePluginPackageName('../plugin'), /Invalid plugin package name/);
  assert.throws(() => pluginInstaller.normalizePluginTag('../latest'), /Invalid plugin tag/);
  assert.throws(() => pluginInstaller.normalizePluginTag('feature/test'), /Invalid plugin tag/);
});

test('plugin preparation is deduplicated and accepts complete skip-install caches', async () => {
  const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-plugin-cache-'));
  const previousAppDataRoot = process.env.RIVET_APP_DATA_ROOT;
  const originalFetch = globalThis.fetch;
  process.env.RIVET_APP_DATA_ROOT = appDataRoot;
  const pluginDir = pluginInstaller.getPluginDir('example-plugin', 'latest');
  const packageDir = path.join(pluginDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    version: '1.2.3',
    rivet: { skipInstall: true },
  }));
  fs.writeFileSync(path.join(packageDir, '.install_complete_version'), 'latest');
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ version: '1.2.3' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const logs: string[] = [];
    await Promise.all([
      pluginInstaller.ensurePluginReady('example-plugin', 'latest', (message) => logs.push(message)),
      pluginInstaller.ensurePluginReady('example-plugin', 'latest', (message) => logs.push(message)),
    ]);
    assert.equal(fetches, 1);
    assert.equal(logs.some((message) => message.includes('already in progress')), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAppDataRoot == null) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousAppDataRoot;
    fs.rmSync(appDataRoot, { recursive: true, force: true });
  }
});
