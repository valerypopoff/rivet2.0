import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import * as tar from 'tar';
import {
  createRuntimeLibrarySync,
  extractRuntimeLibraryArchive,
  prepareFilesystemRuntimeSnapshot,
  publishEmptyRuntimeRelease,
  publishRuntimeLibraryCandidate,
  selectRuntimeLibrarySource,
  type RuntimeLibrarySnapshot,
} from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import {
  createRuntimeLibraryDirectoryArchive,
  readSourceRuntimeSelection,
} from '../scripts/migrate-runtime-libraries.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';
import { normalizeExtractedRuntimeLayout } from '../legacy-restore/runtime-layout.js';
import { ManagedRuntimeLibrariesLocalCache } from '../runtime-libraries/managed/local-cache.js';

// test-style: fixture-read: only generated release archives and package metadata are read.
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-cache-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const bootstrapManifest = import.meta.resolve('@valerypopoff/rivet-studio-server-bootstrap/package.json');
const managedSettings = {
  storageMode: 'managed',
  databaseMode: 'managed',
  databaseConnectionString: 'postgresql://unused.invalid/fixture',
  databaseSslMode: 'disable',
  objectStorageBucket: 'unused',
  objectStorageRegion: 'us-east-1',
  storageAccessKeyId: 'fixture',
  storageAccessKey: 'fixture',
};

async function withBootstrap(
  root: string,
  io: { query(): Promise<unknown>; send?(): Promise<unknown>; end?(): Promise<void> },
  run: () => Promise<void>,
) {
  const require = createRequire(bootstrapManifest);
  const pg = require('pg'),
    s3 = require('@aws-sdk/client-s3');
  const originalPool = pg.Pool,
    originalSend = s3.S3Client.prototype.send;
  const hooks = globalThis as typeof globalThis & { __RIVET_PREPARE_RUNTIME_LIBRARIES__?: unknown };
  const originalHook = hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__;
  pg.Pool = class {
    query = io.query;
    end = io.end ?? (async () => {});
  };
  s3.S3Client.prototype.send =
    io.send ??
    (async () => {
      throw new Error('Unexpected object-storage call');
    });
  try {
    await withScopedEnv(
      ['RIVET_RUNTIME_LIBRARIES_ROOT', 'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER'],
      { RIVET_RUNTIME_LIBRARIES_ROOT: root, RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: 'none' },
      run,
    );
  } finally {
    pg.Pool = originalPool;
    s3.S3Client.prototype.send = originalSend;
    hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = originalHook;
  }
}

const manifest = (version: string) => ({
  packages: { fixture: { name: 'fixture', version } },
  updatedAt: '',
  activeReleaseId: version,
});

for (const mode of ['API', 'bootstrap'])
  test(`${mode} synchronization replaces a cache whose checksum differs from the published artifact`, async () => {
    await withRoot(async (root) => {
      const declared = manifest('same-release');
      const previous = await publishRuntimeLibraryCandidate(root, await candidate(root, 'stale'), declared);
      const archive = await createRuntimeLibraryDirectoryArchive(await candidate(root, 'published'));
      const checksum = createHash('sha256').update(archive).digest('hex');
      const row = {
        release_id: declared.activeReleaseId,
        packages_json: declared.packages,
        artifact_blob_key: 'fixture.tar',
        artifact_sha256: checksum,
        updated_at: new Date(),
      };
      let downloads = 0;
      const getBuffer = async () => {
        downloads++;
        return archive;
      };
      const io = {
        query: async () => ({ rows: [row] }),
        send: async () => ({ Body: { transformToByteArray: getBuffer } }),
      };
      await withBootstrap(root, io, async () => {
        const controller =
          mode === 'API'
            ? new ManagedRuntimeLibrariesLocalCache(
                io as never,
                { getBuffer } as never,
                { syncPollIntervalMs: 60_000 } as never,
              )
            : (await import(new URL('./sync.mjs', bootstrapManifest).href)).createManagedRuntimeLibrariesSyncController(
                managedSettings,
              );
        const sync = () => (mode === 'API' ? controller.sync(true) : controller.syncCurrentRelease(true));
        try {
          const repaired = await sync();
          assert.equal(load(repaired).version, 'published');
          assert.equal(repaired.integrity, checksum);
          assert.equal(downloads, 1);
          assert.equal((await sync()).directory, repaired.directory);
          assert.equal(downloads, 1, 'A matching checksum preserves warm-cache reuse.');
          assert.equal(load(previous.snapshot).version, 'stale', 'An existing reader retains its own files.');
        } finally {
          if (mode === 'API') await controller.drain();
          else await controller.dispose();
        }
      });
    });
  });

