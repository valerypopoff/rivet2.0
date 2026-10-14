import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { desktopWebArtifact, verifyDesktopWebArtifact } from './desktop-web-artifact.mjs';
import { nodeTestPrerequisites } from '../../packages/node/scripts/prepare-tests.mjs';
import { assertImageDependencyLayout } from '../../deploy/studio-server/scripts/lib/image-dependency-layout.mjs';
import { installDependencies } from './install-dependencies.mjs';
import { fileURLToPath } from 'node:url';

test('CI install CLI preserves inherited environment, flags, live diagnostics and bounded exit behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-install-'));
  const launcher = fileURLToPath(new URL('./install-dependencies.mjs', import.meta.url));
  try {
    await fs.mkdir(path.join(root, '.yarn/releases'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
      `
      const fs = require('node:fs');
      require('node:assert/strict').deepEqual(process.argv.slice(2), ['install', '--immutable', '--immutable-cache']);
      require('node:assert/strict').equal(process.env.RIVET_CI_INSTALL_FIXTURE, 'inherited');
      const attempt = fs.existsSync('attempt') ? 2 : 1;
      fs.writeFileSync('attempt', 'started');
      console.log('fixture attempt ' + attempt);
      if (process.env.FIXTURE_OUTCOME === 'recover' && attempt === 2) process.exit(0);
      process.stdout.write('ERROR: Yarn is terminating due to an unexpected ');
      setImmediate(() => {
        console.log('empty event loop.');
        process.exitCode = Number(process.env.FIXTURE_CODE);
      });
    `,
    );
    const env = { ...process.env, RIVET_CI_INSTALL_FIXTURE: 'inherited' };
    delete env.NODE_TEST_CONTEXT;
    for (const [outcome, code, expected] of [
      ['recover', 42, 0],
      ['repeat', 42, 42],
      ['other', 1, 1],
    ]) {
      await fs.rm(path.join(root, 'attempt'), { force: true });
      const result = spawnSync(process.execPath, [launcher], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...env, FIXTURE_OUTCOME: outcome, FIXTURE_CODE: String(code) },
      });
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.match(result.stdout, /fixture attempt 1/);
      assert.equal(result.stdout.includes('fixture attempt 2'), code === 42);
      assert.equal(result.stderr.includes('Retrying the unchanged immutable install once'), code === 42);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CI install retries only the exact Yarn incomplete-execution sentinel with unchanged checks', async () => {
  const sentinel = {
    code: 42,
    signal: null,
    output: 'ERROR: Yarn is terminating due to an unexpected empty event loop.',
  };
  for (const results of [
    [sentinel, { code: 0, signal: null, output: 'Completed' }],
    [sentinel, sentinel],
    [sentinel, { code: 1, signal: null, output: 'YN0028: Lockfile would change' }],
  ]) {
    const calls = [];
    const waits = [];
    const logs = [];
    const result = await installDependencies({
      execute: async (args) => {
        calls.push(args);
        return results[calls.length - 1];
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      log: (message) => {
        logs.push(message);
      },
    });
    assert.equal(result, results[1]);
    assert.deepEqual(
      calls,
      Array(2).fill(['.yarn/releases/yarn-4.17.1.cjs', 'install', '--immutable', '--immutable-cache']),
    );
    assert.deepEqual(waits, [1000]);
    assert.equal(logs.length, 1);
  }
});

