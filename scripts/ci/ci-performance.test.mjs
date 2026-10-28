import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { desktopWebArtifact, verifyDesktopWebArtifact } from './desktop-web-artifact.mjs';
import { nodeTestPrerequisites } from '../../packages/node/scripts/prepare-tests.mjs';
import { assertImageDependencyLayout } from '../../deploy/studio-server/scripts/lib/image-dependency-layout.mjs';
import { installDependencies } from './install-dependencies.mjs';
import { fileURLToPath } from 'node:url';
import { editorCiSpecs, editorCiShards, selectEditorCiSpecs } from './editor-test-shards.mjs';
import { desktopReleasePlan } from './desktop-release-plan.mjs';
import { desktopBuildEvidence } from './desktop-build-evidence.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserCiEndpoint, verifyBrowserEnvironment } from './verify-browser-environment.mjs';
import { createRequire } from 'node:module';

const { createPagesHandler } = createRequire(import.meta.url)('../../postman/mocks/rivet-pages/contract.cjs');
const { createGitHubActionsHandler } = createRequire(import.meta.url)(
  '../../postman/mocks/github-actions/contract.cjs',
);

test('desktop Build evidence uses exact owned runs, bounded GETs and fail-closed publication', async (t) => {
  const requests = [];
  const server = createServer(createGitHubActionsHandler({ requests }));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const options = {
    repository: 'fixture/repo',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/develop',
    token: 'synthetic-fixture-token',
    maxWaitMs: 2_000,
    pollMs: 5,
    requestTimeoutMs: 1_000,
  };
  const run = (mode, scenario = 'ok', extra = {}) =>
    desktopBuildEvidence({
      ...options,
      mode,
      apiUrl: `http://127.0.0.1:${server.address().port}/${scenario}/`,
      ...extra,
    });
  assert.deepEqual(await run('artifact'), { runId: 101, runAttempt: 1, artifactId: 501 });
  assert.deepEqual(await run('validated', 'ok', { runId: 101, runAttempt: 1 }), { runId: 101, runAttempt: 1 });
  assert.deepEqual(await run('validated', 'advance'), { runId: 101, runAttempt: 1 });
  assert.deepEqual(await run('artifact', 'pending'), { runId: 101, runAttempt: 1, artifactId: 501 });
  for (const [scenario, failure] of [
    ['failed', /did not succeed/],
    ['cancelled', /did not succeed/],
    ['rerun', /identity\/attempt changed/],
    ['stale', /identity\/attempt changed/],
    ['wrongbranch', /identity\/attempt changed/],
    ['pr', /identity\/attempt changed/],
    ['fork', /identity\/attempt changed/],
    ['unavailable', /HTTP 503/],
    ['malformed', SyntaxError],
    ['redirect', TypeError],
  ]) {
    await assert.rejects(run('validated', scenario, { runId: 101, runAttempt: 1 }), failure, scenario);
  }
  for (const [scenario, failure] of [
    ['expired', /expired or invalid/],
    ['missing', /has no desktop artifact/],
    ['duplicate', /Ambiguous desktop artifact/],
    ['foreign-artifact', /ownership does not match/],
  ])
    await assert.rejects(run('artifact', scenario), failure, scenario);
  await assert.rejects(run('validated', 'hang', { requestTimeoutMs: 60 }), { name: 'TimeoutError' });
  // The overall deadline may expire between polls or during a real HTTP read.
  for (const [mode, scenario] of [
    ['validated', 'pending'],
    ['artifact', 'empty'],
  ])
    await assert.rejects(run(mode, scenario, { maxWaitMs: 60 }), /Timed out|operation was aborted due to timeout/);
  await assert.rejects(run('validated', 'ok', { runId: 101 }), /Pinned/);
  assert.ok(
    requests.every((request) => request.startsWith('GET ')),
    'Release evidence never dispatches/retries writes.',
  );
  assert.ok(requests.some((request) => request.includes('head_sha=' + options.sha)));
  assert.ok(requests.some((request) => request.includes('/actions/runs/101/artifacts?per_page=100')));
});