async function candidate(root: string, version: string) {
  const directory = await fs.mkdtemp(path.join(root, 'candidate-'));
  await fs.mkdir(path.join(directory, 'node_modules', 'fixture'), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), '{"private":true}');
  await fs.writeFile(
    path.join(directory, 'node_modules', 'fixture', 'index.js'),
    `module.exports={version:${JSON.stringify(version)}};`,
  );
  return directory;
}

test('publishing generated metadata does not overwrite a hard-linked package file', async () => {
  await withRoot(async (root) => {
    const directory = await candidate(root, 'A');
    const packageFile = path.join(directory, 'node_modules', 'fixture', 'index.js');
    const original = await fs.readFile(packageFile, 'utf8');
    await fs.link(packageFile, path.join(directory, '.rivet-runtime-release.json'));
    const published = await publishRuntimeLibraryCandidate(root, directory, manifest('A'));
    assert.equal(load(published.snapshot).version, 'A');
    assert.equal(
      await fs.readFile(path.join(published.snapshot.directory, 'node_modules', 'fixture', 'index.js'), 'utf8'),
      original,
    );
  });
});

const load = (snapshot: RuntimeLibrarySnapshot) =>
  createRequire(snapshot.requireAnchorPath)('fixture') as { version: string };

test('concurrent publishers return their own immutable releases, including removal', async () => {
  await withRoot(async (root) => {
    const [a, b] = await Promise.all(
      ['A', 'B'].map(async (version) =>
        publishRuntimeLibraryCandidate(root, await candidate(root, version), manifest(version)),
      ),
    );
    assert.notEqual(a.snapshot.directory, b.snapshot.directory);
    assert.equal(load(a.snapshot).version, 'A');
    assert.equal(load(b.snapshot).version, 'B');
    const empty = await publishEmptyRuntimeRelease(root, { packages: {}, updatedAt: '' });
    assert.throws(() => createRequire(empty.snapshot.requireAnchorPath)('fixture'), /Cannot find module/);
    assert.equal(load(a.snapshot).version, 'A');
    assert.equal(load(b.snapshot).version, 'B');
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('cache-')).length, 3);
    assert.equal(selectRuntimeLibrarySource(root).snapshot!.directory, empty.snapshot.directory);
  });
});

test('legacy adoption retains its source and source exports select the physical release once', async () => {
  await withRoot(async (root) => {
    await fs.rename(await candidate(root, 'A'), path.join(root, 'current'));
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest('A')));
    const first = await prepareFilesystemRuntimeSnapshot(root);
    assert.ok(first);
    assert.equal(load(first).version, 'A');
    await fs.access(path.join(root, 'current', 'node_modules', 'fixture', 'index.js'));
    await fs.writeFile(path.join(root, 'active-release'), 'retained-legacy');
    await normalizeExtractedRuntimeLayout(root);
    const source = await readSourceRuntimeSelection(root);
    await publishRuntimeLibraryCandidate(root, await candidate(root, 'B'), manifest('B'));
    assert.equal(source.manifest.activeReleaseId, 'A');
    assert.equal(source.manifest.runtimeCache, undefined, 'Portable metadata excludes a local cache location.');
    const archive = await createRuntimeLibraryDirectoryArchive(source.directory!);
    const extracted = await extractRuntimeLibraryArchive(root, archive);
    try {
      assert.equal(createRequire(path.join(extracted.candidate, 'node_modules', '__read.cjs'))('fixture').version, 'A');
    } finally {
      await extracted.dispose();
    }
    assert.equal((await readSourceRuntimeSelection(root)).manifest.activeReleaseId, 'B');
    await publishEmptyRuntimeRelease(root, { packages: {}, updatedAt: '' });
    assert.deepEqual((await readSourceRuntimeSelection(root)).manifest.packages, {});
  });
});

test('a failed manifest publication never removes the previous physical release', async (context) => {
  await withRoot(async (root) => {
    const first = await publishRuntimeLibraryCandidate(root, await candidate(root, 'A'), manifest('A'));
    const original = fs.rename;
    context.mock.method(
      fs,
      'rename',
      async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
        if (String(to) === path.join(root, 'manifest.json')) throw new Error('synthetic publication failure');
        return original(from, to);
      },
    );
    await assert.rejects(
      publishRuntimeLibraryCandidate(root, await candidate(root, 'B'), manifest('B')),
      /publication failure/,
    );
    assert.equal(load(first.snapshot).version, 'A');
    assert.equal(selectRuntimeLibrarySource(root).manifest.activeReleaseId, 'A');
    context.mock.restoreAll();
  });
});

