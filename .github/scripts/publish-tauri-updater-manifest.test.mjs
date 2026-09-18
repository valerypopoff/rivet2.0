import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findUniqueAsset,
  parseRepository,
  replaceReleaseAsset,
  targetSpecs,
  updaterAssetMatches,
} from './publish-tauri-updater-manifest.mjs';

void test('selects exactly one updater archive for every supported architecture', () => {
  const assets = [
    { name: 'Rivet_2.19.0_aarch64.app.tar.gz' },
    { name: 'Rivet_2.19.0_x64.app.tar.gz' },
    { name: 'Rivet_2.19.0_x64_en-US.msi.zip' },
    { name: 'Rivet_2.19.0_x64.AppImage.tar.gz' },
    { name: 'Rivet_2.19.0_aarch64.AppImage.tar.gz' },
  ];

  assert.deepEqual(
    targetSpecs.map((spec) => findUniqueAsset(assets, spec.key, (asset) => updaterAssetMatches(asset, spec)).name),
    assets.map((asset) => asset.name),
  );
});

void test('does not treat a universal or wrong-architecture archive as native', () => {
  const armMac = targetSpecs.find((spec) => spec.key === 'darwin-aarch64');
  const intelMac = targetSpecs.find((spec) => spec.key === 'darwin-x86_64');
  assert.ok(armMac);
  assert.ok(intelMac);

  assert.equal(updaterAssetMatches({ name: 'Rivet_2.19.0_x64.app.tar.gz' }, armMac), false);
  assert.equal(updaterAssetMatches({ name: 'Rivet_2.19.0_aarch64.app.tar.gz' }, intelMac), false);
  assert.equal(updaterAssetMatches({ name: 'Rivet_2.19.0_universal.app.tar.gz' }, armMac), false);
  assert.equal(updaterAssetMatches({ name: 'Rivet_2.19.0_aarch64.dmg' }, armMac), false);
});

void test('requires a canonical GitHub repository name', () => {
  assert.deepEqual(parseRepository('valerypopoff/rivet2.0'), { owner: 'valerypopoff', repo: 'rivet2.0' });
  assert.throws(() => parseRepository('valerypopoff/rivet2.0/extra'), /Invalid GITHUB_REPOSITORY/);
});

void test('restores the previous updater manifest when replacement upload fails', async () => {
  const calls = [];

  await assert.rejects(
    replaceReleaseAsset({
      assets: [{ name: 'latest.json', id: 1 }],
      assetName: 'latest.json',
      contents: 'new manifest',
      read: async () => {
        calls.push('read');
        return 'old manifest';
      },
      remove: async () => {
        calls.push('remove');
      },
      upload: async (_name, contents) => {
        calls.push(`upload:${contents}`);
        if (contents === 'new manifest') throw new Error('upload unavailable');
      },
    }),
    /restored the previous release asset/,
  );

  assert.deepEqual(calls, ['read', 'remove', 'upload:new manifest', 'upload:old manifest']);
});

void test('refuses ambiguous updater-manifest replacement before deleting an asset', async () => {
  let deleted = false;

  await assert.rejects(
    replaceReleaseAsset({
      assets: [
        { name: 'latest.json', id: 1 },
        { name: 'latest.json', id: 2 },
      ],
      assetName: 'latest.json',
      contents: 'new manifest',
      read: async () => 'old manifest',
      remove: async () => {
        deleted = true;
      },
      upload: async () => undefined,
    }),
    /Expected at most one existing latest.json/,
  );

  assert.equal(deleted, false);
});
