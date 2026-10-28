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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editorCiSpecs, editorCiShards, selectEditorCiSpecs } from './editor-test-shards.mjs';
import { desktopReleasePlan } from './desktop-release-plan.mjs';
import { desktopBuildEvidence } from './desktop-build-evidence.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserCiEndpoint, verifyBrowserEnvironment } from './verify-browser-environment.mjs';
import { createRequire } from 'node:module';
import { prepareMigrationHistory } from './prepare-migration-history.mjs';
import { migrationCommitParents } from '../../deploy/studio-server/migration/evidence.mjs';

const { createPagesHandler } = createRequire(import.meta.url)('../../postman/mocks/rivet-pages/contract.cjs');
const { createGitHubActionsHandler } = createRequire(import.meta.url)(
  '../../postman/mocks/github-actions/contract.cjs',
);

test('repository checkout keeps source, tracked inventory and offline cache without fetching desktop binaries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-repository-checkout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote');
  const checkout = path.join(root, 'checkout');
  await fs.mkdir(remote);
  const git = (cwd, args, options = {}) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      ...options,
    }).trim();
  git(remote, ['init', '--quiet']);
  git(remote, ['config', 'user.name', 'CI fixture']);
  git(remote, ['config', 'user.email', 'fixture@example.invalid']);
  git(remote, ['config', 'core.autocrlf', 'false']);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const files = {
    'package.json': '{"fixture":true}',
    '.yarn/cache/dependency.zip': 'fixture cache archive',
    'packages/app/src/component.ts': 'fixture editor source',
    'packages/app/src-tauri/config.json': 'fixture desktop source configuration',
    'packages/studio-server-api/src/server.ts': 'fixture server source',
    'deploy/studio-server/scripts/test.mjs': 'fixture repository check',
    'developer-docs/guide.md': 'fixture documentation',
    'packages/app/sidecars/pnpm/README.md': 'fixture sidecar documentation',
    'packages/app/sidecars/pnpm/SHA256SUMS': 'fixture sidecar provenance',
    'packages/app/sidecars/pnpm/pnpm-helper.mjs': 'fixture source must not be hidden by a broad wildcard',
    'packages/app/sidecars/pnpm/pnpm-x86_64-pc-windows-msvc.exe': 'unneeded native binary',
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(remote, file)), { recursive: true });
    await fs.writeFile(path.join(remote, file), content);
  }
  git(remote, ['add', '.']);
  git(remote, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  const head = git(remote, ['rev-parse', 'HEAD']);
  const binary = git(remote, ['rev-parse', 'HEAD:packages/app/sidecars/pnpm/pnpm-x86_64-pc-windows-msvc.exe']);
  git(root, [
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--depth=1',
    '--no-tags',
    '--no-checkout',
    pathToFileURL(remote).href,
    checkout,
  ]);
  git(checkout, ['sparse-checkout', 'set', '--no-cone', '--stdin'], {
    input:
      '/*\n' +
      [
        'pnpm-aarch64-apple-darwin',
        'pnpm-aarch64-unknown-linux-gnu',
        'pnpm-x86_64-apple-darwin',
        'pnpm-x86_64-pc-windows-msvc.exe',
        'pnpm-x86_64-unknown-linux-gnu',
      ]
        .map((name) => `!/packages/app/sidecars/pnpm/${name}\n`)
        .join(''),
  });
  git(checkout, ['checkout', '--detach', head]);
  assert.equal(git(checkout, ['rev-parse', 'HEAD']), head);
  assert.equal(git(checkout, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(git(checkout, ['status', '--porcelain']), '');
  assert.deepEqual(git(checkout, ['ls-files']).split('\n'), Object.keys(files).sort());
  for (const [file, content] of Object.entries(files)) {
    if (file === 'packages/app/sidecars/pnpm/pnpm-x86_64-pc-windows-msvc.exe')
      await assert.rejects(fs.stat(path.join(checkout, file)), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(path.join(checkout, file), 'utf8'), content);
  }
  assert.throws(
    () =>
      git(checkout, ['cat-file', '-e', binary], {
        env: { ...process.env, GIT_ALLOW_PROTOCOL: '' },
      }),
    'Excluding a file must avoid fetching its blob, not just remove it after download.',
  );
});

test('Git checkout fails a stalled HTTP read using its low-speed deadline, not the outer job timeout', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-git-stall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
    response.flushHeaders(); // Deliberately never send the advertised Git body.
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = await new Promise((resolve) =>
    execFile(
      'git',
      [
        '-c',
        'http.proxy=',
        'fetch',
        '--depth=1',
        '--no-tags',
        `http://127.0.0.1:${server.address().port}/fixture.git`,
        'a'.repeat(40),
      ],
      {
        cwd: root,
        timeout: 8_000,
        env: {
          ...process.env,
          NO_PROXY: '127.0.0.1',
          LC_ALL: 'C',
          GIT_TERMINAL_PROMPT: '0',
          GIT_HTTP_LOW_SPEED_LIMIT: '1024',
          GIT_HTTP_LOW_SPEED_TIME: '1',
        },
      },
      (error, _stdout, stderr) => resolve({ error, stderr }),
    ),
  );
  assert.ok(requests > 0);
  assert.equal(result.error?.code, 128, result.stderr);
  assert.match(result.stderr, /Operation too slow|Timeout was reached/);
  assert.notEqual(result.error?.killed, true, 'Git itself must stop the stalled transfer.');
});

