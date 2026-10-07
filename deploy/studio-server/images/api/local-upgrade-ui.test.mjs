import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fileSystem from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  loadUiUpgradeEnvironment,
  prepareUiUpgrade,
  rememberManualControlRoot,
  uiPreparationAvailable,
  initializeNewLocalStorage,
} from './local-upgrade-ui.mjs';

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

test(
  'cancelled offline setup stops its writer, retains identity and never publishes ready',
  { timeout: 20_000 },
  async () => {
    for (const fresh of [false, true]) {
      await fixture(async (env) => {
        const cancellation = new AbortController();
        const marker = path.join(path.dirname(env.RIVET_LOCAL_METADATA_UI_ROOT), 'writer-pid');
        const pending = prepareUiUpgrade(
          env,
          [
            process.execPath,
            '-e',
            `
        process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(process.argv[1], String(process.pid));
        setTimeout(() => process.exit(0), 5000);
      `,
            marker,
          ],
          { fresh, signal: cancellation.signal, shutdownTimeoutMs: 1000 },
        );
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        const deadline = Date.now() + 5000;
        let pid;
        while (!pid) {
          try {
            pid = Number(await fs.readFile(marker, 'utf8'));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          assert.ok(Date.now() < deadline, 'offline writer did not start');
          if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(Number.isInteger(pid) && pid > 0);
        const configFile = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json');
        const original = await fs.readFile(configFile);
        cancellation.abort();
        await rejected;
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        assert.deepEqual(await fs.readFile(configFile), original);
        await assert.rejects(fs.stat(`${configFile}.next`), { code: 'ENOENT' });
        await prepareUiUpgrade(env, success, { fresh });
        assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).phase, 'ready');
      });
    }
    await fixture(async (env) => {
      await assert.rejects(initializeNewLocalStorage(env, success, { signal: AbortSignal.abort() }), {
        name: 'AbortError',
      });
      assert.deepEqual(await fs.readdir(env.RIVET_LOCAL_METADATA_UI_ROOT), []);
      assert.deepEqual(await fs.readdir(env.RIVET_APP_DATA_ROOT), []);
    });
  },
);

