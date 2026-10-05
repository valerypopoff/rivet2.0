import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BACKUP_DOMAINS,
  assertNoBackupWriters,
  createLocalUpgradeBackup,
  restoreLocalUpgradeBackup,
  verifyLocalUpgradeBackup,
  scanBackupRoot,
  createFreshBackupDirectory,
} from './local-upgrade-backup.mjs';
import {
  inspectRestoredRehearsal,
  restoredOperatorRequestScript,
  createRestoredContainerTracker,
  assertRestoredSourceFingerprint,
  resumeRestoredLegacyFenced,
  RESTORED_REHEARSAL_PHASES,
  RESTORED_REHEARSAL_STEPS,
  assertRestoredRehearsalResult,
  redactedRestoredFailureStep,
  withRestoredRehearsalInterruptions,
  restoredReadinessProbeScript,
} from './local-upgrade-restored-rehearsal.mjs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { assertLocalOperationalSchema } from '../../../packages/studio-server-api/src/local-metadata/operational-schema.ts';

const operationalSchemas = {
  'evaluation-runs.sqlite': {
    evaluation_library: ['singleton_key', 'revision', 'library_json', 'updated_at_ms'],
    evaluation_library_imports: ['source_fingerprint', 'imported_at_ms'],
    evaluation_runs: ['project_id', 'run_id', 'suite_id', 'started_at', 'run_json', 'updated_at_ms'],
    evaluation_recordings: ['project_id', 'recording_id', 'run_id', 'artifact_json', 'created_at_ms'],
    evaluation_dataset_snapshots: ['project_id', 'dataset_fingerprint', 'snapshot_json', 'created_at_ms'],
    evaluation_deleted_projects: ['project_id', 'deleted_at_ms'],
  },
  'llm-profile-health.sqlite': { llm_profile_health: ['key', 'project_id', 'entry_json', 'updated_at_ms'] },
};

function restoredReceipt() {
  const expected = {
    imageId: 'sha256:' + 'a'.repeat(64),
    backupReceipt: 'b'.repeat(64),
    memoryMiB: 1024,
    cpus: 1,
  };
  const result = {
    passed: true,
    cleanupFailed: false,
    retainedContainers: [],
    finalSourceWritesPaused: true,
    requiresSeparateControlledFunctionalRehearsal: true,
    imageId: expected.imageId,
    backupReceipt: expected.backupReceipt,
    memoryLimitMiB: expected.memoryMiB,
    cpus: expected.cpus,
    frozenSourceFingerprint: 'c'.repeat(64),
    container: 'rivet-restored-rehearsal-12345678-1234-1234-1234-123456789abc',
    sampledPeakMemoryBytes: 12.3 * 1048576,
    phases: RESTORED_REHEARSAL_PHASES.map((phase) => ({
      phase,
      checkedAt: '2026-09-28T12:00:00.000Z',
    })),
  };
  return { result, expected };
}

test('restored gate requires complete ordered recovery evidence bound to backup, image and limits', () => {
  const { result, expected } = restoredReceipt();
  assertRestoredRehearsalResult(result, expected);
  for (const change of [
    { passed: false },
    { cleanupFailed: true },
    { retainedContainers: ['owned-but-running'] },
    { finalSourceWritesPaused: false },
    { requiresSeparateControlledFunctionalRehearsal: false },
    { imageId: 'sha256:' + 'd'.repeat(64) },
    { backupReceipt: 'e'.repeat(64) },
    { memoryLimitMiB: 2048 },
    { cpus: 2 },
    { frozenSourceFingerprint: null },
    { container: 'ops-api-1' },
    { sampledPeakMemoryBytes: 0 },
    { sampledPeakMemoryBytes: Infinity },
    { sampledPeakMemoryBytes: '1024' },
    { phases: [] },
    { phases: result.phases.slice(1) },
    { phases: [...result.phases, result.phases[0]] },
    { phases: [...result.phases].reverse() },
  ])
    assert.throws(() => assertRestoredRehearsalResult({ ...result, ...change }, expected));
});

test('restored gate refuses malformed or credential-bearing phase entries before public reporting', () => {
  const { result, expected } = restoredReceipt();
  for (const change of [
    { phase: 'unknown-phase' },
    { checkedAt: 'not-a-date' },
    { checkedAt: 1790425236 },
    { rawOutput: 'fixture secret: never publish' },
  ]) {
    const changed = structuredClone(result);
    Object.assign(changed.phases[0], change);
    assert.throws(() => assertRestoredRehearsalResult(changed, expected));
  }
  for (const change of [{ imageId: 'api:latest' }, { backupReceipt: 'edited' }])
    assert.throws(() => assertRestoredRehearsalResult(result, { ...expected, ...change }));
});

test('failed restored gate reports only a receipt-bound fixed operation name', () => {
  const { result, expected } = restoredReceipt();
  const failed = { ...result, passed: false, failureStep: 'initial-restart', rawError: 'secret value' };
  assert.equal(redactedRestoredFailureStep(failed, expected), 'initial-restart');
  for (const change of [
    { passed: true },
    { imageId: 'sha256:' + 'd'.repeat(64) },
    { backupReceipt: 'e'.repeat(64) },
    { failureStep: 'secret value' },
  ])
    assert.equal(redactedRestoredFailureStep({ ...failed, ...change }, expected), null);
  assert.ok(RESTORED_REHEARSAL_STEPS.includes(failed.failureStep));
});

