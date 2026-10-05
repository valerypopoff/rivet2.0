import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupPartialMacDmg,
  getTransientMacDmgBuildFailure,
  isTransientMacDmgBuildFailure,
  runMacDmgBuildWithRetries,
  macDmgBuildArgs,
} from './build-macos-dmg.mjs';

test('shared frontend override is explicit and retains target-specific native packaging', () => {
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    const ordinary = macDmgBuildArgs(target);
    assert.deepEqual(ordinary.slice(-4), ['--target', target, '--bundles', 'dmg']);
    assert.deepEqual(macDmgBuildArgs(target, true), [
      ...ordinary,
      '--config',
      '../../.github/desktop-prebuilt.conf.json',
    ]);
  }
  assert.throws(() => macDmgBuildArgs('unsupported'));
});

void test('recognizes only known transient macOS bundle failures', () => {
  assert.equal(
    isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Resource busy' }),
    true,
  );
  assert.equal(
    getTransientMacDmgBuildFailure({ status: 1, output: 'Rivet 2.app: A timestamp was expected but was not found.' })
      ?.kind,
    'apple-secure-timestamp',
  );
  assert.equal(isTransientMacDmgBuildFailure({ status: 0, output: 'hdiutil: create failed - Resource busy' }), false);
  assert.equal(
    isTransientMacDmgBuildFailure({ status: 0, output: 'A timestamp was expected but was not found.' }),
    false,
  );
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Permission denied' }), false);
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'error: could not compile Rivet' }), false);
  for (const status of [0, 1]) {
    assert.equal(
      getTransientMacDmgBuildFailure({ status, output: 'hdiutil: couldn\'t eject "disk4" - Resource busy' })?.kind,
      status === 0 ? undefined : 'hdiutil-detach-busy',
    );
  }
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: couldn\'t eject "disk4" - Permission denied' }), false);
});

void test('cleans and retries a transient DMG failure', async () => {
  const events = [];
  const results = [
    { status: 1, output: 'hdiutil: create failed - Resource busy' },
    { status: 0, output: 'completed' },
  ];

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return results.shift();
    },
    cleanup: async () => events.push('cleanup'),
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
    warn: () => {},
  });

  assert.deepEqual(result, { status: 0, output: 'completed' });
  assert.deepEqual(events, ['run', 'cleanup', 'wait:5000', 'run']);
});

void test('retries a transient Apple secure-timestamp failure', async () => {
  const events = [];
  const warnings = [];
  const results = [
    { status: 1, output: 'Rivet 2.app: A timestamp was expected but was not found.' },
    { status: 0, output: 'completed' },
  ];

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return results.shift();
    },
    cleanup: async () => events.push('cleanup'),
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(result, { status: 0, output: 'completed' });
  assert.deepEqual(events, ['run', 'cleanup', 'wait:5000', 'run']);
  assert.match(warnings[0], /Apple secure-timestamp failure/);
});

void test('returns a deterministic failure without retrying it', async () => {
  const events = [];
  const failure = { status: 1, output: 'error: could not compile Rivet' };

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return failure;
    },
    cleanup: async () => events.push('cleanup'),
    wait: async () => events.push('wait'),
    warn: () => {},
  });

  assert.equal(result, failure);
  assert.deepEqual(events, ['run']);
});

void test('stops after the bounded number of transient retries', async () => {
  const events = [];
  const failure = { status: 1, output: 'hdiutil: create failed - Resource busy' };

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return failure;
    },
    cleanup: async () => events.push('cleanup'),
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
    warn: () => {},
  });

  assert.equal(result, failure);
  assert.deepEqual(events, ['run', 'cleanup', 'wait:5000', 'run', 'cleanup', 'wait:15000', 'run']);
});

void test('detach-busy failure retries only after successful cleanup; cleanup failure prevents retry', async () => {
  const failure = { status: 1, output: 'hdiutil: couldn\'t eject "disk4" - Resource busy' };
  for (const cleanupFails of [false, true]) {
    const events = [];
    const operation = runMacDmgBuildWithRetries({
      run: async () => { events.push('run'); return events.length === 1 ? failure : { status: 0, output: '' }; },
      cleanup: async () => { events.push('cleanup'); if (cleanupFails) throw new Error('detach failed'); },
      wait: async () => { events.push('wait'); },
      warn: () => {},
    });
    if (cleanupFails) {
      await assert.rejects(operation, /detach failed/);
      assert.deepEqual(events, ['run', 'cleanup']);
    } else {
      assert.equal((await operation).status, 0);
      assert.deepEqual(events, ['run', 'cleanup', 'wait', 'run']);
    }
  }
});

void test('scratch cleanup confines detach/delete to the target and fails closed on disk errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-dmg-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = 'x86_64-apple-darwin';
  const directory = join(root, 'src-tauri', 'target', target, 'release', 'bundle', 'macos');
  const otherDirectory = join(root, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos');
  await mkdir(directory, { recursive: true });
  await mkdir(otherDirectory, { recursive: true });
  const imagePath = join(directory, 'rw.Rivet 2.dmg');
  const foreignPath = join(otherDirectory, 'rw.Rivet 2.dmg');
  await writeFile(foreignPath, 'foreign');
  await writeFile(join(directory, 'Rivet 2.dmg'), 'finished');
  await mkdir(join(directory, 'rw.directory.dmg'));
  const listImages = async () => [
    { 'image-path': foreignPath, 'system-entities': [{ 'dev-entry': '/dev/disk9' }] },
    { 'image-path': imagePath, 'system-entities': [{ 'dev-entry': '/dev/disk4' }, { 'dev-entry': '/dev/disk4s1' }] },
  ];
  for (const failure of [16, 1, 'force-failure']) {
    await writeFile(imagePath, 'partial');
    const commands = [];
    const cleanup = cleanupPartialMacDmg(target, {
      root, listImages,
      diskCommand: async (args) => {
        commands.push(args);
        if (args.includes('-force') && failure === 16) return;
        throw Object.assign(new Error('disk error'), { code: failure === 'force-failure' ? 16 : failure });
      },
    });
    if (failure === 16) {
      await cleanup;
      assert.ok(!(await readdir(directory)).includes('rw.Rivet 2.dmg'));
    } else {
      await assert.rejects(cleanup, /disk error/);
      assert.ok((await readdir(directory)).includes('rw.Rivet 2.dmg'));
    }
    assert.deepEqual(commands, failure === 1 ? [['detach', '/dev/disk4']] : [['detach', '/dev/disk4'], ['detach', '/dev/disk4', '-force']]);
    assert.deepEqual(await readdir(otherDirectory), ['rw.Rivet 2.dmg']);
    assert.ok((await readdir(directory)).includes('Rivet 2.dmg'));
    assert.ok((await readdir(directory)).includes('rw.directory.dmg'));
  }
  await assert.rejects(cleanupPartialMacDmg('unknown', { root }), /Unsupported/);
  await assert.rejects(cleanupPartialMacDmg(target, { root, listImages: async () => null }), /inspect/);
  await assert.rejects(cleanupPartialMacDmg(target, {
    root, listImages: async () => [{ 'image-path': imagePath, 'system-entities': [{ 'dev-entry': '/dev/disk4s1' }] }],
  }), /whole-disk/);
  await cleanupPartialMacDmg(target, { root, listImages: async () => [], diskCommand: async () => assert.fail('not mounted') });
});
