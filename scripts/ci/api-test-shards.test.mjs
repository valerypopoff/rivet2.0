import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultApiTestFiles } from '../../deploy/studio-server/scripts/api-test-files.mjs';
import {
  listApiTestFiles,
  selectApiTestShard,
  verifyApiTestManifest,
} from '../../deploy/studio-server/scripts/run-api-tests.mjs';

test('four API shards cover every default test exactly once in manifest order', () => {
  verifyApiTestManifest();
  const shards = Array.from({ length: 4 }, (_value, shardIndex) =>
    selectApiTestShard(defaultApiTestFiles, shardIndex, 4),
  );
  const flattened = defaultApiTestFiles.filter((_file, index) =>
    shards[index % 4].includes(defaultApiTestFiles[index]),
  );
  assert.deepEqual(flattened, defaultApiTestFiles);
  assert.equal(new Set(shards.flat()).size, defaultApiTestFiles.length);
});

test('API manifest discovery includes nested test files and excludes unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-api-tests-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'root.test.ts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'child.test.ts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'module.test.mts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'fixture.ts'), '');

    assert.deepEqual(listApiTestFiles(root), [
      'src/tests/nested/child.test.ts',
      'src/tests/nested/module.test.mts',
      'src/tests/root.test.ts',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API shard selection rejects invalid coordinates', () => {
  assert.throws(() => selectApiTestShard(defaultApiTestFiles, -1, 4), /shardIndex/);
  assert.throws(() => selectApiTestShard(defaultApiTestFiles, 4, 4), /shardIndex/);
  assert.throws(() => selectApiTestShard(defaultApiTestFiles, 0, 0), /shardCount/);
});
