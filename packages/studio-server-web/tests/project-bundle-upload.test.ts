import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { readBundleArchive, readBundleFolder, normalizeBundleFiles } from '../dashboard/projectBundleUpload';
import { PROJECT_BUNDLE_UPLOAD_MAX_FILES } from '../../studio-server-shared/project-bundle-types';

test('folder and ZIP inputs normalize one wrapper directory to the same portable file list', async () => {
  const source = {
    'bundle/rivet-bundle.json': strToU8('{}'),
    'bundle/projects/root.rivet-project': strToU8('project'),
    'bundle/.DS_Store': strToU8('ignored'),
  };
  const archive = new File([zipSync(source)], 'bundle.zip');
  const files = Object.entries(source).map(([path, contents]) => {
    const file = new File([contents], path.split('/').at(-1)!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  });
  const zip = await readBundleArchive(archive);
  const folder = await readBundleFolder(files);
  const sorted = (items: typeof zip) => items.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sorted(zip), sorted(folder));
  assert.deepEqual(zip.map((f) => f.path).sort(), ['projects/root.rivet-project', 'rivet-bundle.json']);
});

test('uploads reject traversal, multiple bundles, invalid UTF-8 and out-of-root entries', async () => {
  assert.throws(() => normalizeBundleFiles([{ path: '../rivet-bundle.json', contents: '{}' }]), /unsafe/);
  assert.throws(
    () =>
      normalizeBundleFiles([
        { path: 'a/rivet-bundle.json', contents: '{}' },
        { path: 'b/rivet-bundle.json', contents: '{}' },
      ]),
    /one bundle/,
  );
  assert.throws(
    () =>
      normalizeBundleFiles([
        { path: 'a/rivet-bundle.json', contents: '{}' },
        { path: 'other', contents: '{}' },
      ]),
    /outside/,
  );
  for (const source of [{ '../rivet-bundle.json': strToU8('{}') }, { 'rivet-bundle.json': new Uint8Array([0xff]) }])
    await assert.rejects(readBundleArchive(new File([zipSync(source)], 'bad.zip')));
  await assert.rejects(readBundleArchive(new File(['not zip'], 'bad.zip')));
});

test('archive size is checked before allocation and ZIP declared expansion is bounded', async () => {
  const large = { size: 64 * 1024 * 1024 + 1 } as File;
  await assert.rejects(readBundleArchive(large), /exceeds/);
  const bytes = zipSync({ 'rivet-bundle.json': strToU8('{}') }, { level: 0 });
  new DataView(bytes.buffer).setUint32(22, 64 * 1024 * 1024 + 1, true);
  await assert.rejects(readBundleArchive(new File([bytes], 'oversized.zip')), /expands/);
});

test('actual ZIP expansion is bounded even when the archive understates its size', async () => {
  const bytes = zipSync({ 'rivet-bundle.json': new Uint8Array(64 * 1024 * 1024 + 1) });
  new DataView(bytes.buffer).setUint32(22, 1, true);
  await assert.rejects(readBundleArchive(new File([bytes], 'false-size.zip')), /expands/);
});

test('folder upload rejects too many meaningful files before reading the excess file', async () => {
  const files = Array.from(
    { length: PROJECT_BUNDLE_UPLOAD_MAX_FILES + 1 },
    (_, index) => new File([''], index === 0 ? 'rivet-bundle.json' : `file-${index}`),
  );
  Object.defineProperty(files.at(-1)!, 'arrayBuffer', {
    value: () => {
      throw new Error('Excess file was read');
    },
  });
  await assert.rejects(readBundleFolder(files), /too many files/);
});
