import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUploadPlan, createReleaseAssetManifest } from './publish-desktop-release-assets.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// test-style: fixture-read: inspect only the publication output generated in an owned temporary directory.
const { createPagesHandler, metadata } = createRequire(import.meta.url)('../../postman/mocks/rivet-pages/contract.cjs');

test('docs-only Pages preparation preserves release identity and downloads, and fails closed on uncertainty', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rivet-docs-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const commit = 'a'.repeat(40);
  const server = createServer(createPagesHandler({ commit, requests }));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const run = (mode) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./prepare-desktop-release-pages.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            PAGES_SITE_URL: `http://127.0.0.1:${server.address().port}/${mode}/`,
            PAGES_OUT_DIR: path.join(root, mode),
            RELEASE_CHANNEL: 'developer',
            PRESERVED_DESKTOP_COMMIT: commit,
            REUSE_PUBLISHED_DESKTOP_RELEASE: '1',
            PRESERVE_RELEASE_METADATA_FILES: 'official-release.json',
            RELEASE_ASSETS_MANIFEST_PATH: '',
            GITHUB_SHA: 'c'.repeat(40),
            RELEASE_LABEL: 'must-not-replace-installers',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: 10_000,
        },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
  const success = await run('ok');
  assert.equal(success.code, 0, success.output);
  for (const channel of ['developer', 'official']) {
    assert.equal(
      await readFile(path.join(root, 'ok', `${channel}-release.json`), 'utf8'),
      JSON.stringify(metadata(channel, commit), null, 2),
    );
    assert.equal(await readFile(path.join(root, 'ok', `downloads/${channel}/installer.msi`), 'utf8'), 'MSI!');
  }
  assert.deepEqual(requests, [
    'GET /ok/developer-release.json',
    'GET /ok/downloads/developer/installer.msi',
    'GET /ok/official-release.json',
    'GET /ok/downloads/official/installer.msi',
  ]);
  for (const mode of ['missing', 'unavailable', 'malformed', 'changed', 'asset-failure']) {
    const result = await run(mode);
    assert.notEqual(result.code, 0, mode);
    await assert.rejects(stat(path.join(root, mode, 'developer-release.json')), { code: 'ENOENT' });
  }
  const optional = await run('optional-missing');
  assert.equal(optional.code, 0, optional.output);
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'optional-missing', 'developer-release.json'), 'utf8')).commit,
    commit,
  );
});

void test('publishes distinct, architecture-labelled macOS downloads', () => {
  const uploadPlan = buildUploadPlan({
    artifacts: [
      {
        architecture: 'aarch64',
        name: 'Rivet 2_2.19.0_aarch64.dmg',
        originalPath: 'macos/aarch64/dmg/Rivet 2_2.19.0_aarch64.dmg',
        platform: 'macos',
        size: 101,
        sourcePath: '/tmp/aarch64.dmg',
      },
      {
        architecture: 'x86_64',
        name: 'Rivet 2_2.19.0_x64.dmg',
        originalPath: 'macos/x86_64/dmg/Rivet 2_2.19.0_x64.dmg',
        platform: 'macos',
        size: 102,
        sourcePath: '/tmp/x86_64.dmg',
      },
    ],
    config: { assetPrefix: 'Rivet-2-Developer' },
    version: '2.19.0',
    shortSha: 'abcdef0',
    runAttempt: '1',
    runNumber: '42',
  });

  assert.deepEqual(
    uploadPlan.map(({ architecture, assetName, primaryKind }) => ({ architecture, assetName, primaryKind })),
    [
      {
        architecture: 'aarch64',
        assetName: 'Rivet-2-Developer-macOS-Apple-Silicon-2.19.0-abcdef0-r42-a1.dmg',
        primaryKind: 'macosAarch64Dmg',
      },
      {
        architecture: 'x86_64',
        assetName: 'Rivet-2-Developer-macOS-Intel-2.19.0-abcdef0-r42-a1.dmg',
        primaryKind: 'macosX86_64Dmg',
      },
    ],
  );

  const uploadedAssetsByName = new Map(
    uploadPlan.map((asset) => [asset.assetName, { name: asset.assetName, browser_download_url: `https://example.test/${asset.assetName}` }]),
  );
  const manifest = createReleaseAssetManifest({
    assetPrefix: 'Rivet-2-Developer',
    channel: 'developer',
    release: { id: 1, tag_name: 'rivet-2-developer-feed', html_url: 'https://example.test/release' },
    uploadPlan,
    uploadedAssetsByName,
    version: '2.19.0',
  });

  assert.deepEqual(
    manifest.stableDownloads.map(({ architecture, label, name, platform }) => ({ architecture, label, name, platform })),
    [
      {
        architecture: 'aarch64',
        label: 'macOS Apple Silicon disk image',
        name: 'Rivet-2-Developer-macOS-Apple-Silicon.dmg',
        platform: 'macos',
      },
      {
        architecture: 'x86_64',
        label: 'macOS Intel disk image',
        name: 'Rivet-2-Developer-macOS-Intel.dmg',
        platform: 'macos',
      },
    ],
  );
});
