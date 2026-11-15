import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as tar from 'tar';

import { ManagedRuntimeLibrariesLocalCache } from '../runtime-libraries/managed/local-cache.js';
import { readManifest } from '../runtime-libraries/manifest.js';
import { selectRuntimeLibrarySource } from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import type { ManagedRuntimeLibrariesConfig } from '../runtime-libraries/config.js';
import { createRequire } from 'node:module';
import { withScopedEnv } from './helpers/runtime-library-harness.js';

// test-style: fixture-read: verifies only package archives and cache files created by this test.

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createReleaseArchive(marker: string): Promise<Buffer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-library-local-cache-archive-'));
  const source = path.join(root, 'source');
  const archivePath = path.join(root, 'release.tar');

  try {
    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(source, 'node_modules', 'fixture'));
    await fs.writeFile(
      path.join(source, 'node_modules', 'fixture', 'index.js'),
      `module.exports=${JSON.stringify(marker)};`,
    );
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: marker }), 'utf8');
    await fs.writeFile(path.join(source, 'marker.txt'), marker, 'utf8');
    await tar.c({ cwd: source, file: archivePath, portable: true, noMtime: true }, ['.']);
    const archive = await fs.open(archivePath, 'r');
    try {
      const { size } = await archive.stat();
      const contents = Buffer.alloc(size);
      await archive.read(contents, 0, size, 0);
      return contents;
    } finally {
      await archive.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('a forced local-cache refresh waits for an older sync and publishes the newer release last', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-library-local-cache-root-'));
  const previousRuntimeRoot = process.env.RIVET_RUNTIME_LIBRARIES_ROOT;
  process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeRoot;

  const oldArchive = await createReleaseArchive('old');
  const newArchive = await createReleaseArchive('new');
  const oldBlobReadStarted = createDeferred<void>();
  const releaseOldBlobRead = createDeferred<void>();
  let releaseQueries = 0;
  let oldBlobReadFinished = false;
  let newerReadWhileOlderBlocked = false;
  let activeRelease = {
    release_id: 'release-old',
    packages_json: { fixture: { version: '1.0.0' } },
    artifact_blob_key: 'releases/release-old/release.tar',
    artifact_sha256: null,
    created_at: '2026-09-09T00:00:00.000Z',
    updated_at: '2026-09-09T00:00:00.000Z',
  };

  const cache = new ManagedRuntimeLibrariesLocalCache(
    {
      async query() {
        releaseQueries += 1;
        return { rows: [{ ...activeRelease }], rowCount: 1 };
      },
    } as never,
    {
      async getBuffer(key: string) {
        if (key === 'releases/release-old/release.tar') {
          oldBlobReadStarted.resolve();
          await releaseOldBlobRead.promise;
          oldBlobReadFinished = true;
          return oldArchive;
        }

        if (key === 'releases/release-new/release.tar') {
          newerReadWhileOlderBlocked ||= !oldBlobReadFinished;
          return newArchive;
        }

        throw new Error(`Unexpected artifact key ${key}`);
      },
      async putBuffer() {},
    },
    { syncPollIntervalMs: 60_000 } as ManagedRuntimeLibrariesConfig,
  );

  try {
    const olderSync = cache.sync(false);
    await oldBlobReadStarted.promise;

    activeRelease = {
      ...activeRelease,
      release_id: 'release-new',
      artifact_blob_key: 'releases/release-new/release.tar',
    };
    cache.reset();
    const forcedRefresh = cache.sync(true);
    const concurrentForcedRefresh = cache.sync(true);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(newerReadWhileOlderBlocked, false);

    releaseOldBlobRead.resolve();
    await Promise.all([olderSync, forcedRefresh, concurrentForcedRefresh]);

    assert.equal(releaseQueries, 2);
    assert.equal(readManifest().activeReleaseId, 'release-new');
    const selected = selectRuntimeLibrarySource(runtimeRoot);
    assert.equal(await fs.readFile(path.join(selected.directory!, 'marker.txt'), 'utf8'), 'new');
    assert.equal((await fs.readdir(runtimeRoot)).filter((name) => name.startsWith('cache-')).length, 2);
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.RIVET_RUNTIME_LIBRARIES_ROOT;
    } else {
      process.env.RIVET_RUNTIME_LIBRARIES_ROOT = previousRuntimeRoot;
    }
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('managed initialization uses the authoritative archive rather than trusting matching legacy metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-legacy-cache-'));
  try {
    await withScopedEnv(['RIVET_RUNTIME_LIBRARIES_ROOT'], { RIVET_RUNTIME_LIBRARIES_ROOT: root }, async () => {
      const packages = { fixture: { name: 'fixture', version: '1.0.0' } };
      await fs.mkdir(path.join(root, 'current', 'node_modules', 'fixture'), { recursive: true });
      await fs.writeFile(path.join(root, 'current', 'package.json'), '{}');
      await fs.writeFile(path.join(root, 'current', 'node_modules', 'fixture', 'index.js'), 'module.exports="stale";');
      await fs.writeFile(
        path.join(root, 'manifest.json'),
        JSON.stringify({ packages, activeReleaseId: 'A', updatedAt: '' }),
      );
      const archive = await createReleaseArchive('authoritative');
      let downloads = 0;
      const cache = new ManagedRuntimeLibrariesLocalCache(
        {
          query: async () => ({ rows: [{ release_id: 'A', packages_json: packages, artifact_blob_key: 'A.tar' }] }),
        } as never,
        {
          getBuffer: async () => {
            downloads++;
            return archive;
          },
        } as never,
        { syncPollIntervalMs: 60_000 } as ManagedRuntimeLibrariesConfig,
      );
      const first = await cache.sync(true);
      assert.equal(createRequire(first.requireAnchorPath)('fixture'), 'authoritative');
      assert.equal(downloads, 1);
      const second = await cache.sync(true);
      assert.equal(first.directory, second.directory);
      assert.equal(downloads, 1, 'A validated current-format cache does not need another download.');
      await fs.unlink(path.join(root, 'manifest.json'));
      const repaired = await cache.sync(true);
      assert.equal(createRequire(repaired.requireAnchorPath)('fixture'), 'authoritative');
      assert.equal(downloads, 2, 'Lost cache metadata is rebuilt from authority, without changing old runs.');
      assert.equal(
        createRequire(path.join(root, 'current', 'package.json'))('fixture'),
        'stale',
        'Legacy readers retain their original files.',
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