test('interruptions abort foreground launches but still stop owned clones and remove signal handlers', async () => {
  for (const event of ['SIGINT', 'SIGTERM']) {
    const events = new EventEmitter();
    const owner = 'isolated-fixture';
    const cleaned = [];
    await assert.rejects(
      withRestoredRehearsalInterruptions(async (signal) => {
        const tracker = createRestoredContainerTracker(
          async () => {
            // A Docker CLI can be interrupted after the daemon created it.
            events.emit(event);
            events.emit(event);
            signal.throwIfAborted();
          },
          owner,
          async (args) => {
            assert.equal(signal.aborted, true);
            cleaned.push(args);
            return {
              stdout: JSON.stringify([
                {
                  Id: 'a'.repeat(64),
                  Config: { Labels: { 'rivet.local-upgrade.restored': owner } },
                  State: { Running: true },
                },
              ]),
            };
          },
        );
        try {
          await tracker.start(['image']);
        } finally {
          assert.deepEqual(await tracker.cleanup(false), { failed: false, retained: [owner] });
        }
      }, events),
      /interrupted/,
    );
    assert.deepEqual(cleaned, [
      ['inspect', owner],
      ['stop', '--time', '150', 'a'.repeat(64)],
    ]);
    assert.equal(events.listenerCount('SIGINT'), 0);
    assert.equal(events.listenerCount('SIGTERM'), 0);
  }
  const events = new EventEmitter();
  assert.equal(await withRestoredRehearsalInterruptions(async () => 'finished', events), 'finished');
  assert.equal(events.listenerCount('SIGINT'), 0);
  assert.equal(events.listenerCount('SIGTERM'), 0);
});

test(
  'real Linux process signals finish ownership-checked cleanup before exiting nonzero',
  {
    skip: process.platform === 'win32' ? 'Windows kill does not deliver POSIX signals.' : false,
  },
  async () => {
    const helper = new URL('./local-upgrade-restored-rehearsal.mjs', import.meta.url).href;
    for (const interruption of ['SIGINT', 'SIGTERM']) {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import {withRestoredRehearsalInterruptions,createRestoredContainerTracker} from ${JSON.stringify(helper)};
      const owner='generated-signal-fixture';
      await withRestoredRehearsalInterruptions(async signal=>{
        const tracker=createRestoredContainerTracker(async()=>{
          console.log('READY');
          await new Promise((resolve,reject)=>{
            const keepAlive=setInterval(()=>{},1000);
            signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(signal.reason);},{once:true});
          });
        },owner,async args=>{
          console.log(JSON.stringify(args));
          return {stdout:JSON.stringify([{Id:'a'.repeat(64),Config:{Labels:{'rivet.local-upgrade.restored':owner}},State:{Running:true}}])};
        });
        try {await tracker.start(['generated-image']);}
        finally {console.log(JSON.stringify(await tracker.cleanup(false)));}
      }).catch(()=>{process.exitCode=1;});
    `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Signal fixture did not start.')), 10_000);
          child.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.includes('READY')) {
              clearTimeout(timer);
              resolve();
            }
          });
          exit.then(() => {
            clearTimeout(timer);
            reject(new Error('Signal fixture exited before readiness.'));
          }, reject);
        });
        assert.equal(child.kill(interruption), true);
        const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
        let ended;
        try {
          ended = await exit;
        } finally {
          clearTimeout(timeout);
        }
        assert.deepEqual(ended, { code: 1, signal: null });
        assert.ok(output.includes('["inspect","generated-signal-fixture"]'));
        assert.ok(output.includes(`["stop","--time","150","${'a'.repeat(64)}"]`));
        assert.ok(output.includes('{"failed":false,"retained":["generated-signal-fixture"]}'));
        assert.ok(!output.includes('["rm"'));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit;
      }
    }
  },
);

// test-style: fixture-read: only generated temporary backup manifests and files.
async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-backup-tools-'));
  const roots = Object.fromEntries(BACKUP_DOMAINS.map((domain) => [domain, path.join(root, domain)]));
  try {
    for (const directory of Object.values(roots)) await fs.mkdir(directory);
    await fs.mkdir(path.join(roots.workflows, 'empty'));
    await fs.writeFile(path.join(roots.workflows, 'project'), 'immutable project');
    await fs.writeFile(path.join(roots.appData, 'evaluation-runs.sqlite-wal'), 'committed wal');
    await fs.writeFile(path.join(roots.runtimeLibraries, 'package'), 'library');
    await callback({ root, roots, destination: path.join(root, 'backup'), assertFrozen: async () => {} });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('backup and independent restore compare exact bytes, empty folders, modes and SQLite side files', async () => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    assert.equal(copied.files, 3);
    await verifyLocalUpgradeBackup(options.destination, copied.receipt);
    const restored = path.join(options.root, 'restored');
    await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
    assert.equal(
      await fs.readFile(path.join(restored, 'appData', 'evaluation-runs.sqlite-wal'), 'utf8'),
      'committed wal',
    );
    const plan = await inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 });
    assert.equal(plan.network, 'none');
    assert.deepEqual(plan.publishedPorts, []);
    await fs.writeFile(path.join(restored, 'workflows', 'project'), 'changed');
    await assert.rejects(
      inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }),
      /drifted/,
    );
    await verifyLocalUpgradeBackup(options.destination, copied.receipt);
  });
});

test('restored preflight refuses physically aliased authority roots before scanning content', async (t) => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    const restored = path.join(options.root, 'restored');
    await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
    const originalStat = fs.stat.bind(fs);
    // Model directory-bind aliases without requiring privileged test mounts.
    t.mock.method(fs, 'stat', (file, ...args) =>
      originalStat(file === path.join(restored, 'recordings') ? path.join(restored, 'appData') : file, ...args),
    );
    await assert.rejects(
      inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }),
      /physically overlap/,
    );
  });
});

test('fresh rehearsal output refuses an aliased source subtree before creating a directory', async (t) => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    const restored = path.join(options.root, 'restored');
    await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
    const alias = path.join(options.root, 'aliased-output-parent');
    await fs.mkdir(alias);
    const output = path.join(alias, 'new-run');
    const originalStat = fs.stat.bind(fs);
    t.mock.method(fs, 'stat', (file, ...args) =>
      originalStat(file === alias ? path.join(restored, 'appData') : file, ...args),
    );
    await assert.rejects(
      createFreshBackupDirectory(output, [restored, ...BACKUP_DOMAINS.map((domain) => path.join(restored, domain))]),
      /aliases a source subtree/,
    );
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    await verifyLocalUpgradeBackup(options.destination, copied.receipt);
  });
});

test('readiness probe times out a real loopback server that never sends headers', async () => {
  let requests = 0;
  const server = http.createServer(() => requests++);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['-e', restoredReadinessProbeScript(500, server.address().port)], {
    stdio: 'ignore',
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    assert.deepEqual(await exit, { code: 1, signal: null });
    assert.equal(requests, 1, 'The probe must reach the stalled server, not fail before connecting.');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit.catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('operator login times out a real loopback server before any mutation request', async () => {
  let requests = 0;
  const server = http.createServer(() => requests++);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      vm.runInNewContext(`(async()=>{${restoredOperatorRequestScript('/pause', {})}})()`, {
        process: { env: { RIVET_KEY: 'generated-fixture-key' }, getBuiltinModule: process.getBuiltinModule },
        URLSearchParams,
        AbortSignal: { timeout: () => AbortSignal.timeout(500) },
        fetch: (url, options) => {
          assert.equal(url, 'http://127.0.0.1/ui-auth');
          return fetch(`http://127.0.0.1:${server.address().port}/`, options);
        },
      }),
      (error) => error.name === 'TimeoutError',
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('backup refuses unfrozen sources before creating a target', async () => {
  await fixture(async (options) => {
    await assert.rejects(
      createLocalUpgradeBackup({
        ...options,
        assertFrozen: async () => {
          throw Error('not frozen');
        },
      }),
      /not frozen/,
    );
    await assert.rejects(fs.stat(options.destination), /ENOENT/);
  });
});