test('CI install fails immediately on validation, unknown exits, cancellation and spawn errors', async () => {
  for (const result of [
    { code: 0, signal: null, output: '' },
    { code: 1, signal: null, output: 'YN0028: Lockfile would change' },
    { code: 1, signal: null, output: 'YN0056: Cache entry required but missing' },
    { code: 42, signal: null, output: 'Unrelated failure' },
    { code: 1, signal: null, output: 'ERROR: Yarn is terminating due to an unexpected empty event loop.' },
    { code: null, signal: 'SIGTERM', output: '' },
    { code: 42, signal: 'SIGINT', output: 'ERROR: Yarn is terminating due to an unexpected empty event loop.' },
  ]) {
    let calls = 0;
    assert.equal(
      await installDependencies({
        execute: async () => {
          calls++;
          return result;
        },
        wait: async () => {
          assert.fail('Unexpected retry');
        },
      }),
      result,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    installDependencies({
      execute: async () => {
        throw new Error('spawn failed');
      },
    }),
    /spawn failed/,
  );
});

test('image dependency layers require real inputs before installation and changing sources afterward', () => {
  const manifest = 'packages/fixture/package.json';
  const inputs = [
    'COPY package.json yarn.lock .yarnrc.yml ./',
    'COPY .yarn ./.yarn',
    'COPY scripts/checks/check-package-manager.mjs ./scripts/checks/check-package-manager.mjs',
    `COPY ${manifest} ./${manifest}`,
  ];
  const install =
    'RUN --mount=type=cache,target=/cache \\\n+    YARN_NODE_LINKER=node-modules yarn install --immutable';
  const sources = ['COPY packages ./packages', 'COPY scripts ./scripts', 'COPY deploy ./deploy'];
  const fixture = ['FROM node:24-alpine AS builder', 'WORKDIR /app', ...inputs, install, ...sources];
  const check = (lines) => assertImageDependencyLayout(lines.join('\n'), [manifest], 'fixture');
  assert.doesNotThrow(() => check(fixture));
  assert.doesNotThrow(() => assertImageDependencyLayout(fixture.join('\r\n'), [manifest], 'CRLF fixture'));
  for (const input of inputs) {
    const without = fixture.filter((line) => line !== input);
    assert.throws(() => check(without), /before install/);
    assert.throws(() => check([...without, input]), /before install/);
    assert.throws(() => check([...without, `# ${input}`]), /before install/);
  }
  for (const source of sources) {
    assert.throws(() => check([source, ...fixture.filter((line) => line !== source)]), /sources after install/);
    assert.throws(() => check(fixture.filter((line) => line !== source)), /sources after install/);
  }
  assert.throws(() => check(fixture.filter((line) => line !== install)), /root Yarn lockfile/);
  assert.throws(
    () => check(fixture.map((line) => (line === install ? 'RUN yarn install --immutable-cache' : line))),
    /root Yarn lockfile/,
  );
  assert.throws(() => check(fixture.filter((line) => line !== 'WORKDIR /app')), /work directory/);
  assert.throws(
    () => check(fixture.flatMap((line) => (line === install ? ['WORKDIR /wrong', line] : [line]))),
    /work directory/,
  );
  for (const copy of ['COPY . .', 'COPY ./ ./']) {
    assert.throws(() => check([...fixture, copy]), /recopy the dependency cache/);
  }
});

// test-style: fixture-read: inspects only generated frontend artifacts, not implementation source.
test('desktop frontend handoff detects stale, altered, missing and extra assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-desktop-artifact-'));
  const commit = 'a'.repeat(40);
  try {
    await fs.mkdir(path.join(root, 'dist/assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist/index.html'), '<script src="assets/main.js"></script>');
    await fs.writeFile(path.join(root, 'dist/assets/main.js'), 'console.log(1);');
    const manifest = await desktopWebArtifact(root, commit);
    await fs.writeFile(path.join(root, 'desktop-web-artifact.json'), JSON.stringify(manifest));
    await verifyDesktopWebArtifact(root, commit);
    await assert.rejects(verifyDesktopWebArtifact(root, 'b'.repeat(40)), /stale or damaged/);
    await fs.writeFile(path.join(root, 'dist/assets/main.js'), 'console.log(2);');
    await assert.rejects(verifyDesktopWebArtifact(root, commit), /stale or damaged/);
    await fs.writeFile(path.join(root, 'dist/assets/main.js'), 'console.log(1);');
    await fs.writeFile(path.join(root, 'dist/assets/extra.js'), 'extra');
    await assert.rejects(verifyDesktopWebArtifact(root, commit), /stale or damaged/);
    await fs.rm(path.join(root, 'dist/assets/extra.js'));
    await fs.rm(path.join(root, 'dist/index.html'));
    await assert.rejects(verifyDesktopWebArtifact(root, commit), /entrypoint is missing/);
    await assert.rejects(desktopWebArtifact(root, 'HEAD'), /full source commit/);
    const linkedRoot = path.join(root, 'linked-app');
    await fs.mkdir(linkedRoot);
    await fs.symlink(path.join(root, 'dist'), path.join(linkedRoot, 'dist'), 'junction');
    await assert.rejects(desktopWebArtifact(linkedRoot, commit), /real directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Node tests build both public formats locally and verify prebuilt exports in CI', () => {
  const local = nodeTestPrerequisites();
  assert.deepEqual(
    local.map((args) => args.slice(-2)),
    [
      ['run', 'build:esm'],
      ['run', 'build:cjs'],
      ['run', 'build:esm'],
      ['run', 'build:cjs'],
    ],
  );
  assert.deepEqual(nodeTestPrerequisites('prebuilt'), [['check:compiled-workspace-exports']]);
  for (const invalid of ['', 'skip', 'prebuit']) assert.throws(() => nodeTestPrerequisites(invalid));
});

test('native Core shard mechanism covers every test file once across two partitions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-core-shards-'));
  try {
    const files = [];
    for (let index = 0; index < 6; index++) {
      const file = path.join(root, `${index}.test.cjs`);
      await fs.writeFile(file, `require('node:test').test('fixture-${index}', () => {});`);
      files.push(file);
    }
    const observed = [];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const shard of ['1/2', '2/2']) {
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-shard=${shard}`, ...files], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      observed.push(...[...result.stdout.matchAll(/^ok \d+ - (fixture-\d+)$/gm)].map((match) => match[1]));
    }
    assert.deepEqual(
      observed.sort(),
      Array.from({ length: 6 }, (_, index) => `fixture-${index}`),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
