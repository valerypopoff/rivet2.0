import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  appTestPrerequisite,
  createAppTestCommands,
  listAppTestFiles,
  listDiscoveredAppTests,
  runAppTests,
  selectAppTestShard,
} from './run-app-tests.mjs';

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

test('full App runs and shards explicitly execute every supported suffix once in bounded batches', () => {
  const suffixes = ['test.ts', 'spec.ts', 'test.tsx', 'spec.tsx', 'test.mts', 'spec.mts', 'test.cts', 'spec.cts'];
  const files = Array.from(
    { length: 140 },
    (_value, index) => `src/nested/component-${index}.${suffixes[index % suffixes.length]}`,
  );
  for (const shardCount of [1, 4]) {
    const executions = [];
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
      const commands = createAppTestCommands(files, shardIndex, shardCount);
      for (const command of commands) {
        assert.deepEqual(command.slice(0, 5), ['workspace', '@valerypopoff/rivet-app', 'run', 'test:files', '--']);
        assert.ok(command.length > 5 && command.length <= 37, 'Every invocation has 1–32 explicitly selected files.');
      }
      const selected = commands.flatMap((command) => command.slice(5));
      assert.deepEqual(selected, selectAppTestShard(files, shardIndex, shardCount));
      executions.push(...selected);
    }
    assert.deepEqual(executions.sort(), [...files].sort());
    assert.equal(new Set(executions).size, files.length);
  }
  assert.throws(() => createAppTestCommands([], 0, 1), /empty/);
});

test('App prerequisites build locally, validate CI artifacts, and fail closed before testing', async () => {
  assert.deepEqual(appTestPrerequisite(), ['workspace', '@valerypopoff/rivet2-core', 'run', 'build:esm']);
  assert.deepEqual(appTestPrerequisite('prebuilt'), ['check:compiled-workspace-exports']);
  for (const invalid of ['', 'true', 'skip', 'prebuit']) assert.throws(() => appTestPrerequisite(invalid));
  const invalidMode = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-app-tests.mjs', import.meta.url)), '--check'],
    {
      cwd: rootDir,
      env: { ...process.env, RIVET_APP_TEST_DEPENDENCIES: 'skip' },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(invalidMode.status, 1, invalidMode.stdout + invalidMode.stderr);
  assert.match(invalidMode.stderr, /must be build or prebuilt/);

  const commands = [];
  await runAppTests({ shardIndex: 0, shardCount: 4, dependencies: 'prebuilt' }, async (command) => {
    commands.push(command);
  });
  assert.deepEqual(commands[0], ['check:compiled-workspace-exports']);
  assert.deepEqual(commands.slice(1), createAppTestCommands(listDiscoveredAppTests(), 0, 4));
  assert.deepEqual(commands[1].slice(0, 5), ['workspace', '@valerypopoff/rivet-app', 'run', 'test:files', '--']);

  commands.length = 0;
  const missingArtifact = new Error('Compiled export missing');
  await assert.rejects(
    runAppTests({ dependencies: 'prebuilt' }, async (command) => {
      commands.push(command);
      throw missingArtifact;
    }),
    (error) => error === missingArtifact,
  );
  assert.deepEqual(commands, [['check:compiled-workspace-exports']], 'No tests start after artifact validation fails.');
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
      timeout: 30_000,
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
        timeout: 30_000,
      },
    );
    assert.equal(packageAssetResult.status, 0, packageAssetResult.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
