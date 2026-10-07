import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareRuntimePackages } from './prepare-runtime-packages.mjs';

// test-style: fixture-read: verifies only generated container staging fixtures.

test('container runtime staging preserves compiled assets and bootstrap while excluding unrelated sources and tests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-container-runtime-'));
  try {
    for (const name of ['core', 'node', 'evaluations', 'studio-server-api', 'studio-server-bootstrap', 'app']) {
      const source = path.join(root, 'packages', name);
      await fs.mkdir(path.join(source, 'dist'), { recursive: true });
      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name, type: 'module' }));
      await fs.writeFile(path.join(source, 'dist', 'asset.json'), 'runtime fixture');
      await fs.writeFile(path.join(source, 'source.ts'), 'not a runtime input');
      if (name === 'core' || name === 'node') {
        await fs.writeFile(path.join(source, 'LICENSE'), `${name} license fixture`);
        await fs.writeFile(path.join(source, 'README.md'), `${name} readme fixture`);
      }
    }
    const bootstrap = path.join(root, 'packages/studio-server-bootstrap');
    await fs.writeFile(path.join(bootstrap, 'bootstrap.mjs'), 'export {};');
    await fs.writeFile(path.join(bootstrap, 'bootstrap.test.mjs'), 'test fixture');
    const tests = path.join(root, 'packages/studio-server-api/dist/studio-server-api/src/tests');
    await fs.mkdir(tests, { recursive: true });
    await fs.writeFile(path.join(tests, 'private-fixture.js'), 'not a runtime input');
    // Hoisted and workspace-local versions can coexist. Staging only dist and
    // package.json must not silently change which version a workspace resolves.
    for (const [workspace, value] of [
      ['', 'hoisted'],
      ['core', 'core-override'],
      ['studio-server-bootstrap', 'bootstrap-override'],
    ]) {
      const dependency = path.join(root, ...(workspace ? ['packages', workspace] : []), 'node_modules/runtime-fixture');
      await fs.mkdir(path.join(dependency, 'tests'), { recursive: true });
      await fs.writeFile(path.join(dependency, 'package.json'), '{"name":"runtime-fixture","main":"index.cjs"}');
      await fs.writeFile(path.join(dependency, 'index.cjs'), `module.exports=${JSON.stringify(value)};`);
      await fs.writeFile(path.join(dependency, 'tests/fixture.json'), 'dependency-owned bytes');
      // Linux image builds use relative links. Windows symlink permissions are
      // unrelated to this container contract; ordinary override coverage runs
      // there without requiring Developer Mode/elevation.
      if (process.platform !== 'win32') await fs.symlink('index.cjs', path.join(dependency, 'alias.cjs'));
    }
    for (const profile of ['api', 'executor']) {
      const destination = path.join(root, profile);
      await prepareRuntimePackages(root, destination, profile);
      assert.deepEqual(
        (await fs.readdir(destination)).sort(),
        [
          'core',
          'node',
          'evaluations',
          'studio-server-bootstrap',
          ...(profile === 'api' ? ['studio-server-api'] : []),
        ].sort(),
      );
      for (const workspace of ['core', 'node', 'evaluations']) {
        assert.equal(
          await fs.readFile(path.join(destination, workspace, 'dist/asset.json'), 'utf8'),
          'runtime fixture',
        );
        await assert.rejects(fs.stat(path.join(destination, workspace, 'source.ts')), { code: 'ENOENT' });
        if (workspace !== 'evaluations') {
          assert.equal(
            await fs.readFile(path.join(destination, workspace, 'LICENSE'), 'utf8'),
            `${workspace} license fixture`,
          );
          assert.equal(
            await fs.readFile(path.join(destination, workspace, 'README.md'), 'utf8'),
            `${workspace} readme fixture`,
          );
        }
      }
      assert.equal(
        await fs.readFile(path.join(destination, 'studio-server-bootstrap/bootstrap.mjs'), 'utf8'),
        'export {};',
      );
      await assert.rejects(fs.stat(path.join(destination, 'studio-server-bootstrap/bootstrap.test.mjs')), {
        code: 'ENOENT',
      });
      await assert.rejects(fs.stat(path.join(destination, 'studio-server-api/dist/studio-server-api/src/tests')), {
        code: 'ENOENT',
      });
      for (const workspace of ['core', 'studio-server-bootstrap']) {
        const require = createRequire(path.join(destination, workspace, 'package.json'));
        assert.equal(require('runtime-fixture'), `${workspace === 'core' ? 'core' : 'bootstrap'}-override`);
        if (process.platform !== 'win32') {
          assert.equal(
            await fs.readlink(path.join(destination, workspace, 'node_modules/runtime-fixture/alias.cjs')),
            'index.cjs',
          );
          assert.equal(require('runtime-fixture/alias.cjs'), require('runtime-fixture'));
        }
        assert.equal(
          await fs.readFile(
            path.join(destination, workspace, 'node_modules/runtime-fixture/tests/fixture.json'),
            'utf8',
          ),
          'dependency-owned bytes',
        );
      }
      await assert.rejects(prepareRuntimePackages(root, destination, profile), { code: 'EEXIST' });
    }
    await assert.rejects(prepareRuntimePackages(root, path.join(root, 'unknown'), 'unknown'), /Unknown/);
    const incomplete = path.join(root, 'incomplete');
    await fs.mkdir(incomplete);
    await assert.rejects(prepareRuntimePackages(incomplete, path.join(root, 'missing'), 'api'), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
