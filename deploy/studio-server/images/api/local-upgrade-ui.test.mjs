import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { loadUiUpgradeEnvironment, prepareUiUpgrade, uiPreparationAvailable } from './local-upgrade-ui.mjs';

// test-style: fixture-read: reads only private configuration and bindings generated in owned temporary fixtures.
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ui-preparation-'));
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '',
    RIVET_LOCAL_METADATA_UI_ROOT: path.join(root, 'control'),
    RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
    RIVET_APP_DATA_ROOT: path.join(root, 'app-data'),
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
  };
  for (const key of [
    'RIVET_LOCAL_METADATA_UI_ROOT',
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
  ])
    await fs.mkdir(env[key]);
  try {
    await run(env);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const success = [process.execPath, '-e', 'process.exit(0)'];

test('explicit preparation retains one private key across reload and never rewrites deployment environment', async () => {
  await fixture(async (env) => {
    assert.equal(loadUiUpgradeEnvironment(env), env);
    assert.equal(uiPreparationAvailable(env), true);
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(configured.RIVET_LOCAL_METADATA_UPGRADE_ENABLED, '1');
    assert.match(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
    assert.equal(env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, '');
    assert.deepEqual(loadUiUpgradeEnvironment(env), configured);
    assert.deepEqual(await prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)']), configured);
    if (process.platform !== 'win32')
      assert.equal(
        (await fs.stat(path.join(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, 'ui-configuration.json'))).mode & 0o777,
        0o600,
      );
    assert.throws(
      () => loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_ENCRYPTION_KEY: 'replacement' }),
      /differs/,
    );
    assert.throws(
      () => loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_WORKFLOWS_ROOT }),
      /differs/,
    );
  });
});
test('failed offline provisioning can retry only its owned preparing record without replacing the key', async () => {
  await fixture(async (env) => {
    await assert.rejects(prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)']), /provisioning failed/);
    const file = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json');
    const before = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(before.phase, 'preparing');
    assert.equal(loadUiUpgradeEnvironment(env), env);
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, before.key);
  });
});
test('lost control volume or corrupted binding cannot silently return a migrated installation to legacy', async () => {
  await fixture(async (env) => {
    const configured = await prepareUiUpgrade(env, success);
    await fs.rm(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, { recursive: true });
    assert.throws(() => loadUiUpgradeEnvironment(env), /missing or differs/);
    await assert.rejects(prepareUiUpgrade(env, success), /missing or differs/);
  });
});
test('interrupted ready publication reuses only the original private configuration', async () => {
  await fixture(async (env) => {
    await assert.rejects(prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)']), /provisioning failed/);
    const file = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    const next = `${file}.next`;
    await fs.writeFile(next, JSON.stringify({ ...value, phase: 'ready', key: 'a'.repeat(64) }), { mode: 0o600 });
    await assert.rejects(prepareUiUpgrade(env, success), /publication differs/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).key, value.key);
    await fs.writeFile(next, JSON.stringify({ ...value, phase: 'ready' }));
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, value.key);
    await assert.rejects(fs.stat(next), { code: 'ENOENT' });
  });
});

test('manual, unknown, replicated, overlapping and symlinked roots are not auto-provisioned', async () => {
  await fixture(async (env) => {
    assert.equal(
      uiPreparationAvailable({ ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_LOCAL_METADATA_UI_ROOT }),
      false,
    );
    assert.equal(uiPreparationAvailable({ ...env, RIVET_DEPLOYMENT_TOPOLOGY: 'replicated' }), false);
    await fs.writeFile(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'transition.sqlite'), 'unknown');
    assert.equal(uiPreparationAvailable(env), false);
    await assert.rejects(prepareUiUpgrade(env, success), /fresh or owned/);
    await fs.unlink(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'transition.sqlite'));
    await assert.rejects(
      prepareUiUpgrade({ ...env, RIVET_LOCAL_METADATA_UI_ROOT: env.RIVET_WORKFLOWS_ROOT }, success),
      /outside/,
    );
    assert.deepEqual(await fs.readdir(env.RIVET_WORKFLOWS_ROOT), []);
    assert.throws(() => loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_UI_ROOT: 'relative' }), /absolute/);
    if (process.platform !== 'win32') {
      const link = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed');
      await fs.symlink(env.RIVET_WORKFLOWS_ROOT, link);
      assert.throws(() => loadUiUpgradeEnvironment(env), /real directory/);
    }
  });
});