test('execution readers reject corrupt identity, escaping cache pointers and live-directory publication', async () => {
  await withRoot(async (root) => {
    const first = await publishRuntimeLibraryCandidate(root, await candidate(root, 'A'), manifest('A'));
    assert.throws(
      () => selectRuntimeLibrarySource(root, { ...first.manifest, activeReleaseId: 'B' }),
      /identity differs/,
    );
    assert.throws(
      () =>
        selectRuntimeLibrarySource(root, {
          ...first.manifest,
          runtimeCache: { ...first.manifest.runtimeCache!, directory: '../escape' },
        }),
      /cache reference/,
    );
    const live = path.join(root, 'current');
    await fs.rename(await candidate(root, 'B'), live);
    await assert.rejects(publishRuntimeLibraryCandidate(root, live, manifest('B')), /owned staging/);
    await fs.access(path.join(live, 'package.json'));
  });
});

test('mutable NODE_PATH cannot bypass a pinned empty hosted release', async () => {
  await withRoot(async (root) => {
    await withScopedEnv(['NODE_PATH'], { NODE_PATH: path.join(root, 'current', 'node_modules') }, async () => {
      await assert.rejects(publishEmptyRuntimeRelease(root, { packages: {}, updatedAt: '' }), /NODE_PATH/);
    });
  });
});

test('a missing manifest cannot erase the declaration of retained releases', async () => {
  await withRoot(async (root) => {
    const active = await publishRuntimeLibraryCandidate(root, await candidate(root, 'A'), manifest('A'));
    await fs.unlink(path.join(root, 'manifest.json'));
    await assert.rejects(prepareFilesystemRuntimeSnapshot(root), /manifest/);
    await assert.rejects(readSourceRuntimeSelection(root), /manifest/);
    assert.equal(load(active.snapshot).version, 'A');
    await assert.rejects(fs.access(path.join(root, 'manifest.json')), { code: 'ENOENT' });
  });
});

test('NODE_PATH aliases into a mutable runtime tree cannot bypass the snapshot guard', async () => {
  await withRoot(async (root) => {
    const runtime = path.join(root, 'runtime');
    const modules = path.join(runtime, 'current', 'node_modules');
    const alias = path.join(root, 'alias');
    await fs.mkdir(modules, { recursive: true });
    await fs.symlink(modules, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await withScopedEnv(['NODE_PATH'], { NODE_PATH: alias }, async () => {
      await assert.rejects(publishEmptyRuntimeRelease(runtime, { packages: {}, updatedAt: '' }), /NODE_PATH/);
    });
  });
});

test('drain waits for a forced round accepted as the preceding round settles', { timeout: 5000 }, async () => {
  const first = gate(),
    second = gate(),
    secondStarted = gate();
  let calls = 0;
  const sync = createRuntimeLibrarySync(async () => {
    if (++calls === 1) await first.promise;
    else {
      secondStarted.resolve();
      await second.promise;
    }
    return calls;
  }, 60_000);
  const initial = sync.sync();
  let drained = false;
  const drain = sync.drain().then(() => {
    drained = true;
  });
  let forced!: Promise<number>;
  first.promise.then(() =>
    queueMicrotask(() => {
      forced = sync.sync(true);
    }),
  );
  first.resolve();
  await secondStarted.promise;
  try {
    await Promise.resolve();
    assert.equal(drained, false, 'The accepted follow-up round still owns its IO clients.');
  } finally {
    second.resolve();
    await Promise.all([initial, forced, drain]);
  }
});

test('invalid links and insufficient extraction space leave the active release intact', async (context) => {
  await withRoot(async (root) => {
    const active = await publishRuntimeLibraryCandidate(root, await candidate(root, 'A'), manifest('A'));
    const pending = await candidate(root, 'B');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'owned elsewhere');
    await fs.symlink(outside, path.join(pending, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(publishRuntimeLibraryCandidate(root, pending, manifest('B')), /symlink escapes/);
    const archive = await createRuntimeLibraryDirectoryArchive(active.snapshot.directory);
    context.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }) as never);
    await assert.rejects(extractRuntimeLibraryArchive(root, archive), /Insufficient runtime-library cache space/);
    assert.equal(load(active.snapshot).version, 'A');
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'owned elsewhere');
    context.mock.restoreAll();
  });
});