test('empty installations initialize once before serving; retained entries never trigger automatic initialization', async () => {
  await fixture(async (env) => {
    const loaded = await initializeNewLocalStorage(env, success);
    assert.equal(loaded.RIVET_LOCAL_METADATA_CONTROL_ROOT, path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed'));
    assert.deepEqual(await initializeNewLocalStorage(env, [process.execPath, '-e', 'process.exit(1)']), loaded);
  });
  for (const key of [
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
  ]) {
    await fixture(async (env) => {
      await fs.mkdir(path.join(env[key], 'retained-empty-folder'));
      const loaded = await initializeNewLocalStorage(env, [process.execPath, '-e', 'process.exit(1)']);
      assert.equal(loaded.RIVET_LOCAL_METADATA_CONTROL_ROOT, '');
      assert.equal(fileSystem.existsSync(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed')), false);
    });
  }
});

test('interrupted fresh initialization cannot serve legacy or be replaced by legacy provisioning', async () => {
  await fixture(async (env) => {
    await assert.rejects(
      initializeNewLocalStorage(env, [process.execPath, '-e', 'process.exit(1)']),
      /provisioning failed/,
    );
    await assert.rejects(prepareUiUpgrade(env, success), /cannot replace each other/);
    const configured = await initializeNewLocalStorage(env, success);
    assert.equal(
      loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_CONTROL_ROOT,
      configured.RIVET_LOCAL_METADATA_CONTROL_ROOT,
    );
  });
});

test('explicit managed storage and replicated deployments skip automatic local initialization', async () => {
  for (const override of [
    { RIVET_DEPLOYMENT_TOPOLOGY: 'replicated' },
    { RIVET_DEPLOYMENT_STORAGE_MODE: 'managed' },
    { RIVET_WORKFLOW_STORAGE_BACKEND: 'managed' },
  ]) {
    await fixture(async (env) => {
      const configured = await initializeNewLocalStorage({ ...env, ...override }, [
        process.execPath,
        '-e',
        'process.exit(1)',
      ]);
      assert.equal(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, '');
      assert.equal(fileSystem.existsSync(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed')), false);
    });
  }
});

test('interrupted fresh initialization never falls back to legacy when preparation becomes unavailable', async () => {
  await fixture(async (env) => {
    await assert.rejects(initializeNewLocalStorage(env, [process.execPath, '-e', 'process.exit(1)']));
    await fs.writeFile(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'unexpected-entry'), 'retained');
    assert.equal(uiPreparationAvailable(env), false);
    await assert.rejects(initializeNewLocalStorage(env, success), /fresh or owned/);
    const value = JSON.parse(
      await fs.readFile(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json'), 'utf8'),
    );
    assert.equal(value.phase, 'initializing');
  });
});

test('an incomplete owned configuration rejects conflicting deployment roots before serving', async () => {
  for (const fresh of [false, true]) {
    await fixture(async (env) => {
      await assert.rejects(prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)'], { fresh }));
      const conflicting = { ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_LOCAL_METADATA_UI_ROOT };
      assert.throws(() => loadUiUpgradeEnvironment(conflicting), /differs/);
      await assert.rejects(initializeNewLocalStorage(conflicting, success), /differs/);
    });
  }
});

test('preparation selects persistent storage without an encryption key or user environment configuration', async () => {
  await fixture(async (env) => {
    assert.equal(loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_UPGRADE_ENABLED, '1');
    assert.equal(uiPreparationAvailable(env), true);
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(configured.RIVET_LOCAL_METADATA_UPGRADE_ENABLED, '1');
    assert.equal(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, '');
    assert.equal(env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, '');
    assert.deepEqual(loadUiUpgradeEnvironment(env), configured);
    assert.deepEqual(await prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)']), configured);
    if (process.platform !== 'win32')
      assert.equal(
        (await fs.stat(path.join(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, 'ui-configuration.json'))).mode & 0o777,
        0o600,
      );
    assert.equal(
      loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_ENCRYPTION_KEY: 'retired-unused-value' })
        .RIVET_LOCAL_METADATA_ENCRYPTION_KEY,
      '',
    );
    assert.throws(
      () => loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_WORKFLOWS_ROOT }),
      /differs/,
    );
  });
});
test('failed provisioning retries only its owned preparing record without replacing installation identity', async () => {
  await fixture(async (env) => {
    await assert.rejects(prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)']), /provisioning failed/);
    const file = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json');
    const before = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(before.phase, 'preparing');
    assert.equal(loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_CONTROL_ROOT, '');
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).installationId, before.installationId);
    assert.equal(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, '');
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
    await fs.writeFile(next, JSON.stringify({ ...value, phase: 'ready', installationId: 'a'.repeat(36) }), {
      mode: 0o600,
    });
    await assert.rejects(prepareUiUpgrade(env, success), /publication differs/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).installationId, value.installationId);
    await fs.writeFile(next, JSON.stringify({ ...value, phase: 'ready' }));
    const configured = await prepareUiUpgrade(env, success);
    assert.equal(configured.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, '');
    await assert.rejects(fs.stat(next), { code: 'ENOENT' });
  });
});

test('empty and partially written private publication files retry without replacing identity', async () => {
  for (const fresh of [false, true]) {
    for (const length of [0, 12, 70]) {
      await fixture(async (env) => {
        await assert.rejects(prepareUiUpgrade(env, [process.execPath, '-e', 'process.exit(1)'], { fresh }));
        const file = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json');
        const before = JSON.parse(await fs.readFile(file, 'utf8'));
        const ready = { ...before, phase: 'ready' };
        await fs.writeFile(`${file}.next`, JSON.stringify(ready).slice(0, length), { mode: 0o600 });
        await prepareUiUpgrade(env, success, { fresh });
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), ready);
        await assert.rejects(fs.stat(`${file}.next`), { code: 'ENOENT' });
      });
    }
  }
});

