import assert from 'node:assert/strict';
// test-style: fixture-read: Reads only test-created runtime manifests and installer receipts under owned temporary roots.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { LegacyRestoreService } from '../legacy-restore/service.js';
import { selectRestoreSourceBudget } from '../legacy-restore/preparation-budget.js';
import {
  prepareRestoreRuntime,
  runtimeNeedsReinstallation,
  validateRestoreRuntimeLock,
} from '../legacy-restore/runtime-preparation.js';
import { restoreValidationFailureMessage } from '../legacy-restore/import-worker.js';
import {
  withLocalSourceBundleLimit,
  withLocalSourceBudget,
  chargeLocalSourceBytes,
} from '../local-metadata/source-budget.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { canonicalOperationalMigrationRow } from '../scripts/migrate-operational-sqlite.js';

const MIB = 1048576;
test(
  'POSIX restore disposal kills installer descendants even after the worker leader exits',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async () => {
    const descendant = `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`;
    const worker = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', worker], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const service = new LegacyRestoreService({} as never, {} as never, '', {
      drain: async () => {},
      restart: async () => {},
    });
    (service as unknown as { child: ChildProcess }).child = child;
    try {
      await once(child.stdout!, 'data');
      await service.dispose();
      await closed; // Pipes remain open until the SIGTERM-resistant descendant has also exited.
    } finally {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  },
);

test('exact operational comparison preserves PostgreSQL Date milliseconds and still rejects timestamp drift', () => {
  const source = { started_at: '2026-10-08T00:07:11.887Z', timestamp_ms: 1791418031887, json: '{"a":1}' };
  const target = {
    ...source,
    started_at: new Date(source.started_at),
    timestamp_ms: String(source.timestamp_ms),
    json: { a: 1 },
  };
  assert.equal(canonicalOperationalMigrationRow(source), canonicalOperationalMigrationRow(target));
  assert.notEqual(
    canonicalOperationalMigrationRow(source),
    canonicalOperationalMigrationRow({ ...target, started_at: new Date('2026-10-08T00:07:11.000Z') }),
  );
});
test('restore automatically selects a bounded memory-aware budget and retains it across phases', async () => {
  await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', undefined, async () => {
    const roomy = { availableMemoryBytes: 4 * 1024 * MIB, heapLimitBytes: 4 * 1024 * MIB };
    assert.equal(selectRestoreSourceBudget(roomy), 128 * MIB);
    assert.equal(selectRestoreSourceBudget(roomy, 64 * MIB), 64 * MIB);
    const small = { availableMemoryBytes: 1024 * MIB, heapLimitBytes: 1024 * MIB };
    assert.equal(selectRestoreSourceBudget(small), 88 * MIB);
    assert.throws(() => selectRestoreSourceBudget(small, 128 * MIB), /memory headroom/);
    assert.throws(() => selectRestoreSourceBudget({ ...small, availableMemoryBytes: 64 * MIB }), /memory headroom/);
    assert.throws(() => selectRestoreSourceBudget(roomy, Number.NaN), /memory headroom/);
    await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '16', async () => {
      assert.equal(selectRestoreSourceBudget(roomy), 16 * MIB);
    });
  });
});

test('selected restore budgets are isolated, independent per bundle, and do not change ordinary source limits', async () => {
  await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
    await withLocalSourceBundleLimit(2 * MIB, async () => {
      for (let i = 0; i < 3; i++) await withLocalSourceBudget(async () => chargeLocalSourceBytes(2 * MIB));
      await assert.rejects(withLocalSourceBudget(async () => chargeLocalSourceBytes(2 * MIB + 1)));
      await Promise.all([
        withLocalSourceBundleLimit(MIB, async () => {
          await assert.rejects(withLocalSourceBudget(async () => chargeLocalSourceBytes(2 * MIB)));
        }),
        withLocalSourceBudget(async () => {
          await Promise.resolve();
          chargeLocalSourceBytes(2 * MIB);
        }),
      ]);
    });
    await assert.rejects(withLocalSourceBudget(async () => chargeLocalSourceBytes(2 * MIB)));
  });
});

const dependencies = { sharp: 'latest' };
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    '': { dependencies },
    'node_modules/sharp': {
      version: '0.35.3',
      resolved: 'https://registry.npmjs.org/sharp/-/sharp-0.35.3.tgz',
      integrity: 'sha512-fixture',
    },
  },
});
test('runtime reinstall pins the lock graph and rejects local, linked, credentialed or unverified package sources', () => {
  for (const name of ['../escape', 'C:/outside', '@scope/../../escape', '.hidden', 'package\\escape'])
    assert.throws(() => validateRestoreRuntimeLock(lock(), { [name]: 'latest' }), /unsupported sources/);
  assert.equal(validateRestoreRuntimeLock(lock(), dependencies).packages!['node_modules/sharp']!.version, '0.35.3');
  assert.throws(() => validateRestoreRuntimeLock(lock(), { sharp: '0.35.3' }), /manifest/);
  for (const resolved of [
    'file:/outside/package.tgz',
    'https://user:secret@registry.npmjs.org/sharp.tgz',
    'https://evil.test/package.tgz',
    'http://registry.npmjs.org/sharp.tgz',
  ]) {
    const altered = lock();
    altered.packages['node_modules/sharp'].resolved = resolved;
    assert.throws(() => validateRestoreRuntimeLock(altered, dependencies), /unsupported sources/);
  }
  const linked = lock();
  Object.assign(linked.packages['node_modules/sharp'], { link: true });
  assert.throws(() => validateRestoreRuntimeLock(linked, dependencies), /unsupported sources/);
  assert.throws(() => validateRestoreRuntimeLock({ lockfileVersion: 1 }, dependencies), /valid npm lockfile/);
});