test('archive-root hard links and drive-relative paths cannot escape extraction', async () => {
  await withRoot(async (root) => {
    for (const entry of [
      { path: 'nested/link', type: 'Link' as const, linkpath: '../outside' },
      { path: 'C:outside', type: 'File' as const },
    ]) {
      const header = new tar.Header({ ...entry, mode: 0o644, size: 0 });
      header.encode();
      await assert.rejects(
        extractRuntimeLibraryArchive(root, Buffer.concat([header.block!, Buffer.alloc(1024)])),
        /unsafe path/,
      );
    }
    assert.deepEqual(await fs.readdir(path.join(root, 'jobs')), []);
  });
});

test('forced synchronization coalesces waiters and never overlaps follow-up rounds', async () => {
  const first = gate(),
    second = gate(),
    secondStarted = gate();
  let calls = 0,
    running = 0,
    peak = 0;
  const sync = createRuntimeLibrarySync(async () => {
    const call = ++calls;
    peak = Math.max(peak, ++running);
    if (call === 1) await first.promise;
    if (call === 2) {
      secondStarted.resolve();
      await second.promise;
    }
    running--;
    return call;
  }, 60_000);
  const one = sync.sync();
  const two = sync.sync(true);
  const three = sync.sync(true);
  first.resolve();
  await secondStarted.promise;
  assert.equal(calls, 2);
  second.resolve();
  assert.deepEqual(await Promise.all([one, two, three]), [2, 2, 2]);
  assert.equal(peak, 1);
  assert.equal(await sync.sync(false), 2);
  assert.equal(calls, 2);
});

test('failed synchronization is retriable without a stuck promise, and drain waits for accepted work', async () => {
  const started = gate(),
    finish = gate();
  let calls = 0;
  const sync = createRuntimeLibrarySync(async () => {
    if (++calls === 1) throw new Error('synthetic read failure');
    started.resolve();
    await finish.promise;
    return calls;
  }, 60_000);
  await assert.rejects(sync.sync(), /synthetic read failure/);
  const recovered = sync.sync();
  await started.promise;
  let drained = false;
  const drain = sync.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  finish.resolve();
  assert.equal(await recovered, 2);
  await drain;
  assert.equal(drained, true);
});

test(
  'another cache process and a crash after publication cannot move an already bound reader',
  { timeout: 30_000 },
  async () => {
    await withRoot(async (root) => {
      await publishRuntimeLibraryCandidate(root, await candidate(root, 'A'), manifest('A'));
      const helper = import.meta.resolve('@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache');
      const script = path.join(root, 'process.mjs');
      await fs.writeFile(
        script,
        `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import {createRequire} from 'node:module';
      import {prepareFilesystemRuntimeSnapshot, publishRuntimeLibraryCandidate} from ${JSON.stringify(helper)};
      const [mode, root, candidate] = process.argv.slice(2);
      if (mode === 'reader') {
        const selected = await prepareFilesystemRuntimeSnapshot(root);
        const require = createRequire(selected.requireAnchorPath);
        const state = require('fixture');
        process.send({version:state.version});
        process.once('message', () => {
          process.send({version:require('fixture').version, same:state === require('fixture')});
          process.disconnect();
        });
      } else {
        const rename = fs.rename;
        fs.rename = async (from, to) => {
          await rename(from, to);
          if (to === path.join(root,'manifest.json')) process.exit(17);
        };
        await publishRuntimeLibraryCandidate(root, candidate, {
          packages:{fixture:{name:'fixture',version:'B'}}, updatedAt:'',activeReleaseId:'B'});
      }
    `,
      );
      const child = (mode: string, directory = '') =>
        spawn(process.execPath, [script, mode, root, directory], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      const reader = child('reader');
      const readerClosed = once(reader, 'close');
      let crash: ReturnType<typeof child> | undefined;
      let crashClosed: Promise<unknown> | undefined;
      try {
        assert.deepEqual((await once(reader, 'message'))[0], { version: 'A' });
        crash = child('crash', await candidate(root, 'B'));
        crashClosed = once(crash, 'close');
        assert.equal((await once(crash, 'exit'))[0], 17);
        const check = once(reader, 'message');
        reader.send('check');
        assert.deepEqual((await check)[0], { version: 'A', same: true });
        const restarted = await prepareFilesystemRuntimeSnapshot(root);
        assert.equal(load(restarted!).version, 'B');
        assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('cache-')).length, 2);
      } finally {
        if (reader.exitCode === null && reader.signalCode === null) reader.kill();
        if (crash && crash.exitCode === null && crash.signalCode === null) crash.kill();
        await Promise.all([readerClosed, crashClosed]);
      }
    });
  },
);

