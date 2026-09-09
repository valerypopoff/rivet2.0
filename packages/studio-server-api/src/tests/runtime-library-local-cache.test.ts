import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as tar from 'tar';

import { ManagedRuntimeLibrariesLocalCache } from '../runtime-libraries/managed/local-cache.js';
import { readManifest } from '../runtime-libraries/manifest.js';
import type { ManagedRuntimeLibrariesConfig } from '../runtime-libraries/config.js';

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
    await fs.access(path.join(runtimeRoot, 'current', 'marker.txt'));
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.RIVET_RUNTIME_LIBRARIES_ROOT;
    } else {
      process.env.RIVET_RUNTIME_LIBRARIES_ROOT = previousRuntimeRoot;
    }
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