test('migration history prepares exact evidence from a shallow checkout without changing HEAD or fetching other refs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote');
  const checkout = path.join(root, 'checkout');
  await fs.mkdir(remote);
  const git = (cwd, args, options = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', ...options }).trim();
  git(remote, ['init', '--quiet']);
  git(remote, ['config', 'user.name', 'CI fixture']);
  git(remote, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(remote, 'source.txt'), 'fixture');
  git(remote, ['add', '.']);
  git(remote, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'source']);
  const sourceCommit = git(remote, ['rev-parse', 'HEAD']);
  const sourceTree = git(remote, ['rev-parse', 'HEAD^{tree}']);
  const sourceBlob = git(remote, ['rev-parse', 'HEAD:source.txt']);
  const commit = (tree, ...parents) =>
    git(remote, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])], {
      input: 'fixture\n',
    });
  const base = commit(sourceTree);
  const subtree = git(remote, ['mktree'], { input: `040000 tree ${sourceTree}\tstudio-server\n` });
  const importTree = git(remote, ['mktree'], { input: `040000 tree ${subtree}\t_import\n` });
  const importCommit = commit(importTree, base, sourceCommit);
  const currentBlob = git(remote, ['hash-object', '-w', '--stdin'], { input: 'current content' });
  const currentTree = git(remote, ['mktree'], { input: `100644 blob ${currentBlob}\tsource.txt\n` });
  const migrationCommit = commit(currentTree, importCommit);
  let latest = migrationCommit;
  for (let index = 0; index < 5; index++) latest = commit(currentTree, latest);
  git(remote, ['update-ref', 'refs/heads/main', latest]);
  git(remote, ['update-ref', 'refs/heads/unrelated', base]);
  git(remote, ['update-ref', 'refs/tags/unrelated', base]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  git(root, [
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--depth=1',
    '--no-tags',
    '--branch',
    'main',
    pathToFileURL(remote).href,
    checkout,
  ]);
  assert.equal(git(checkout, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.throws(() =>
    git(checkout, ['cat-file', '-e', migrationCommit], {
      env: { ...process.env, GIT_ALLOW_PROTOCOL: '' },
    }),
  );
  const evidence = { sourceCommit, sourceTree, importCommit, importPrefix: '_import/studio-server', migrationCommit };
  assert.deepEqual(prepareMigrationHistory({ cwd: checkout, evidence }), { fetched: true });
  assert.deepEqual(prepareMigrationHistory({ cwd: checkout, evidence }), { fetched: false });
  assert.equal(git(checkout, ['rev-parse', 'HEAD']), latest);
  assert.equal(git(checkout, ['status', '--porcelain']), '');
  assert.equal(git(checkout, ['tag', '--list']), '');
  assert.equal(git(checkout, ['branch', '-r']), 'origin/main');
  assert.deepEqual(migrationCommitParents(git(checkout, ['cat-file', 'commit', importCommit])), [base, sourceCommit]);
  assert.equal(git(checkout, ['rev-parse', `${importCommit}:_import/studio-server`]), sourceTree);
  assert.throws(
    () =>
      git(checkout, ['cat-file', '-e', sourceBlob], {
        env: { ...process.env, GIT_ALLOW_PROTOCOL: '' },
      }),
    'Historical content is unnecessary; neither inspection nor the bounded fetch may download it.',
  );
  assert.throws(
    () => prepareMigrationHistory({ cwd: checkout, evidence: { ...evidence, sourceTree: importTree } }),
    /strictly equal/,
  );
});

test('migration history bounds fetches and fails closed on missing evidence, failed transfer or invalid identities', () => {
  const evidence = {
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    importCommit: 'c'.repeat(40),
    migrationCommit: 'd'.repeat(40),
    importPrefix: '_import/studio-server',
  };
  assert.deepEqual(
    migrationCommitParents(
      `tree ${evidence.sourceTree}\nparent ${evidence.sourceCommit}\n\nparent ${evidence.importCommit}\n`,
    ),
    [evidence.sourceCommit],
  );
  for (const transferFails of [false, true]) {
    let fetches = 0;
    assert.throws(
      () =>
        prepareMigrationHistory({
          evidence,
          execute(args, options) {
            if (args.includes('fetch')) {
              fetches++;
              assert.deepEqual(args, [
                '-c',
                'protocol.version=2',
                'fetch',
                '--no-tags',
                '--no-recurse-submodules',
                '--filter=blob:none',
                '--depth=3',
                'origin',
                evidence.migrationCommit,
              ]);
              assert.equal(options.timeout, 180_000);
              assert.equal(options.killSignal, 'SIGKILL');
              if (transferFails) throw Error('transfer failed');
              return '';
            }
            assert.equal(options.timeout, 15_000);
            assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
            assert.equal(options.env.GIT_ALLOW_PROTOCOL, '');
            throw Error('missing evidence');
          },
        }),
      transferFails ? /transfer failed/ : /missing evidence/,
    );
    assert.equal(fetches, 1, 'A read failure never becomes an unbounded fetch/retry or a passed ledger.');
  }
  for (const key of ['sourceCommit', 'sourceTree', 'importCommit', 'migrationCommit']) {
    assert.throws(
      () =>
        prepareMigrationHistory({
          evidence: { ...evidence, [key]: 'HEAD' },
          execute: () => assert.fail('Invalid evidence must not run Git.'),
        }),
      /exact/,
    );
  }
});

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
  assert.equal(editorCiSpecs.length, 34);
  assert.ok(editorCiSpecs.includes('hosted-editor-search-shortcuts.spec.ts'));
  assert.ok(editorCiSpecs.includes('bundle-local-execution-history.spec.ts'));
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
