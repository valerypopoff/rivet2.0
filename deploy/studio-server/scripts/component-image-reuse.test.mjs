import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proxyInputDigest } from './lib/component-image-reuse.mjs';
import { assertImageOrigins } from './lib/component-image-origin.mjs';
import { prepareProxyImage } from './prepare-component-image.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';
// test-style: fixture-read: Read generated GitHub output and provenance files in test-owned directories.

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-component-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), value);
  };
  for (const file of [
    '.dockerignore',
    '.github/workflows/studio-server-images.yml',
    'deploy/studio-server/scripts/lib/component-image-reuse.mjs',
    'deploy/studio-server/images/lib/load-env.sh',
  ])
    await write(file, 'fixture');
  const dockerfile = 'deploy/studio-server/images/proxy/Dockerfile';
  await write(
    dockerfile,
    `FROM nginx@sha256:${'a'.repeat(64)}\nCOPY deploy/studio-server/images/lib/load-env.sh /opt/load-env.sh\n`,
  );
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { root, write, commit, dockerfile };
}

test('proxy identity stays stable across application edits but changes with transitive runtime inputs and build policy', async (t) => {
  const f = await fixture(t),
    baseline = proxyInputDigest(f.root, f.commit());
  await f.write('packages/app/app.ts', 'changed UI');
  assert.equal(proxyInputDigest(f.root, f.commit()), baseline);
  for (const file of [
    'deploy/studio-server/images/lib/load-env.sh',
    '.dockerignore',
    '.github/workflows/studio-server-images.yml',
  ]) {
    await f.write(file, 'changed ' + file);
    const next = proxyInputDigest(f.root, f.commit());
    assert.notEqual(next, baseline);
  }
});

for (const recipe of [
  'FROM nginx:latest\n',
  `FROM nginx@sha256:${'a'.repeat(64)}\nCOPY packages/api /app\n`,
  `FROM nginx@sha256:${'a'.repeat(64)}\nADD https://example.test/code /app\n`,
])
  test('unsupported or unpinned proxy recipe requests a fresh build', async (t) => {
    const f = await fixture(t);
    await f.write(f.dockerfile, recipe);
    assert.equal(proxyInputDigest(f.root, f.commit()), null);
  });

test('reused provenance is bound to the exact predecessor and image, never an arbitrary old digest', () => {
  const image = { repository: 'registry.test/proxy', digest: 'sha256:' + 'a'.repeat(64) };
  const predecessor = 'sha256:' + 'b'.repeat(64);
  const origins = {
    proxy: { sourceSha: 'c'.repeat(40), inputsDigest: 'sha256:' + 'd'.repeat(64), predecessorDigest: predecessor },
  };
  const manifest = {
    images: { proxy: image },
    lineage: { predecessor: { manifestDigest: predecessor, images: { proxy: image } } },
  };
  assert.deepEqual(assertImageOrigins(origins, manifest), origins);
  assert.throws(() => assertImageOrigins(origins, { ...manifest, lineage: { predecessor: null } }));
  assert.throws(() =>
    assertImageOrigins(origins, { ...manifest, images: { proxy: { ...image, digest: predecessor } } }),
  );
  assert.throws(() => assertImageOrigins({ ...origins, api: origins.proxy }, manifest));
});

test('a genuinely absent unpinned baseline builds normally, while pinned absence and registry errors stop before writes', async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, 'outputs');
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: output };
  const execute = async () => {
    throw Error('No registry mutation is allowed');
  };
  assert.equal(
    await prepareProxyImage({
      rootDir: f.root,
      env,
      execute,
      pull: async (_reference, _file, options) => {
        assert.equal(options.allowMissing, true);
        return null;
      },
    }),
    null,
  );
  const before = await fs.readFile(output, 'utf8');
  await assert.rejects(
    prepareProxyImage({
      rootDir: f.root,
      env: { ...env, INSTALLED_PREDECESSOR_DIGEST: 'sha256:' + 'a'.repeat(64) },
      execute,
      pull: async (_ref, _file, options) => {
        assert.equal(options.allowMissing, false);
        return null;
      },
    }),
    /predecessor is missing/,
  );
  await assert.rejects(
    prepareProxyImage({
      rootDir: f.root,
      env,
      execute,
      pull: async () => {
        throw Error('Registry authentication failed');
      },
    }),
    /authentication/,
  );
  assert.equal(await fs.readFile(output, 'utf8'), before);
  assert.equal(
    await prepareProxyImage({
      rootDir: f.root,
      env: { ...env, ALLOW_RELEASE_LINEAGE_BOOTSTRAP: 'true' },
      execute,
      pull: async () => {
        throw Error('Bootstrap must not inspect an old release');
      },
    }),
    null,
  );
});

test('the workflow reuses an unchanged ancestor proxy exactly once and rebuilds after a real input change', async (t) => {
  const f = await fixture(t),
    source = f.commit(),
    repository = 'valerypopoff/rivet2.0';
  const evidence = { workflow: 'Build Images', runId: '123', runAttempt: 1 };
  const previous = promoteStudioServerReleaseManifest(
    createStudioServerReleaseManifest({
      rootDir: fileURLToPath(new URL('../../../', import.meta.url)),
      source: { repository, ref: 'refs/heads/main', sha: source },
      images: Object.fromEntries(
        ['proxy', 'api', 'web', 'executor'].map((name) => [
          name,
          {
            repository: 'ghcr.io/valerypopoff/rivet2.0-studio-server/' + name,
            digest: 'sha256:' + 'a'.repeat(64),
          },
        ]),
      ),
      candidateEvidence: evidence,
    }),
    { promotionEvidence: evidence },
  );
  await f.write('packages/app/example.ts', 'application edit');
  let current = f.commit();
  const calls = [],
    output = path.join(f.root, 'outputs');
  const options = () => ({
    rootDir: f.root,
    env: {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: current,
      GITHUB_REPOSITORY: repository,
      SOURCE_TAG: `candidate-${current}-123-1`,
      GITHUB_OUTPUT: output,
    },
    pull: async () => ({ manifest: previous }),
    execute: async (_bin, args) => {
      calls.push(args);
      return args.includes('inspect') ? previous.images.proxy.digest : '';
    },
  });
  const reused = await prepareProxyImage(options());
  assert.equal(reused.origin.sourceSha, source);
  assert.equal(calls.filter((args) => args.includes('create')).length, 1);
  assert.equal(calls.filter((args) => args.includes('inspect')).length, 1);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'artifacts/component-image-origin/proxy.json'), 'utf8')).origin
      .sourceSha,
    source,
  );
  await f.write('deploy/studio-server/images/lib/load-env.sh', 'changed actual runtime input');
  current = f.commit();
  assert.equal(await prepareProxyImage(options()), null);
  assert.equal(calls.length, 2, 'Changed inputs must not retag old image bytes');
});
