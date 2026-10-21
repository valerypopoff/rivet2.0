import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupPartialMacDmg,
  getTransientMacDmgBuildFailure,
  isTransientMacDmgBuildFailure,
  runMacDmgBuildWithRetries,
  macDmgBuildArgs,
  macDmgBuildEnvironment,
} from './build-macos-dmg.mjs';
import { runTauriAppStapler } from './tauri-app-stapler.mjs';

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
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Resource busy' }), true);
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
  assert.equal(
    isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Permission denied' }),
    false,
  );
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'error: could not compile Rivet' }), false);
  for (const status of [0, 1]) {
    assert.equal(
      getTransientMacDmgBuildFailure({ status, output: 'hdiutil: couldn\'t eject "disk4" - Resource busy' })?.kind,
      status === 0 ? undefined : 'hdiutil-detach-busy',
    );
  }
  assert.equal(
    isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: couldn\'t eject "disk4" - Permission denied' }),
    false,
  );
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

const appStaplerNetworkFailure = {
  status: 1,
  output: [
    'Notarizing Finished with status Accepted',
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
    'The staple and validate action failed! Error 68.',
    'Error [tauri_cli_node] failed to bundle project: failed to staple app.',
  ].join('\n'),
};

test('wrapped app stapler failures cannot restart signing or notarization', () => {
  for (const code of [1001, 1004, 1005, 1009]) {
    assert.equal(
      getTransientMacDmgBuildFailure({
        ...appStaplerNetworkFailure,
        output: appStaplerNetworkFailure.output.replace('Code=-1005', `Code=-${code}`),
      })?.kind,
      undefined,
    );
  }
  for (const failure of [
    { ...appStaplerNetworkFailure, status: 0 },
    { ...appStaplerNetworkFailure, status: null },
    { ...appStaplerNetworkFailure, status: 2 },
    { ...appStaplerNetworkFailure, output: appStaplerNetworkFailure.output.replace('Code=-1005', 'Code=-1202') },
    { ...appStaplerNetworkFailure, output: appStaplerNetworkFailure.output.replace('Code=-1005', 'Code=-10050') },
    { status: 1, output: 'failed to staple app. The staple and validate action failed! Error 68.' },
    { status: 1, output: 'Error Domain=NSURLErrorDomain Code=-1005; notarization submission failed.' },
    { ...appStaplerNetworkFailure, output: appStaplerNetworkFailure.output.replace('Error 68.', 'Error 65.') },
    {
      ...appStaplerNetworkFailure,
      output: appStaplerNetworkFailure.output.replace('Finished with status Accepted', 'submission outcome unknown'),
    },
    {
      ...appStaplerNetworkFailure,
      output: appStaplerNetworkFailure.output.replace('failed to staple app', 'compilation failed'),
    },
  ]) {
    assert.equal(getTransientMacDmgBuildFailure(failure), undefined);
  }
});

test('exhausted app-ticket retrieval does not clean up or repeat the accepted build', async () => {
  const events = [];
  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return appStaplerNetworkFailure;
    },
    cleanup: async () => events.push('cleanup'),
    wait: async () => events.push('wait'),
    warn: () => {},
  });
  assert.equal(result, appStaplerNetworkFailure);
  assert.deepEqual(events, ['run']);
});

test('Tauri retries the exact app-ticket command after three observed CloudKit connection losses', async () => {
  const command = ['stapler', 'staple', '-v', 'Rivet 2.app'];
  const calls = [],
    waits = [];
  const networkLoss = { status: 68, output: appStaplerNetworkFailure.output };
  const success = { status: 0, output: 'stapled' };
  const results = [networkLoss, networkLoss, networkLoss, success];
  const result = await runTauriAppStapler(command, {
    run: async (program, args) => {
      calls.push([program, args]);
      return results.shift();
    },
    wait: async (delay) => waits.push(delay),
    write: () => {},
    warn: () => {},
  });
  assert.equal(result, success);
  assert.deepEqual(
    calls,
    Array.from({ length: 4 }, () => ['/usr/bin/xcrun', command]),
  );
  assert.deepEqual(waits, [5000, 15000, 30000]);
});

test('app stapling fails closed on permanent errors, execution failures and exhausted network retries', async () => {
  for (const failure of [
    { status: 68, output: 'No valid ticket.' },
    { status: 65, output: 'invalid app' },
    { status: null, output: '', error: new Error('spawn failed') },
    { status: 68, output: appStaplerNetworkFailure.output },
  ]) {
    let calls = 0;
    const waits = [];
    assert.equal(
      await runTauriAppStapler(['stapler', 'staple', '-v', 'Rivet 2.app'], {
        run: async (program, args) => {
          assert.equal(program, '/usr/bin/xcrun');
          assert.deepEqual(args, ['stapler', 'staple', '-v', 'Rivet 2.app']);
          calls++;
          return failure;
        },
        wait: async (delay) => waits.push(delay),
        write: () => {},
        warn: () => {},
      }),
      failure,
    );
    const transient = failure.output === appStaplerNetworkFailure.output;
    assert.equal(calls, transient ? 6 : 1);
    assert.deepEqual(waits, transient ? [5000, 15000, 30000, 60000, 120000] : []);
  }
  for (const args of [
    [],
    ['notarytool', 'submit', 'Rivet 2.app'],
    ['stapler', 'validate', '-v', 'Rivet 2.app'],
    ['stapler', 'staple', '-v', '--bad.app'],
    ['stapler', 'staple', '-v', 'other.dmg'],
  ])
    assert.throws(() => runTauriAppStapler(args), /Unsupported/);
});