// test-style: fixture-read: inspect only GitHub output generated in the owned temporary fixture.
test('desktop docs planning compares the complete push and published baseline without hiding unpublished code', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-desktop-plan-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const commit = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), text);
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const published = await commit('packages/app/index.ts', 'original');
  const docs = await commit('packages/docs/docs/intro.md', 'documentation');
  const requests = [];
  const server = createServer(createPagesHandler({ commit: published, requests }));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const options = {
    cwd,
    eventName: 'push',
    event: { before: published, after: docs },
    sha: docs,
    channel: 'developer',
    allowDocsOnly: true,
  };
  const plan = (mode = 'ok', overrides = {}) =>
    desktopReleasePlan({ ...options, siteUrl: `http://127.0.0.1:${server.address().port}/${mode}/`, ...overrides });
  const reuse = await plan();
  assert.equal(reuse.native, false);
  assert.equal(reuse.desktopCommit, published);
  assert.ok(requests.includes('GET /ok/developer-release.json'));
  const eventPath = path.join(cwd, '.git', 'fixture-event.json');
  const outputPath = path.join(cwd, '.git', 'fixture-github-output');
  await fs.writeFile(eventPath, JSON.stringify(options.event));
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL('./desktop-release-plan.mjs', import.meta.url))],
      {
        cwd,
        timeout: 15_000,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_SHA: docs,
          RELEASE_CHANNEL: 'developer',
          ALLOW_DOCS_ONLY: 'true',
          PAGES_SITE_URL: `http://127.0.0.1:${server.address().port}/ok/`,
          GITHUB_OUTPUT: outputPath,
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  assert.equal(await fs.readFile(outputPath, 'utf8'), `native=false\ndesktop_commit=${published}\n`);
  for (const mode of ['missing', 'unavailable', 'malformed', 'changed']) assert.equal((await plan(mode)).native, true);
  for (const overrides of [
    { eventName: 'workflow_dispatch' },
    { allowDocsOnly: false },
    { event: { before: '0'.repeat(40), after: docs } },
  ]) {
    const before = requests.length;
    assert.equal((await plan('ok', overrides)).native, true);
    assert.equal(requests.length, before, 'explicit/full builds do not need Pages');
  }
  const code = await commit('packages/app/index.ts', 'unpublished change');
  const laterDocs = await commit('packages/docs/docs/intro.md', 'later documentation');
  assert.equal((await plan('ok', { sha: laterDocs, event: { before: code, after: laterDocs } })).native, true);
  const mixed = await plan('ok', { sha: code, event: { before: docs, after: code } });
  assert.equal(mixed.native, true);
  await assert.rejects(plan('ok', { sha: docs, event: { before: published, after: code } }), /identity/);
});

test('browser prerequisites reject version drift before launch and close Chromium after success or render failure', async () => {
  for (const expectedVersion of [undefined, '', 'latest', '1.62.2']) {
    await assert.rejects(
      verifyBrowserEnvironment({
        expectedVersion,
        actualVersion: '1.62.1',
        chromium: { connect: () => assert.fail('A mismatched image must never connect to a browser.') },
      }),
      /version mismatch/,
    );
  }
  await assert.rejects(
    verifyBrowserEnvironment({ expectedVersion: '1.62.1', actualVersion: '1.62.1', endpoint: 'ws://example.invalid/' }),
    /exact loopback/,
  );
  for (const failure of [false, true]) {
    let closed = 0;
    const result = verifyBrowserEnvironment({
      expectedVersion: '1.62.1',
      actualVersion: '1.62.1',
      endpoint: browserCiEndpoint,
      chromium: {
        async connect(endpoint, options) {
          assert.equal(endpoint, browserCiEndpoint);
          assert.deepEqual(options, { timeout: 15_000, exposeNetwork: '<loopback>' });
          return {
            version: () => 'synthetic-chromium',
            close: async () => {
              closed++;
            },
            async newContext(options) {
              assert.deepEqual(options, { offline: true });
              return {
                newPage: async () => ({
                  setContent: async () => {},
                  locator: () => ({
                    innerText: async () => (failure ? 'wrong page' : 'Rivet browser environment ready'),
                  }),
                }),
              };
            },
          };
        },
      },
    });
    if (failure) await assert.rejects(result, /did not render/);
    else assert.deepEqual(await result, { playwright: '1.62.1', chromium: 'synthetic-chromium', passed: true });
    assert.equal(closed, 1);
  }
});

test('balanced editor shards cover every selected spec exactly once and reject invalid selection', () => {
  assert.equal(editorCiSpecs.length, 32);
  assert.ok(editorCiSpecs.includes('graph-call-path-node.spec.ts'));
  assert.ok(editorCiSpecs.includes('evaluation-trial-orchestration.spec.ts'));
  assert.ok(editorCiSpecs.includes('partial-run-preload.spec.ts'));
  assert.ok(editorCiSpecs.includes('wire-viewport-culling.spec.ts'));
  assert.ok(editorCiSpecs.includes('run-statistics-modal.spec.ts'));
  assert.ok(editorCiSpecs.includes('run-cost-statistics.spec.ts'));
  assert.equal(new Set(editorCiSpecs).size, editorCiSpecs.length);
  assert.deepEqual(selectEditorCiSpecs(), editorCiSpecs);
  const selected = ['1/3', '2/3', '3/3'].flatMap(selectEditorCiSpecs);
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), [...editorCiSpecs].sort());
  const weights = editorCiShards.map((shard) => shard.seconds);
  assert.ok(Math.max(...weights) <= Math.min(...weights) * 1.05);
  for (const invalid of ['', '0/3', '4/3', '1/2', '1/4', '1/3extra', '1/3\n'])
    assert.throws(() => selectEditorCiSpecs(invalid), /RIVET_EDITOR_TEST_SHARD/);
});

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