async function sqliteFixture(options) {
  const control = path.join(options.root, 'control');
  const id = 'selected-generation';
  const generation = path.join(control, 'generations', id);
  await fs.mkdir(path.join(generation, 'operational'), { recursive: true });
  const bytes = Buffer.from('new writes after SQLite resumption');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(path.join(generation, 'objects', hash.slice(0, 2)), { recursive: true });
  await fs.writeFile(path.join(generation, 'objects', hash.slice(0, 2), hash), bytes);
  const certificate = {
    source: {
      workflows: '/workflows',
      recordings: '/workflow-recordings',
      appData: '/data/rivet-app',
      runtimeLibraries: '/data/runtime-libraries',
    },
    ...(options.plaintext ? {} : { encryptionKeyId: options.uiEncryptionKeyId || 'a'.repeat(64) }),
  };
  const journal = new DatabaseSync(path.join(control, 'transition.sqlite'));
  journal.exec(
    'PRAGMA application_id=0x5249544a; PRAGMA user_version=1; CREATE TABLE transition_state(singleton,revision,phase,generation_id); CREATE TABLE generations(id,proof_json)',
  );
  journal.prepare('INSERT INTO transition_state VALUES (1,8,?,?)').run('sqlite-live', id);
  journal
    .prepare('INSERT INTO generations VALUES (?,?)')
    .run(
      id,
      JSON.stringify({ id, reportHash: createHash('sha256').update(JSON.stringify(certificate)).digest('hex') }),
    );
  journal.close();
  const operator = new DatabaseSync(path.join(control, 'upgrade.sqlite'));
  operator.exec('PRAGMA application_id=0x52495550; CREATE TABLE certificates(generation_id,certificate_json)');
  operator.prepare('INSERT INTO certificates VALUES (?,?)').run(id, JSON.stringify(certificate));
  operator.close();
  const catalog = new DatabaseSync(path.join(generation, 'catalog.sqlite'));
  catalog.exec('PRAGMA application_id=0x52495643; PRAGMA user_version=2;');
  for (const table of ['projects', 'published_versions', 'web_apps', 'recordings', 'runtime_library_state'])
    catalog.exec('CREATE TABLE ' + table + ' (metadata_json TEXT)');
  catalog.prepare('INSERT INTO projects VALUES (?)').run(
    JSON.stringify({
      contents: { hash, size: bytes.length },
      datasetsContents: null,
      publishedContents: null,
      publishedDatasetsContents: null,
      marker: 'post-resumption',
    }),
  );
  catalog.close();
  const settings = new DatabaseSync(path.join(generation, 'settings.sqlite'));
  settings.exec(`PRAGMA application_id=0x52495654; PRAGMA user_version=${options.plaintext ? 2 : 1};`);
  settings.exec(`CREATE TABLE app_settings (
    setting_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
    ${
      options.plaintext
        ? 'value_json TEXT NOT NULL,'
        : `ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL CHECK (length(iv) = 12),
    auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
    key_id TEXT NOT NULL,`
    }
    source_hash TEXT,
    updated_at TEXT NOT NULL
  )`);
  if (options.plaintext)
    settings
      .prepare('INSERT INTO app_settings VALUES (?,?,?,?,?,?)')
      .run('general', 9, 1, JSON.stringify({ fixture: 'post-resumption' }), null, '2026-10-05T00:00:00.000Z');
  settings.close();
  for (const [name, tables] of Object.entries(operationalSchemas)) {
    const db = new DatabaseSync(path.join(generation, 'operational', name));
    try {
      for (const [table, columns] of Object.entries(tables)) db.exec(`CREATE TABLE ${table} (${columns.join(',')})`);
      // Keep standalone backup fixtures compatible with the serving contract.
      assertLocalOperationalSchema(db, name === 'evaluation-runs.sqlite' ? 'evaluations' : 'health');
    } finally {
      db.close();
    }
  }
  return { ...options, roots: { ...options.roots, control }, sqlite: true, generation, hash };
}
for (const plaintext of [false, true])
  test(`selected ${plaintext ? 'plaintext' : 'legacy'} backup restores post-resumption metadata, artifacts and control as one verified snapshot`, async () => {
    await fixture(async (options) => {
      const selected = await sqliteFixture({ ...options, plaintext });
      const copied = await createLocalUpgradeBackup(selected);
      const manifest = await verifyLocalUpgradeBackup(options.destination, copied.receipt);
      assert.equal(manifest.version, 2);
      assert.equal(manifest.selection.phase, 'sqlite-live');
      const restored = path.join(options.root, 'selected-restore');
      await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
      const db = new DatabaseSync(
        path.join(restored, 'control', 'generations', 'selected-generation', 'catalog.sqlite'),
        { readOnly: true },
      );
      assert.equal(
        JSON.parse(db.prepare('SELECT metadata_json FROM projects').get().metadata_json).marker,
        'post-resumption',
      );
      db.close();
      const settings = new DatabaseSync(
        path.join(restored, 'control', 'generations', 'selected-generation', 'settings.sqlite'),
        { readOnly: true },
      );
      try {
        assert.equal(settings.prepare('PRAGMA user_version').get().user_version, plaintext ? 2 : 1);
        if (plaintext) {
          const row = settings.prepare('SELECT revision,value_json FROM app_settings').get();
          assert.equal(row.revision, 9);
          assert.deepEqual(JSON.parse(row.value_json), { fixture: 'post-resumption' });
        }
      } finally {
        settings.close();
      }
      assert.equal(
        await fs.readFile(
          path.join(
            restored,
            'control',
            'generations',
            'selected-generation',
            'objects',
            selected.hash.slice(0, 2),
            selected.hash,
          ),
          'utf8',
        ),
        'new writes after SQLite resumption',
      );
      await assert.rejects(inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }));
    });
  });

