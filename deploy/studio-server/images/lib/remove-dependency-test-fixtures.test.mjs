import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { removeDependencyTestFixtures } from './remove-dependency-test-fixtures.mjs';

// test-style: fixture-read: only generated dependency packaging fixtures are inspected.
test('dependency cleanup removes only known unexported fixtures and preserves runtime resolution', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-dependency-fixtures-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules');
  const bases = ['autoevals/node_modules', '@fixture/converter/node_modules', '', 'zod-to-json-schema/node_modules'];
  for (const base of bases) {
    const dependency = path.join(modules, base, 'zod-to-json-schema');
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({
        name: 'zod-to-json-schema',
        version: '3.25.1',
        main: 'index.cjs',
      }),
    );
    await fs.writeFile(path.join(dependency, 'index.cjs'), 'module.exports = value => ({ type: value });');
    for (const directory of ['dist-test-v3', 'dist-test-v4', 'tests', 'dist', 'node_modules/zod']) {
      await fs.mkdir(path.join(dependency, directory), { recursive: true });
      await fs.writeFile(path.join(dependency, directory, 'keep.json'), '{}');
    }
  }
  const linkedRoot = path.join(root, 'linked-node-modules');
  await fs.symlink(modules, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeDependencyTestFixtures(linkedRoot), /root must be a real directory/);
  assert.ok((await fs.stat(path.join(modules, 'zod-to-json-schema/dist-test-v3'))).isDirectory());
  // A fixture-free converter still needs its nested dependencies visited.
  const outer = path.join(modules, 'zod-to-json-schema');
  await fs.rm(path.join(outer, 'dist-test-v3'), { recursive: true });
  await fs.rm(path.join(outer, 'dist-test-v4'), { recursive: true });
  await removeDependencyTestFixtures(modules);
  await removeDependencyTestFixtures(modules); // Idempotent without removing runtime directories.
  for (const base of bases) {
    const dependency = path.join(modules, base, 'zod-to-json-schema');
    const require = createRequire(path.join(dependency, 'package.json'));
    assert.deepEqual(require('./index.cjs')('string'), { type: 'string' });
    for (const directory of ['tests', 'dist', 'node_modules/zod'])
      assert.equal(await fs.readFile(path.join(dependency, directory, 'keep.json'), 'utf8'), '{}');
    for (const directory of ['dist-test-v3', 'dist-test-v4'])
      await assert.rejects(fs.stat(path.join(dependency, directory)), { code: 'ENOENT' });
  }
  const dependency = path.join(modules, 'zod-to-json-schema');
  await fs.mkdir(path.join(dependency, 'dist-test-v3'));
  for (const manifest of [
    { name: 'different-package', version: '3.25.1' },
    { name: 'zod-to-json-schema', version: '4.0.0' },
    { name: 'zod-to-json-schema', version: '3.25.1', exports: './dist-test-v3/index.js' },
    { name: 'zod-to-json-schema', version: '3.25.1', browser: './dist-test-v3/browser.js' },
    { name: 'zod-to-json-schema', version: '3.25.1', bin: { convert: './dist-test-v3/cli.js' } },
    { name: 'zod-to-json-schema', version: '3.25.1', typesVersions: { '*': { '*': ['dist-test-v3/types.d.ts'] } } },
  ]) {
    await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(removeDependencyTestFixtures(modules), /Review changed|Refusing/);
    assert.ok((await fs.stat(path.join(dependency, 'dist-test-v3'))).isDirectory());
  }
  await fs.writeFile(path.join(dependency, 'package.json'), '{"name":"zod-to-json-schema","version":"3.25.1"}');
  await fs.writeFile(path.join(dependency, 'dist-test-v4'), 'unexpected file');
  await assert.rejects(removeDependencyTestFixtures(modules), /Refusing/);
  assert.ok(
    (await fs.stat(path.join(dependency, 'dist-test-v3'))).isDirectory(),
    'validate both roots before deletion',
  );
  await fs.rm(path.join(dependency, 'dist-test-v4'));
  const external = path.join(root, 'not-a-fixture');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'keep.json'), '{}');
  await fs.symlink(external, path.join(dependency, 'dist-test-v4'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeDependencyTestFixtures(modules), /Refusing/);
  assert.equal(await fs.readFile(path.join(external, 'keep.json'), 'utf8'), '{}');
  assert.ok((await fs.stat(path.join(dependency, 'dist-test-v3'))).isDirectory());
});
