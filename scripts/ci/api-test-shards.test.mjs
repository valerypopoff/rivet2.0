import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { defaultApiTestFiles } from '../../deploy/studio-server/scripts/api-test-files.mjs';
import {
  listApiTestFiles,
  parseApiTestOptions,
  selectApiTestShard,
  verifyApiTestManifest,
} from '../../deploy/studio-server/scripts/run-api-tests.mjs';

test('four API shards cover every default test exactly once in manifest order', () => {
  verifyApiTestManifest();
  const shards = Array.from({ length: 4 }, (_value, shardIndex) =>
    selectApiTestShard(defaultApiTestFiles, shardIndex, 4),
  );
  assert.deepEqual(shards.flat().sort(), [...defaultApiTestFiles].sort());
  for (let shardIndex = 0; shardIndex < 4; shardIndex += 1) {
    assert.deepEqual(
      shards[shardIndex],
      defaultApiTestFiles.filter((_file, index) => index % 4 === shardIndex),
    );
  }
  assert.equal(new Set(shards.flat()).size, defaultApiTestFiles.length);
});

test('API manifest discovery includes nested test files and excludes unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-api-tests-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'root.test.ts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'child.test.ts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'module.test.mts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'common.test.cts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'component.test.tsx'), '');
    fs.writeFileSync(path.join(root, 'nested', 'contract.spec.ts'), '');
    fs.writeFileSync(path.join(root, 'nested', 'fixture.ts'), '');

    assert.deepEqual(listApiTestFiles(root), [
      'src/tests/nested/child.test.ts',
      'src/tests/nested/common.test.cts',
      'src/tests/nested/component.test.tsx',
      'src/tests/nested/contract.spec.ts',
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
  assert.throws(() => selectApiTestShard(defaultApiTestFiles, 0, Infinity), /shardCount/);
  assert.throws(() => selectApiTestShard(defaultApiTestFiles, 0, Number.MAX_SAFE_INTEGER + 1), /shardCount/);
});

test('API CLI rejects malformed and ambiguous options even in check mode', () => {
  assert.deepEqual(parseApiTestOptions([]), { shardIndex: 0, shardCount: 1, check: false });
  assert.deepEqual(parseApiTestOptions(['--', '--check']), { shardIndex: 0, shardCount: 1, check: true });
  assert.deepEqual(parseApiTestOptions(['--check', '--shard-index', '2', '--shard-count', '4']), {
    shardIndex: 2,
    shardCount: 4,
    check: true,
  });
  for (const args of [
    ['--check', '--shard-count', '0'],
    ['--check', '--shard-index', '4', '--shard-count', '4'],
    ['--shard-index'],
    ['--shard-index', ''],
    ['--shard-index', '1.0'],
    ['--shard-count', '9007199254740992'],
    ['--shard-index', '0', '--shard-index', '1'],
    ['--check', '--check'],
    ['--shard-cout', '4'],
    ['--check', '--'],
  ])
    assert.throws(() => parseApiTestOptions(args));
});

test('API CLI supports Yarn script argument forwarding and rejects invalid check coordinates', () => {
  const rootDir = fileURLToPath(new URL('../../', import.meta.url));
  const yarnPath = path.join(rootDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');
  for (const shardCount of ['4', '0']) {
    const result = spawnSync(
      process.execPath,
      [
        yarnPath,
        'workspace',
        '@valerypopoff/rivet-studio-server-api',
        'run',
        'test',
        '--',
        '--check',
        '--shard-count',
        shardCount,
      ],
      { cwd: rootDir, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, shardCount === '4' ? 0 : 1, result.stdout + result.stderr);
    if (shardCount === '4') assert.match(result.stdout, /Manifest covers/);
    else assert.match(result.stderr, /shardCount must be a positive integer/);
  }
});

test('API runner executes its selected tests with pinned Yarn, not a global shim', () => {
  const rootDir = fileURLToPath(new URL('../../', import.meta.url));
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-broken-yarn-'));
  try {
    fs.writeFileSync(path.join(shimDir, 'yarn'), '#!/bin/sh\necho GLOBAL_YARN_USED >&2\nexit 91\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shimDir, 'yarn.cmd'), '@echo GLOBAL_YARN_USED 1>&2\r\n@exit /b 91\r\n');
    const selectedIndex = defaultApiTestFiles.indexOf('src/tests/hosted-editor-seams.test.ts');
    assert.ok(selectedIndex >= 0);
    const env = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` };
    // This is a standalone CLI invocation, not a nested Node test worker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'run-api-tests.mjs'),
        '--shard-index',
        String(selectedIndex),
        '--shard-count',
        String(defaultApiTestFiles.length),
      ],
      {
        cwd: rootDir,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 files/);
    assert.match(result.stdout, /# pass [1-9]\d*\b/);
    assert.match(result.stdout, /# fail 0\b/);
    assert.doesNotMatch(result.stderr, /GLOBAL_YARN_USED/);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});
