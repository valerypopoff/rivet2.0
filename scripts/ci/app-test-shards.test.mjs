import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listAppTestFiles, selectAppTestShard } from './run-app-tests.mjs';

test('four App shards cover every discovered test exactly once in lexical order', () => {
  const files = [
    'src/a.test.ts',
    'src/b.spec.tsx',
    'src/nested/c.test.mts',
    'src/nested/d.test.cts',
    'src/z.test.ts',
  ];
  const shards = Array.from({ length: 4 }, (_value, shardIndex) => selectAppTestShard(files, shardIndex, 4));

  assert.deepEqual(shards.flat(), [
    'src/a.test.ts',
    'src/z.test.ts',
    'src/b.spec.tsx',
    'src/nested/c.test.mts',
    'src/nested/d.test.cts',
  ]);
  assert.equal(new Set(shards.flat()).size, files.length);
});

test('App test discovery includes supported nested test suffixes and excludes source files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-app-tests-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'root.test.ts'), '');
    fs.writeFileSync(path.join(root, 'root.spec.tsx'), '');
    fs.writeFileSync(path.join(root, 'nested', 'child.test.mts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'fixture.ts'), '');

    assert.deepEqual(listAppTestFiles(root), [
      'src/nested/child.test.mts',
      'src/root.spec.tsx',
      'src/root.test.ts',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('App shard selection rejects invalid coordinates', () => {
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], -1, 4), /shardIndex/);
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], 4, 4), /shardIndex/);
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], 0, 0), /shardCount/);
});