test('selected settings backups reject unsupported schemas and invalid plaintext without exposing contents', async () => {
  for (const mutation of ['version', 'missing', 'extra', 'columns', 'json', 'array'])
    await fixture(async (options) => {
      const selected = await sqliteFixture({ ...options, plaintext: true });
      const db = new DatabaseSync(path.join(selected.generation, 'settings.sqlite'));
      try {
        if (mutation === 'version') db.exec('PRAGMA user_version=3');
        else if (mutation === 'missing') db.exec('DROP TABLE app_settings');
        else if (mutation === 'extra') db.exec('CREATE TABLE unrelated (value TEXT)');
        else if (mutation === 'columns')
          db.exec('DROP TABLE app_settings; CREATE TABLE app_settings (value_json TEXT)');
        else
          db.prepare('UPDATE app_settings SET value_json=?').run(
            mutation === 'json' ? 'private-password-broken-json' : '[]',
          );
      } finally {
        db.close();
      }
      await assert.rejects(createLocalUpgradeBackup(selected), (error) => {
        assert.match(error.message, /settings/i);
        assert.ok(!error.message.includes('private-password'));
        return true;
      });
      await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
    });
});

test('remembered manual control backups preserve both bindings and reject either missing or mismatched identity', async () => {
  for (const mutation of [null, 'pointer-missing', 'binding-missing', 'binding-wrong', 'pointer-wrong'])
    await fixture(async (options) => {
      const selected = await sqliteFixture({ ...options, plaintext: true });
      const pointer = path.join(selected.roots.control, 'manual-control.json');
      const binding = path.join(selected.roots.appData, 'local-metadata-manual-control.json');
      const contents = JSON.stringify({ version: 1, root: '/data/local-metadata' });
      await fs.writeFile(pointer, contents, { mode: 0o600 });
      await fs.writeFile(binding, contents, { mode: 0o600 });
      if (mutation) {
        if (mutation === 'pointer-missing') await fs.unlink(pointer);
        else if (mutation === 'binding-missing') await fs.unlink(binding);
        else
          await fs.writeFile(
            mutation === 'binding-wrong' ? binding : pointer,
            JSON.stringify({ version: 1, root: '/other-root' }),
          );
        await assert.rejects(createLocalUpgradeBackup(selected), /control|binding/i);
        await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
      } else {
        const copied = await createLocalUpgradeBackup(selected);
        const restored = path.join(options.root, 'manual-restore');
        await restoreLocalUpgradeBackup({
          backup: options.destination,
          receipt: copied.receipt,
          destination: restored,
        });
        assert.equal(await fs.readFile(path.join(restored, 'control', 'manual-control.json'), 'utf8'), contents);
        assert.equal(
          await fs.readFile(path.join(restored, 'appData', 'local-metadata-manual-control.json'), 'utf8'),
          contents,
        );
      }
    });
});
for (const layout of ['legacy-encrypted', 'legacy-plaintext', 'plaintext'])
  test(`UI-owned ${layout} backup preserves the complete volume and binding, not just nested databases`, async () => {
    await fixture(async (options) => {
      const key = 'b'.repeat(64);
      const selected = await sqliteFixture({
        ...options,
        plaintext: layout !== 'legacy-encrypted',
        uiEncryptionKeyId: createHash('sha256').update(JSON.stringify(key)).digest('hex'),
      });
      const volume = path.join(options.root, 'ui-control-volume');
      await fs.mkdir(volume);
      await fs.rename(selected.roots.control, path.join(volume, 'ui-managed'));
      const installationId = '60da98a1-4300-4b4d-828c-b2e5839a72cf';
      const configuration = JSON.stringify(
        layout === 'plaintext' ? { version: 2, phase: 'ready', installationId } : { version: 1, phase: 'ready', key },
      );
      await fs.writeFile(path.join(volume, 'ui-managed', 'ui-configuration.json'), configuration, { mode: 0o600 });
      const binding = path.join(selected.roots.appData, 'local-metadata-ui-control.json');
      await fs.writeFile(
        binding,
        JSON.stringify({
          version: layout === 'plaintext' ? 2 : 1,
          root: '/data/local-metadata/ui-managed',
          ...(layout === 'plaintext' ? { installationId } : { keyId: createHash('sha256').update(key).digest('hex') }),
        }),
      );
      selected.roots.control = volume;
      if (process.platform !== 'win32') {
        const cache = path.join(volume, 'ui-managed', 'generations', 'selected-generation', 'runtime-cache');
        await fs.mkdir(cache);
        await fs.writeFile(path.join(cache, 'content'), 'fixture runtime cache');
        await fs.symlink('content', path.join(cache, 'link'));
      }
      const copied = await createLocalUpgradeBackup(selected);
      await verifyLocalUpgradeBackup(options.destination, copied.receipt);
      const restored = path.join(options.root, 'ui-selected-restore');
      await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
      assert.equal(
        await fs.readFile(path.join(restored, 'control', 'ui-managed', 'ui-configuration.json'), 'utf8'),
        configuration,
      );
      assert.equal(
        await fs.readFile(path.join(restored, 'appData', 'local-metadata-ui-control.json'), 'utf8'),
        await fs.readFile(binding, 'utf8'),
      );
      await fs.unlink(binding);
      await assert.rejects(
        createLocalUpgradeBackup({ ...selected, destination: path.join(options.root, 'missing-binding') }),
        /binding/,
      );
    });
  });