test('native signatures trigger reinstallation, but unreadable trees do not masquerade as portable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-native-reinstall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.js'), 'module.exports = 1');
  assert.equal(await runtimeNeedsReinstallation(root), false);
  await fs.writeFile(path.join(root, 'binary'), Buffer.from('7f454c46', 'hex'));
  assert.equal(await runtimeNeedsReinstallation(root), true);
  await assert.rejects(runtimeNeedsReinstallation(path.join(root, 'missing')), /ENOENT/);
});

test('preparation failures have actionable secret-free UI messages', () => {
  for (const message of [
    'Runtime package reinstallation failed.',
    'Insufficient restore memory headroom.',
    'Runtime package lock does not match the backup manifest.',
    'Runtime package lock contains unsupported sources.',
  ]) {
    assert.match(restoreValidationFailureMessage(new Error(message), true), /Nothing was deleted/);
    assert.doesNotMatch(restoreValidationFailureMessage(new Error(message), true), /original downloaded/);
  }
});

test('reinstallation uses only pinned lock inputs, suppresses backup scripts and secrets, and preserves source bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-install-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'runtime');
  const current = path.join(source, 'current');
  const installed = path.join(current, 'node_modules', 'fixture');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(
    path.join(source, 'manifest.json'),
    JSON.stringify({
      packages: {
        fixture: { name: 'fixture', version: 'latest', installedAt: '2026-01-01' },
      },
      updatedAt: '2026-01-01',
    }),
  );
  const originalPackage = JSON.stringify({
    dependencies: { fixture: 'latest' },
    scripts: { postinstall: 'UNTRUSTED' },
  });
  await fs.writeFile(path.join(current, 'package.json'), originalPackage);
  await fs.writeFile(
    path.join(installed, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }),
  );
  await fs.writeFile(path.join(installed, 'index.js'), 'module.exports = "original"');
  await fs.writeFile(path.join(installed, 'old.node'), Buffer.from('7f454c46', 'hex'));
  await fs.writeFile(
    path.join(current, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { fixture: 'latest' } },
        'node_modules/fixture': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
          integrity: 'sha512-fixture',
        },
      },
    }),
  );
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const executable = path.join(bin, 'fake-npm.cjs');
  await fs.writeFile(
    executable,
    `const fs = require('fs'), path = require('path');
if (fs.existsSync(path.join(__dirname, 'fail'))) process.exit(12);
const cwd = process.cwd(), pkg = JSON.parse(fs.readFileSync('package.json'));
fs.writeFileSync(path.join(cwd, 'invocation.json'), JSON.stringify({args:process.argv.slice(2),scripts:!!pkg.scripts,secret:!!process.env.RIVET_KEY}));
const out = path.join(cwd, 'node_modules', 'fixture'); fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(path.join(out,'package.json'), JSON.stringify({name:'fixture',version:'1.0.0',main:'index.js'}));
fs.writeFileSync(path.join(out,'index.js'), 'module.exports = "reinstalled"');`,
  );
  await fs.writeFile(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${executable}" %*\r\n`);
  await fs.writeFile(path.join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${executable}" "$@"\n`, {
    mode: 0o700,
  });
  await withEnvOverride('PATH', bin + path.delimiter + process.env.PATH, async () => {
    await withEnvOverride('RIVET_KEY', 'must-not-leak', async () => {
      const destination = path.join(root, 'prepared');
      await prepareRestoreRuntime(source, destination);
      const invocation = JSON.parse(await fs.readFile(path.join(destination, 'current', 'invocation.json'), 'utf8'));
      assert.deepEqual(invocation, {
        args: ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
        scripts: false,
        secret: false,
      });
      assert.equal(await fs.readFile(path.join(current, 'package.json'), 'utf8'), originalPackage);
      await assert.rejects(fs.access(path.join(destination, 'current', 'node_modules', 'fixture', 'old.node')));
      await assert.rejects(fs.access(path.join(destination, '.npm-cache')));
      await fs.writeFile(path.join(bin, 'fail'), '1');
      await assert.rejects(prepareRestoreRuntime(source, path.join(root, 'failed')), /reinstallation failed/);
      assert.equal(await fs.readFile(path.join(current, 'package.json'), 'utf8'), originalPackage);
      await assert.rejects(prepareRestoreRuntime(source, destination), /EEXIST/);
    });
  });
});
