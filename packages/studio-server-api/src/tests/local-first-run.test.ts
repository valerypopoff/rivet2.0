import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { initializeEmptyLocalInstallation } from '../local-metadata/initialize-empty-installation.js';

const { initializeNewLocalStorage, loadUiUpgradeEnvironment } = await import(
  new URL('../../../../deploy/studio-server/images/api/local-upgrade-ui.mjs', import.meta.url).href
);
// test-style: fixture-read: reads only first-run records and storage artifacts generated in owned temporary fixtures.
test('real first start selects SQLite, serves file artifacts and survives restart without legacy metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-first-run-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const volume = path.join(root, 'control');
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_WORKFLOW_STORAGE_BACKEND: 'filesystem',
    RIVET_DEPLOYMENT_STORAGE_MODE: '',
    RIVET_LOCAL_METADATA_UI_ROOT: volume,
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '',
    RIVET_WORKFLOWS_ROOT: source.workflows,
    RIVET_WORKFLOW_RECORDINGS_ROOT: source.recordings,
    RIVET_APP_DATA_ROOT: source.appData,
    RIVET_RUNTIME_LIBRARIES_ROOT: source.runtimeLibraries,
    RIVET_EXTRA_ROOTS: root,
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_KEY: 'first-run-fixture',
    RIVET_VM_MIGRATION_EDITOR_CONTROL: '1',
  };
  try {
    for (const directory of [volume, ...Object.values(source)]) await fs.mkdir(directory);
    const command = [
      process.execPath,
      '--import',
      'tsx',
      fileURLToPath(new URL('../scripts/local-metadata-control.ts', import.meta.url)),
      '--initialize-empty',
    ];
    const configured = await initializeNewLocalStorage(env, command);
    const journal = new LocalMetadataTransitionJournal(
      path.join(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, 'transition.sqlite'),
    );
    await journal.initialize({ readOnly: true });
    const state = journal.read();
    journal.close();
    assert.equal(state.phase, 'sqlite-live');
    // Re-run the offline step as if it died just before publishing ready.
    const configPath = path.join(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, 'ui-configuration.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...config, phase: 'initializing' }));
    // Retained selection evidence cannot be recreated merely because the
    // original sources are still empty and initialization is unpublished.
    for (const [name, error] of [
      ['transition.sqlite', /journal was lost/],
      ['upgrade.sqlite', /certificate ledger was lost/],
    ] as const) {
      const file = path.join(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, name);
      const before = await fs.readFile(file);
      await fs.unlink(file);
      await assert.rejects(
        initializeEmptyLocalInstallation(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, source),
        error,
      );
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      await fs.writeFile(file, before, { mode: 0o600 });
    }
    await initializeNewLocalStorage(env, command);
    const run = async (mode: string, helper = './helpers/local-first-run-runtime.ts') =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL(helper, import.meta.url)), mode],
        {
          timeout: mode === 'supervised' ? 90000 : 45000,
          maxBuffer: 1024 * 1024,
          env: {
            ...configured,
            RIVET_LOCAL_METADATA_SUPERVISED: '1',
            RIVET_LOCAL_METADATA_BOOT_GENERATION: state.generation!.id,
            RIVET_LOCAL_METADATA_BOOT_REVISION: String(state.revision),
          },
        },
      );
    await run('write');
    assert.deepEqual(loadUiUpgradeEnvironment(env), configured);
    // Ordinary startup after real writes must never run empty initialization.
    await initializeNewLocalStorage(env, [process.execPath, '-e', 'process.exit(1)']);
    await run('read');
    if (process.platform !== 'win32') await run('supervised', './helpers/local-upgrade-runtime.ts');
    assert.deepEqual(await fs.readdir(source.workflows), []);
    assert.equal((await fs.readdir(source.appData)).includes('settings'), false);
    // Even the internal command refuses a retained source; no automatic import.
    await fs.mkdir(path.join(source.workflows, 'legacy-folder'));
    await fs.writeFile(configPath, JSON.stringify({ ...config, phase: 'initializing' }));
    await assert.rejects(
      initializeEmptyLocalInstallation(configured.RIVET_LOCAL_METADATA_CONTROL_ROOT, source),
      /Retained source data/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