test('selected backup refuses missing control, pre-resumption selection, corrupt references and wrong certificate', async () => {
  for (const mutation of ['phase', 'artifact', 'certificate'])
    await fixture(async (options) => {
      const selected = await sqliteFixture(options);
      if (mutation === 'artifact')
        await fs.writeFile(
          path.join(selected.generation, 'objects', selected.hash.slice(0, 2), selected.hash),
          'broken',
        );
      else {
        const file = mutation === 'phase' ? 'transition.sqlite' : 'upgrade.sqlite';
        const db = new DatabaseSync(path.join(selected.roots.control, file));
        db.exec(
          mutation === 'phase'
            ? "UPDATE transition_state SET phase='sqlite-validation'"
            : "UPDATE certificates SET certificate_json='{}'",
        );
        db.close();
      }
      await assert.rejects(createLocalUpgradeBackup(selected));
      await assert.rejects(fs.stat(options.destination), /ENOENT/);
    });
  await fixture(async (options) => {
    await assert.rejects(createLocalUpgradeBackup({ ...options, sqlite: true }));
  });
});
test('selected backup refuses malformed pointers, missing operational databases and swapped database identities', async () => {
  for (const mutation of ['pointer', 'operational', 'catalog', 'settings'])
    await fixture(async (options) => {
      const selected = await sqliteFixture(options);
      if (mutation === 'operational')
        await fs.unlink(path.join(selected.generation, 'operational', 'evaluation-runs.sqlite'));
      else {
        const db = new DatabaseSync(
          path.join(selected.generation, mutation === 'settings' ? 'settings.sqlite' : 'catalog.sqlite'),
        );
        try {
          if (mutation === 'pointer') {
            const metadata = JSON.parse(db.prepare('SELECT metadata_json FROM projects').get().metadata_json);
            delete metadata.contents.size;
            db.prepare('UPDATE projects SET metadata_json=?').run(JSON.stringify(metadata));
          } else db.exec('PRAGMA application_id=0');
        } finally {
          db.close();
        }
      }
      await assert.rejects(createLocalUpgradeBackup(selected));
      await assert.rejects(fs.stat(options.destination), /ENOENT/);
    });
});
test('backup checks catalog artifact fields rather than interpreting unrelated hash/size metadata', async () => {
  await fixture(async (options) => {
    const selected = await sqliteFixture(options);
    const db = new DatabaseSync(path.join(selected.generation, 'catalog.sqlite'));
    try {
      const metadata = JSON.parse(db.prepare('SELECT metadata_json FROM projects').get().metadata_json);
      metadata.extra = { hash: 'not-an-artifact', size: 3 };
      db.prepare('UPDATE projects SET metadata_json=?').run(JSON.stringify(metadata));
    } finally {
      db.close();
    }
    const copied = await createLocalUpgradeBackup(selected);
    await verifyLocalUpgradeBackup(options.destination, copied.receipt);
  });
});

