import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listAppTestFiles, selectAppTestShard } from './run-app-tests.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yarnPath = path.join(rootDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');

test('four App shards cover every discovered test exactly once in lexical order', () => {
  const files = ['src/a.test.ts', 'src/b.spec.tsx', 'src/nested/c.test.mts', 'src/nested/d.test.cts', 'src/z.test.ts'];
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

    assert.deepEqual(listAppTestFiles(root), ['src/nested/child.test.mts', 'src/root.spec.tsx', 'src/root.test.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('App shard selection rejects invalid coordinates', () => {
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], -1, 4), /shardIndex/);
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], 4, 4), /shardIndex/);
  assert.throws(() => selectAppTestShard(['src/a.test.ts'], 0, 0), /shardCount/);
});

test('App test preload provides browser asset modules to Node component tests', () => {
  const root = fs.mkdtempSync(path.join(rootDir, 'packages', 'app', '.test-browser-assets-'));
  try {
    const svgPath = path.join(root, 'icon.svg');
    const entryPath = path.join(root, 'entry.mjs');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" />');
    fs.writeFileSync(
      entryPath,
      [
        "import Icon from './icon.svg?react';",
        "import iconUrl from './icon.svg';",
        "console.log(JSON.stringify({ componentType: typeof Icon, isFileUrl: iconUrl.startsWith('file:') }));",
      ].join('\n'),
    );

    const preloadUrl = pathToFileURL(
      path.join(rootDir, 'packages', 'app', 'scripts', 'register-test-browser-assets.mjs'),
    ).href;
    const result = spawnSync(process.execPath, ['--import', preloadUrl, entryPath], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      componentType: 'function',
      isFileUrl: true,
    });

    const packageTestPath = path.join(root, 'package-icon.test.tsx');
    fs.writeFileSync(
      packageTestPath,
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import Icon from 'majesticons/line/search-line.svg?react';",
        "import Glyph from '@atlaskit/icon/glyph/cross';",
        "import Portal from '@atlaskit/portal';",
        "import Collapsible from 'react-collapsible';",
        "import Select from '@atlaskit/select';",
        "test('package browser assets are components', () => {",
        "  assert.equal(typeof Icon, 'function');",
        "  assert.equal(typeof Glyph, 'function');",
        "  assert.equal(typeof Portal, 'function');",
        "  assert.equal(typeof Collapsible, 'function');",
        "  assert.equal(typeof Select, 'function');",
        '});',
      ].join('\n'),
    );
    const packageAssetResult = spawnSync(
      process.execPath,
      [
        yarnPath,
        'workspace',
        '@valerypopoff/rivet-app',
        'exec',
        'tsx',
        '--import',
        preloadUrl,
        '--test',
        packageTestPath,
      ],
      {
        cwd: rootDir,
        encoding: 'utf8',
      },
    );
    assert.equal(packageAssetResult.status, 0, packageAssetResult.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
