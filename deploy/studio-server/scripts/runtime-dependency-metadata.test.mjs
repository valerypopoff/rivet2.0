import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeRuntimeDependencies,
  fingerprintRuntimeDependencies,
} from '../images/lib/normalize-runtime-dependencies.mjs';

test('dependency normalization compares complete contents and metadata without touching application files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-dependency-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'application.js'), 'export default 1;');
  await fs.utimes(path.join(root, 'application.js'), 1000, 1000);
  const trees = ['first', 'second'].map((name) => path.join(root, name));
  for (const [index, tree] of trees.entries()) {
    await fs.mkdir(path.join(tree, 'package'), { recursive: true });
    await fs.writeFile(path.join(tree, 'package', 'index.js'), 'export default 42;');
    await fs.writeFile(path.join(tree, 'package', 'executable'), 'binary payload');
    await fs.chmod(path.join(tree, 'package', 'executable'), 0o755);
    await fs.utimes(path.join(tree, 'package', 'index.js'), 2000 + index, 2000 + index);
  }
  const first = await normalizeRuntimeDependencies(trees[0]);
  const second = await normalizeRuntimeDependencies(trees[1]);
  assert.deepEqual(first, second);
  await fs.utimes(path.join(trees[1], 'package', 'index.js'), 3000, 3000);
  assert.deepEqual(await fingerprintRuntimeDependencies(trees[1]), first);
  assert.equal((await fs.stat(path.join(trees[1], 'package', 'index.js'))).mtimeMs, 3000000);
  assert.equal(first.files, 3);
  assert.equal((await fs.stat(path.join(trees[0], 'package', 'index.js'))).mtimeMs, 0);
  assert.equal((await fs.stat(path.join(trees[0], 'package'))).mtimeMs, 0);
  assert.equal((await fs.stat(path.join(root, 'application.js'))).mtimeMs, 1000000);
  await fs.writeFile(path.join(trees[1], 'package', 'executable'), 'patched security binary');
  assert.notEqual((await normalizeRuntimeDependencies(trees[1])).sha256, first.sha256);
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(trees[0], 'package', 'executable'), 0o644);
    assert.notEqual((await normalizeRuntimeDependencies(trees[0])).sha256, first.sha256);
  }
});

test('dependency links retain their targets and do not normalize external/workspace contents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-dependency-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, 'workspace'));
  await fs.utimes(path.join(root, 'workspace'), 2000, 2000);
  try {
    await fs.symlink('../workspace', path.join(root, 'node_modules', 'workspace'), 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM')
      return t.skip('Symlink creation requires Windows permission');
    throw error;
  }
  const result = await normalizeRuntimeDependencies(path.join(root, 'node_modules'));
  assert.equal(result.symlinks, 1);
  assert.equal(await fs.readlink(path.join(root, 'node_modules', 'workspace')), '../workspace');
  assert.equal((await fs.stat(path.join(root, 'workspace'))).mtimeMs, 2000000);
  await assert.rejects(normalizeRuntimeDependencies(path.join(root, 'node_modules', 'workspace')), /real directory/);
});
