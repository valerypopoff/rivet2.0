import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';

test('local artifacts are content-addressed, durable before return, and idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifacts-'));
  try {
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    const source = path.join(root, 'source.rivet-project');
    const contents = Buffer.from('saved workflow contents');
    await fs.writeFile(source, contents);

    const [first, concurrent] = await Promise.all([store.putBytes(contents), store.putFile(source)]);
    assert.deepEqual(first, concurrent);
    assert.equal(first.hash, createHash('sha256').update(contents).digest('hex'));
    assert.equal(first.size, contents.length);
    assert.deepEqual(await store.read(first.hash), contents);
    assert.deepEqual(await store.putFile(source), first);
    assert.deepEqual(await fs.readdir(path.join(root, 'objects', first.hash.slice(0, 2))), [first.hash]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifacts reject corrupt pre-existing content instead of replacing it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifacts-'));
  try {
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    const contents = Buffer.from('correct bytes');
    const artifact = await store.putBytes(contents);
    await fs.writeFile(path.join(root, 'objects', artifact.hash.slice(0, 2), artifact.hash), 'broken bytes!');
    await assert.rejects(store.putBytes(contents), /failed its checksum/);
    await assert.rejects(store.read(artifact.hash), /failed its checksum/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifacts reject symlinked storage paths and source files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifacts-'));
  try {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const linkedRoot = path.join(root, 'objects');
    await fs.symlink(outside, linkedRoot, 'dir');
    const store = new ImmutableLocalArtifactStore(linkedRoot);
    await assert.rejects(store.putBytes(Buffer.from('data')), /not a real directory/);

    const source = path.join(root, 'source');
    await fs.writeFile(source, 'source bytes');
    const linkedSource = path.join(root, 'source-link');
    await fs.symlink(source, linkedSource);
    const safeStore = new ImmutableLocalArtifactStore(path.join(root, 'safe-objects'));
    await assert.rejects(safeStore.putFile(linkedSource), /regular file/);

    const artifact = await safeStore.putBytes(Buffer.from('safe data'));
    const shard = path.join(root, 'safe-objects', artifact.hash.slice(0, 2));
    const movedShard = path.join(root, 'moved-shard');
    await fs.rename(shard, movedShard);
    await fs.symlink(movedShard, shard, 'dir');
    await assert.rejects(safeStore.read(artifact.hash), /not a real directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifacts ignore abandoned staging files and reject invalid lookup keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifacts-'));
  try {
    const objects = path.join(root, 'objects');
    await fs.mkdir(path.join(objects, '.staging'), { recursive: true });
    await fs.writeFile(path.join(objects, '.staging', 'interrupted-write'), 'incomplete');
    const store = new ImmutableLocalArtifactStore(objects);
    const artifact = await store.putBytes(Buffer.from('complete'));
    assert.deepEqual(await store.read(artifact.hash), Buffer.from('complete'));
    await assert.rejects(store.read('../outside'), /Invalid local artifact hash/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifact file copies preserve multi-chunk and empty content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifacts-'));
  try {
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    const source = path.join(root, 'large-source');
    const contents = Buffer.alloc(256 * 1024 + 7);
    for (let index = 0; index < contents.length; index += 1) contents[index] = index % 251;
    await fs.writeFile(source, contents);
    const copied = await store.putFile(source);
    assert.equal(copied.size, contents.length);
    assert.deepEqual(await store.read(copied.hash), contents);

    await fs.writeFile(source, Buffer.alloc(0));
    const empty = await store.putFile(source);
    assert.equal(empty.size, 0);
    assert.deepEqual(await store.read(empty.hash), Buffer.alloc(0));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifact reads and retries reject path replacement before or during a read', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifact-race-'));
  try {
    for (const phase of ['before-open', 'after-open'] as const) {
      for (const operation of ['read', 'retry'] as const) {
        const objects = path.join(root, `${phase}-${operation}`);
        const store = new ImmutableLocalArtifactStore(objects);
        const contents = Buffer.from('same bytes, different inode');
        const artifact = await store.putBytes(contents);
        const filePath = path.join(objects, artifact.hash.slice(0, 2), artifact.hash);
        const originalOpen = fs.open.bind(fs);
        let replaced = false;
        const intercepted = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
          if (args[0] !== filePath || replaced) return originalOpen(...args);
          replaced = true;
          const handle = phase === 'after-open' ? await originalOpen(...args) : null;
          await fs.rename(filePath, `${filePath}.old`);
          await fs.copyFile(`${filePath}.old`, filePath);
          return handle ?? originalOpen(...args);
        });
        try {
          await assert.rejects(
            operation === 'read' ? store.read(artifact.hash) : store.putBytes(contents),
            /changed before|changed while/,
          );
          assert.equal(replaced, true);
        } finally {
          intercepted.mock.restore();
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifact publication syncs every newly created ancestor directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifact-directories-'));
  const opened: string[] = [];
  const originalOpen = fs.open.bind(fs);
  const intercepted = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    opened.push(String(args[0]));
    return originalOpen(...args);
  });
  try {
    const store = new ImmutableLocalArtifactStore(path.join(root, 'nested', 'candidate', 'objects'));
    const contents = Buffer.from('nested artifact');
    const artifact = await store.putBytes(contents);
    assert.deepEqual(await store.read(artifact.hash), contents);
    for (const directory of [root, path.join(root, 'nested'), path.join(root, 'nested', 'candidate')]) {
      assert.ok(opened.includes(directory), `Directory was not opened for sync: ${directory}`);
    }
  } finally {
    intercepted.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local artifact verification accepts harmless staging hard-link cleanup during a read', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-artifact-link-race-'));
  const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
  const contents = Buffer.from('immutable bytes');
  try {
    const artifact = await store.putBytes(contents);
    const filePath = path.join(root, 'objects', artifact.hash.slice(0, 2), artifact.hash);
    const alias = path.join(root, 'temporary-link');
    const originalOpen = fs.open.bind(fs);
    let cleaned = false;
    const intercepted = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === filePath && !cleaned) {
        cleaned = true;
        await fs.link(filePath, alias);
        await fs.unlink(alias);
      }
      return originalOpen(...args);
    });
    try {
      assert.deepEqual(await store.read(artifact.hash), contents);
      assert.equal(cleaned, true);
    } finally {
      intercepted.mock.restore();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
