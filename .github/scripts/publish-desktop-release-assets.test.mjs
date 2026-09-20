import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUploadPlan, createReleaseAssetManifest } from './publish-desktop-release-assets.mjs';

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