test('a supported native addon remains loadable from two retained releases', async (context) => {
  const target = process.platform === 'win32' ? 'msvc' : process.platform === 'linux' ? 'gnu' : '';
  let binary: string;
  try {
    const nodeRequire = createRequire(import.meta.resolve('@valerypopoff/rivet2-node'));
    const swcRequire = createRequire(nodeRequire.resolve('@swc/core'));
    binary = swcRequire.resolve(`@swc/core-${process.platform}-${process.arch}${target ? '-' + target : ''}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    context.skip('The development native addon is unavailable in this runtime-only installation.');
    return;
  }
  await withRoot(async (root) => {
    const native = async (version: string) => {
      const directory = await candidate(root, version);
      const pkg = path.join(directory, 'node_modules', 'fixture');
      await fs.copyFile(binary, path.join(pkg, 'binding.node'));
      await fs.writeFile(path.join(pkg, 'index.js'), `module.exports=require('./binding.node');`);
      return (await publishRuntimeLibraryCandidate(root, directory, manifest(version))).snapshot;
    };
    const first = await native('A');
    const second = await native('B');
    // Windows keeps native libraries locked until their process exits. Loading
    // in a child also proves the normal Node runtime, outside the TS test loader.
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const a = createRequire(${JSON.stringify(first.requireAnchorPath)});
      const older = a('fixture');
      const newer = createRequire(${JSON.stringify(second.requireAnchorPath)})('fixture');
      assert.equal(newer.getTargetTriple(), older.getTargetTriple());
      assert.equal(a('fixture'), older);
    `,
        ],
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  });
});

test('the bootstrap controller coalesces forced sync and returns the exact prepared release', async () => {
  await withRoot(async (root) => {
    const first = gate(),
      second = gate(),
      secondStarted = gate();
    let calls = 0,
      active = 0,
      peak = 0;
    const query = async () => {
      const call = ++calls;
      peak = Math.max(peak, ++active);
      if (call === 1) await first.promise;
      else {
        secondStarted.resolve();
        await second.promise;
      }
      active--;
      return { rows: [{ release_id: String(call), packages_json: {}, updated_at: new Date() }] };
    };
    await withBootstrap(root, { query }, async () => {
      const { createManagedRuntimeLibrariesSyncController } = await import(
        new URL('./sync.mjs', bootstrapManifest).href
      );
      const controller = createManagedRuntimeLibrariesSyncController(managedSettings);
      try {
        const requests = [
          controller.syncCurrentRelease(),
          controller.syncCurrentRelease(true),
          controller.syncCurrentRelease(true),
        ];
        first.resolve();
        await secondStarted.promise;
        second.resolve();
        const prepared = await Promise.all(requests);
        assert.equal(peak, 1);
        assert.equal(calls, 2);
        for (const snapshot of prepared) assert.equal(snapshot.releaseId, '2');
        assert.equal(selectRuntimeLibrarySource(root).snapshot!.directory, prepared[0].directory);
      } finally {
        first.resolve();
        second.resolve();
        await controller.dispose();
      }
    });
  });
});

for (const immediate of [false, true])
  test(
    `concurrent bootstrap disposal waits for ${immediate ? 'same-turn startup' : 'initialization'} before closing its clients once`,
    { timeout: 5000 },
    async () => {
      await withRoot(async (root) => {
        const entered = gate(),
          release = gate();
        let closed = 0;
        await withBootstrap(
          root,
          {
            query: async () => {
              assert.equal(closed, 0, 'Initialization must retain its pool.');
              return { rows: [] };
            },
            send: async () => {
              entered.resolve();
              await release.promise;
              return {};
            },
            end: async () => {
              closed++;
            },
          },
          async () => {
            const owner = await import(new URL('./runtime-libraries-sync.mjs', bootstrapManifest).href);
            const starting = owner.startManagedRuntimeLibrariesFromSettings(managedSettings);
            if (!immediate) await entered.promise;
            const first = owner.disposeManagedRuntimeLibrariesSync();
            const second = owner.disposeManagedRuntimeLibrariesSync();
            try {
              await new Promise<void>((resolve) => setImmediate(resolve));
              assert.equal(closed, 0);
              release.resolve();
              await Promise.all([starting, first, second]);
              assert.equal(closed, 1);
            } finally {
              release.resolve();
              await Promise.allSettled([starting, first, second]);
            }
          },
        );
      });
    },
  );