test('the xcrun adapter is scoped to the child build and preserves Apple credentials', () => {
  const env = { PATH: '/original/tools', APPLE_API_KEY: 'fixture-key', APPLE_SIGNING_IDENTITY: 'fixture-identity' };
  const child = macDmgBuildEnvironment(env);
  assert.ok(child.PATH.endsWith(env.PATH));
  assert.match(child.PATH, /macos-build-tools/);
  assert.equal(child.APPLE_API_KEY, env.APPLE_API_KEY);
  assert.equal(child.APPLE_SIGNING_IDENTITY, env.APPLE_SIGNING_IDENTITY);
  assert.equal(child.RIVET_MACOS_BUILD_NODE, process.execPath);
  assert.match(child.RIVET_MACOS_STAPLER_HELPER, /tauri-app-stapler\.mjs$/);
  assert.deepEqual(Object.keys(env).sort(), ['APPLE_API_KEY', 'APPLE_SIGNING_IDENTITY', 'PATH']);
});

test(
  'the actual shell adapter preserves spaced argv, cwd, output and helper exit status',
  {
    skip: process.platform === 'win32' ? 'Requires native POSIX Bash' : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-app-stapler-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = join(root, 'test helper.mjs');
    await writeFile(
      helper,
      `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
console.error('helper stderr');
process.exitCode = Number(process.env.FIXTURE_STATUS);\n`,
    );
    const args = ['stapler', 'staple', '-v', 'Rivet 2 $special.app'];
    for (const status of [0, 68]) {
      const result = spawnSync(fileURLToPath(new URL('./macos-build-tools/xcrun', import.meta.url)), args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          RIVET_MACOS_BUILD_NODE: process.execPath,
          RIVET_MACOS_STAPLER_HELPER: helper,
          FIXTURE_STATUS: String(status),
        },
      });
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args, cwd: await realpath(root) });
      assert.equal(result.stderr, 'helper stderr\n');
    }
  },
);

test(
  'the actual shell adapter forwards non-stapling xcrun commands without requiring helper variables',
  {
    skip: process.platform !== 'darwin' ? 'Requires native macOS xcrun' : false,
  },
  () => {
    const env = { ...process.env };
    delete env.RIVET_MACOS_BUILD_NODE;
    delete env.RIVET_MACOS_STAPLER_HELPER;
    const options = { env, encoding: 'utf8', timeout: 10_000 };
    const native = spawnSync('/usr/bin/xcrun', ['--version'], options);
    const adapted = spawnSync(
      'bash',
      [fileURLToPath(new URL('./macos-build-tools/xcrun', import.meta.url)), '--version'],
      options,
    );
    assert.equal(native.status, 0, native.stderr);
    assert.equal(adapted.status, native.status, adapted.stderr);
    assert.equal(adapted.stdout, native.stdout);
    assert.equal(adapted.stderr, native.stderr);
  },
);

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
      run: async () => {
        events.push('run');
        return events.length === 1 ? failure : { status: 0, output: '' };
      },
      cleanup: async () => {
        events.push('cleanup');
        if (cleanupFails) throw new Error('detach failed');
      },
      wait: async () => {
        events.push('wait');
      },
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
      root,
      listImages,
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
    assert.deepEqual(
      commands,
      failure === 1
        ? [['detach', '/dev/disk4']]
        : [
            ['detach', '/dev/disk4'],
            ['detach', '/dev/disk4', '-force'],
          ],
    );
    assert.deepEqual(await readdir(otherDirectory), ['rw.Rivet 2.dmg']);
    assert.ok((await readdir(directory)).includes('Rivet 2.dmg'));
    assert.ok((await readdir(directory)).includes('rw.directory.dmg'));
  }
  await assert.rejects(cleanupPartialMacDmg('unknown', { root }), /Unsupported/);
  await assert.rejects(cleanupPartialMacDmg(target, { root, listImages: async () => null }), /inspect/);
  await assert.rejects(
    cleanupPartialMacDmg(target, {
      root,
      listImages: async () => [{ 'image-path': imagePath, 'system-entities': [{ 'dev-entry': '/dev/disk4s1' }] }],
    }),
    /whole-disk/,
  );
  await cleanupPartialMacDmg(target, {
    root,
    listImages: async () => [],
    diskCommand: async () => assert.fail('not mounted'),
  });
});