test('selected backup refuses integrity-valid operational databases with missing, extra or incomplete schemas', async () => {
  for (const name of Object.keys(operationalSchemas))
    for (const mutation of ['missing', 'extra', 'column'])
      await fixture(async (options) => {
        const selected = await sqliteFixture(options);
        const db = new DatabaseSync(path.join(selected.generation, 'operational', name));
        try {
          const table = Object.keys(operationalSchemas[name])[0];
          if (mutation === 'extra') db.exec('CREATE TABLE unrelated (value TEXT)');
          else {
            db.exec(`DROP TABLE ${table}`);
            if (mutation === 'column') db.exec(`CREATE TABLE ${table} (value TEXT)`);
          }
          assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        } finally {
          db.close();
        }
        await assert.rejects(createLocalUpgradeBackup(selected), /operational.*schema/i);
        await assert.rejects(fs.stat(options.destination), /ENOENT/);
      });
});
test('late source drift cannot produce a valid backup receipt', async () => {
  await fixture(async (options) => {
    let checks = 0;
    await assert.rejects(
      createLocalUpgradeBackup({
        ...options,
        assertFrozen: async () => {
          if (++checks === 6) await fs.writeFile(path.join(options.roots.workflows, 'project'), 'host edit');
        },
      }),
      /Source changed/,
    );
    await assert.rejects(fs.stat(path.join(options.destination, 'backup.json')), /ENOENT/);
  });
});
test('backup and restore never overwrite existing destinations or accept wrong receipts', async () => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    await assert.rejects(createLocalUpgradeBackup(options), /EEXIST/);
    await assert.rejects(verifyLocalUpgradeBackup(options.destination, '0'.repeat(64)), /receipt differs/);
    await assert.rejects(
      restoreLocalUpgradeBackup({
        backup: options.destination,
        receipt: copied.receipt,
        destination: options.roots.workflows,
      }),
      /EEXIST/,
    );
    await assert.rejects(
      createLocalUpgradeBackup({ ...options, destination: path.join(options.roots.appData, 'backup') }),
      /overlap/,
    );
  });
});
test('extra or missing backup files invalidate readback rather than being skipped', async () => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    await fs.writeFile(path.join(options.destination, 'recordings', 'unexpected'), 'extra');
    await assert.rejects(verifyLocalUpgradeBackup(options.destination, copied.receipt), /differs/);
  });
});
test('a writable overlapping Docker mount blocks stopped-source backup', async () => {
  await fixture(async (options) => {
    const plan = {
      knownWritersStopped: true,
      roots: Object.fromEntries(BACKUP_DOMAINS.map((domain) => [domain, { source: options.roots[domain] }])),
    };
    await assert.rejects(assertNoBackupWriters({ ...plan, knownWritersStopped: false }, []), /Stop/);
    await assert.rejects(
      assertNoBackupWriters(plan, [{ State: { Running: true }, Mounts: [{ Source: options.root, RW: true }] }]),
      /running container/,
    );
    await assertNoBackupWriters(plan, [
      {
        State: { Running: true },
        Mounts: [
          { Source: options.root, RW: false },
          { Type: 'tmpfs', Source: '', RW: true },
        ],
      },
    ]);
    await assert.rejects(
      assertNoBackupWriters(plan, [
        { State: { Running: true }, Mounts: [{ Source: path.join(options.root, 'missing'), RW: true }] },
      ]),
      /ENOENT/,
    );
  });
});
test('a symlink alias of a writable Docker data mount cannot bypass writer detection', async () => {
  await fixture(async (options) => {
    const alias = path.join(options.root, 'alias');
    await fs.symlink(options.roots.appData, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const plan = {
      knownWritersStopped: true,
      roots: Object.fromEntries(BACKUP_DOMAINS.map((domain) => [domain, { source: options.roots[domain] }])),
    };
    await assert.rejects(
      assertNoBackupWriters(plan, [{ State: { Running: true }, Mounts: [{ Source: alias, RW: true }] }]),
      /running container/,
    );
  });
});
test('changed restored data and a correspondingly edited proof do not match the saved backup receipt', async () => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    const restored = path.join(options.root, 'restored');
    await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
    const proofPath = path.join(restored, 'restored-copy.json');
    const proof = JSON.parse(await fs.readFile(proofPath, 'utf8'));
    await fs.writeFile(path.join(restored, 'workflows', 'project'), 'different source');
    proof.backupManifest.domains.workflows = await scanBackupRoot(path.join(restored, 'workflows'), 'workflows');
    await fs.writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(
      inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }),
      /receipt differs/,
    );
    proof.version = 1;
    await fs.writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(
      inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }),
      /version 2/,
    );
  });
});
test('failed Docker launches are still cleaned up by verified ownership, including transient tools', async () => {
  const owner = 'rivet-restored-rehearsal-test',
    calls = [];
  const tracker = createRestoredContainerTracker(async (args) => {
    calls.push(args);
    if (args[0] === 'run') throw Error('CLI failed after container creation');
    if (args[0] === 'ps')
      return {
        stdout: calls
          .filter((call) => call[0] === 'run')
          .map((call) => call[call.indexOf('--name') + 1])
          .join('\n'),
      };
    if (args[0] === 'inspect')
      return {
        stdout: JSON.stringify([
          {
            Id: 'a'.repeat(64),
            Config: { Labels: { 'rivet.local-upgrade.restored': owner } },
            State: { Running: true },
          },
        ]),
      };
    return { stdout: '' };
  }, owner);
  await assert.rejects(tracker.start(['image']), /CLI failed/);
  await assert.rejects(tracker.runTool(['image']), /CLI failed/);
  const result = await tracker.cleanup(false);
  assert.equal(tracker.backendAttempted, true);
  assert.equal(result.failed, false);
  assert.equal(result.retained.length, 2);
  assert.equal(calls.filter((args) => args[0] === 'stop').length, 2);
  assert.ok(calls.filter((args) => args[0] === 'stop').every((args) => args.at(-1) === 'a'.repeat(64)));
  assert.equal(calls.filter((args) => args[0] === 'rm').length, 0);
  assert.ok(result.retained.some((name) => name.startsWith(owner + '-tool-')));
});
test('cleanup accepts a verified auto-removed failed helper but never assumes the backend disappeared safely', async () => {
  const owner = 'rivet-restored-rehearsal-test';
  const tracker = createRestoredContainerTracker(async (args) => {
    if (args[0] === 'run') throw Error('CLI failed');
    if (args[0] === 'inspect') throw Error('No such container');
    if (args[0] === 'ps') return { stdout: '' };
    throw Error('Unexpected Docker operation');
  }, owner);
  await assert.rejects(tracker.runTool(['image']), /CLI failed/);
  assert.deepEqual(await tracker.cleanup(false), { failed: false, retained: [] });
  await assert.rejects(tracker.start(['image']), /CLI failed/);
  assert.deepEqual(await tracker.cleanup(false), { failed: true, retained: [owner] });
});
test('owned backend cleanup removes the inspected container ID instead of its reusable name', async () => {
  const owner = 'rivet-restored-rehearsal-test';
  const id = 'a'.repeat(64);
  const calls = [];
  const tracker = createRestoredContainerTracker(async (args) => {
    calls.push(args);
    if (args[0] === 'inspect')
      return {
        stdout: JSON.stringify([
          { Id: id, Config: { Labels: { 'rivet.local-upgrade.restored': owner } }, State: { Running: false } },
        ]),
      };
    return { stdout: '' };
  }, owner);
  await tracker.start(['image']);
  assert.deepEqual(await tracker.cleanup(true), { failed: false, retained: [] });
  assert.deepEqual(
    calls.find((args) => args[0] === 'rm'),
    ['rm', id],
  );
});
test('legacy rehearsal resumption is refenced before restart and cannot accept a new source fingerprint', async () => {
  const events = [];
  await resumeRestoredLegacyFenced({
    action: async (action) => events.push(action),
    request: async (route, body) => {
      events.push(route);
      assert.deepEqual(body, {});
    },
    restart: async () => {
      events.push('restart');
      assertRestoredSourceFingerprint('a'.repeat(64), 'a'.repeat(64));
    },
  });
  assert.deepEqual(events, ['resume', '/pause', 'restart']);
  await assert.rejects(
    resumeRestoredLegacyFenced({
      action: async () => {},
      request: async () => {},
      restart: async () => assertRestoredSourceFingerprint('b'.repeat(64), 'a'.repeat(64)),
    }),
    /original backup/,
  );
});
test('rehearsal cleanup never stops a mismatched container and reports inability to stop an owned one', async () => {
  for (const mismatched of [true, false]) {
    const owner = 'rivet-restored-rehearsal-test',
      calls = [];
    const tracker = createRestoredContainerTracker(async (args) => {
      calls.push(args);
      if (args[0] === 'inspect')
        return {
          stdout: JSON.stringify([
            {
              Id: 'a'.repeat(64),
              Config: { Labels: { 'rivet.local-upgrade.restored': mismatched ? 'another-owner' : owner } },
              State: { Running: true },
            },
          ]),
        };
      if (args[0] === 'stop') throw Error('Docker unavailable');
      return { stdout: '' };
    }, owner);
    await tracker.start(['image']);
    assert.deepEqual(await tracker.cleanup(true), { failed: true, retained: [owner] });
    assert.equal(
      calls.some((args) => args[0] === 'stop'),
      !mismatched,
    );
    assert.equal(
      calls.some((args) => args[0] === 'rm'),
      false,
    );
  }
});
test('unexpected backup and restored root entries are not certified', async () => {
  await fixture(async (options) => {
    const copied = await createLocalUpgradeBackup(options);
    const restored = path.join(options.root, 'restored');
    await restoreLocalUpgradeBackup({ backup: options.destination, receipt: copied.receipt, destination: restored });
    await fs.writeFile(path.join(restored, 'unexpected'), 'extra');
    await assert.rejects(
      inspectRestoredRehearsal({ restored, receipt: copied.receipt, memoryMiB: 1024, cpus: 1 }),
      /Unexpected restored/,
    );
    await fs.writeFile(path.join(options.destination, 'unexpected'), 'extra');
    await assert.rejects(verifyLocalUpgradeBackup(options.destination, copied.receipt), /Unexpected backup/);
  });
});
test('restored runner authenticates loopback mutations with explicit intent and safely encoded data', async () => {
  const calls = [],
    output = [],
    input = { backupReference: 'quoted " value\n' };
  await vm.runInNewContext(`(async()=>{${restoredOperatorRequestScript('/copy', input)}})()`, {
    process: { env: { RIVET_KEY: 'private clone key' }, getBuiltinModule: process.getBuiltinModule },
    URLSearchParams,
    AbortSignal,
    console: { log: (value) => output.push(value) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? { status: 303, headers: new Headers({ 'set-cookie': 'signed=clone; HttpOnly' }) }
        : { ok: true, status: 204 };
    },
  });
  assert.equal(calls[0].url, 'http://127.0.0.1/ui-auth');
  assert.equal(calls[0].options.body.get('key'), 'private clone key');
  assert.equal(calls[1].url, 'http://127.0.0.1/api/app-settings/local-upgrade/copy');
  assert.equal(calls[1].options.headers['X-Rivet-Migration-Intent'], '1');
  assert.equal(calls[1].options.headers.Cookie, 'signed=clone');
  const proxyAuth = createHash('sha256').update('private clone key:proxy-auth').digest('hex');
  assert.equal(calls[0].options.headers['X-Rivet-Proxy-Auth'], proxyAuth);
  assert.equal(calls[1].options.headers['X-Rivet-Proxy-Auth'], proxyAuth);
  assert.deepEqual(JSON.parse(calls[1].options.body), input);
  assert.deepEqual(output, ['null']);
  assert.throws(() => restoredOperatorRequestScript('/unexpected', {}), /Unknown operator route/);
});