test('old UI-managed keys remain available for compatibility after removing all three user variables', async () => {
  await fixture(async (env) => {
    const root = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed');
    const key = 'a'.repeat(64);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'ui-configuration.json'), JSON.stringify({ version: 1, phase: 'ready', key }), {
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-ui-control.json'),
      JSON.stringify({ version: 1, root, keyId: createHash('sha256').update(key).digest('hex') }),
      { mode: 0o600 },
    );
    delete env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
    delete env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
    delete env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED;
    const loaded = loadUiUpgradeEnvironment(env);
    assert.equal(loaded.RIVET_LOCAL_METADATA_CONTROL_ROOT, root);
    assert.equal(loaded.RIVET_LOCAL_METADATA_ENCRYPTION_KEY, key);
    assert.equal(loaded.RIVET_LOCAL_METADATA_UPGRADE_ENABLED, '1');
  });
});

test('the original manual volume root is discovered without selecting a new empty journal', async () => {
  await fixture(async (env) => {
    await fs.writeFile(path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'transition.sqlite'), 'existing journal fixture');
    delete env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
    delete env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY;
    delete env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED;
    assert.equal(loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_CONTROL_ROOT, env.RIVET_LOCAL_METADATA_UI_ROOT);
    assert.equal(uiPreparationAvailable(env), false);
    assert.deepEqual(await fs.readdir(env.RIVET_LOCAL_METADATA_UI_ROOT), ['transition.sqlite']);
  });
});

test('validated custom manual roots survive removing the root variable and fail closed if lost', async () => {
  await fixture(async (env) => {
    const custom = path.join(path.dirname(env.RIVET_LOCAL_METADATA_UI_ROOT), 'custom-control');
    await fs.mkdir(custom);
    rememberManualControlRoot({ ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: custom });
    delete env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
    assert.equal(loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_CONTROL_ROOT, custom);
    assert.equal(uiPreparationAvailable(env), false);
    assert.throws(
      () => loadUiUpgradeEnvironment({ ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_LOCAL_METADATA_UI_ROOT }),
      /differs/,
    );
    const pointer = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'manual-control.json');
    const bytes = await fs.readFile(pointer);
    await fs.unlink(pointer);
    assert.throws(() => loadUiUpgradeEnvironment(env), /missing or differs/);
    await fs.writeFile(pointer, bytes, { mode: 0o600 });
    await fs.rmdir(custom);
    assert.throws(() => loadUiUpgradeEnvironment(env), { code: 'ENOENT' });
    await assert.rejects(prepareUiUpgrade(env, success));
  });
});

test('remembered manual roots refuse a lost independent App Data binding instead of recreating it', async () => {
  await fixture(async (env) => {
    const configured = { ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_LOCAL_METADATA_UI_ROOT };
    rememberManualControlRoot(configured);
    const marker = path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-manual-control.json');
    await fs.unlink(marker);
    assert.throws(() => loadUiUpgradeEnvironment(env), /binding/);
    assert.throws(() => rememberManualControlRoot(configured), /binding/);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  });
});

test('interrupted manual-root publication retries only the original independent binding', async (context) => {
  await fixture(async (env) => {
    const configured = { ...env, RIVET_LOCAL_METADATA_CONTROL_ROOT: env.RIVET_LOCAL_METADATA_UI_ROOT };
    const pointer = path.join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'manual-control.json');
    const originalOpen = fileSystem.openSync;
    const injected = context.mock.method(fileSystem, 'openSync', (file, ...args) => {
      if (file === pointer) throw Object.assign(new Error('injected disk error'), { code: 'ENOSPC' });
      return originalOpen(file, ...args);
    });
    assert.throws(() => rememberManualControlRoot(configured), { code: 'ENOSPC' });
    injected.mock.restore();
    const marker = path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-manual-control.json');
    const originalBinding = await fs.readFile(marker);
    rememberManualControlRoot(configured);
    assert.deepEqual(await fs.readFile(marker), originalBinding);
    assert.equal(loadUiUpgradeEnvironment(env).RIVET_LOCAL_METADATA_CONTROL_ROOT, env.RIVET_LOCAL_METADATA_UI_ROOT);
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