test('restored runner uses the direct backend authentication contract over real HTTP', async () => {
  const key = 'disposable HTTP fixture key';
  const proxyAuth = createHash('sha256')
    .update(key + ':proxy-auth')
    .digest('hex');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.headers['x-rivet-proxy-auth'] !== proxyAuth) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === '/ui-auth' && req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      if (new URLSearchParams(body).get('key') !== key) {
        res.writeHead(303, { Location: '/?auth_error=invalid' }).end();
        return;
      }
      res.writeHead(303, { 'Set-Cookie': 'signed=clone; HttpOnly', Location: '/' }).end();
      return;
    }
    if (
      req.url === '/api/app-settings/local-upgrade/pause' &&
      req.method === 'POST' &&
      req.headers.cookie === 'signed=clone' &&
      req.headers['x-rivet-migration-intent'] === '1'
    ) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await vm.runInNewContext(`(async()=>{${restoredOperatorRequestScript('/pause', {})}})()`, {
      process: { env: { RIVET_KEY: key }, getBuiltinModule: process.getBuiltinModule },
      URLSearchParams,
      AbortSignal,
      console: { log() {} },
      fetch: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options),
    });
    assert.deepEqual(requests, ['/ui-auth', '/api/app-settings/local-upgrade/pause']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('restored runner refuses a missing key or unsigned login before mutating the clone', async () => {
  for (const key of ['', 'disposable fixture key']) {
    const requests = [];
    await assert.rejects(
      vm.runInNewContext(`(async()=>{${restoredOperatorRequestScript('/pause', {})}})()`, {
        process: { env: { RIVET_KEY: key }, getBuiltinModule: process.getBuiltinModule },
        URLSearchParams,
        AbortSignal,
        fetch: async (url) => {
          requests.push(url);
          return { status: 303, headers: new Headers() };
        },
      }),
      /Clone operator (key is required|session was not issued)/,
    );
    assert.equal(requests.length, key ? 1 : 0);
  }
});
test('symlinked data roots and escaping runtime links cannot redirect backup writes', async () => {
  await fixture(async (options) => {
    try {
      await fs.symlink(options.roots.appData, path.join(options.roots.runtimeLibraries, 'escape'), 'junction');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return;
      throw error;
    }
    await assert.rejects(createLocalUpgradeBackup(options), /Escaping package link/);
  });
});
test('restored-copy rehearsal requires explicit bounded resources', async () => {
  await fixture(async (options) => {
    await assert.rejects(
      inspectRestoredRehearsal({ restored: options.root, receipt: '0'.repeat(64), memoryMiB: 0, cpus: 1 }),
      /memory limit/,
    );
    await assert.rejects(
      inspectRestoredRehearsal({ restored: options.root, receipt: '0'.repeat(64), memoryMiB: 1024, cpus: 0 }),
      /CPU limit/,
    );
  });
});
test(
  'backup preserves sticky directory permissions and refuses unreviewed set-ID bits',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (options) => {
      await fs.chmod(path.join(options.roots.workflows, 'empty'), 0o1777);
      const copied = await createLocalUpgradeBackup(options);
      assert.equal((await fs.stat(path.join(options.destination, 'workflows', 'empty'))).mode & 0o7777, 0o1777);
      await verifyLocalUpgradeBackup(options.destination, copied.receipt);
      await fs.chmod(path.join(options.roots.workflows, 'project'), 0o4755);
      await assert.rejects(
        createLocalUpgradeBackup({ ...options, destination: path.join(options.root, 'backup-2') }),
        /Set-ID permissions/,
      );
    });
  },
);
