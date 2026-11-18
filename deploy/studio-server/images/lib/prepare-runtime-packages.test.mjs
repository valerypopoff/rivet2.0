import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareRuntimePackages } from './prepare-runtime-packages.mjs';
import { removeRuntimeBuildGlobs } from './remove-runtime-build-globs.mjs';

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
    await fs.writeFile(path.join(bootstrap, 'runtime-release-cache.mjs'), 'export const snapshot = true;');
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
      for (const [name, version] of [
        ['picomatch', '2.3.2'],
        ['micromatch', '4.0.8'],
      ]) {
        const tool = path.join(path.dirname(dependency), name);
        await fs.mkdir(tool, { recursive: true });
        await fs.writeFile(path.join(tool, 'package.json'), JSON.stringify({ name, version }));
        await fs.writeFile(path.join(tool, 'index.cjs'), 'module.exports = "builder tool";');
      }
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
      assert.equal(
        await fs.readFile(path.join(destination, 'studio-server-bootstrap/runtime-release-cache.mjs'), 'utf8'),
        'export const snapshot = true;',
      );
      await assert.rejects(fs.stat(path.join(destination, 'studio-server-api/dist/studio-server-api/src/tests')), {
        code: 'ENOENT',
      });
      for (const workspace of ['core', 'studio-server-bootstrap']) {
        for (const name of ['picomatch', 'micromatch']) {
          await assert.rejects(fs.stat(path.join(destination, workspace, 'node_modules', name)), { code: 'ENOENT' });
          assert.equal(
            await fs.readFile(path.join(root, 'packages', workspace, 'node_modules', name, 'index.cjs'), 'utf8'),
            'module.exports = "builder tool";',
          );
        }
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

test('runtime glob pruning checks versions, handles nested copies and preserves other packages and links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-globs-'));
  const modules = path.join(root, 'node_modules');
  const packageAt = async (relative, name, version) => {
    const directory = path.join(modules, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version }));
    await fs.writeFile(path.join(directory, 'index.cjs'), 'module.exports = "preserved";');
  };
  try {
    await packageAt('picomatch', 'picomatch', '2.3.2');
    await packageAt('@scope/tool/node_modules/picomatch', 'picomatch', '4.0.5');
    await packageAt('micromatch', 'micromatch', '4.0.8');
    await packageAt('kept', 'kept', '1.0.0');
    const builderFile = path.join(root, 'builder.cjs');
    await fs.link(path.join(modules, 'picomatch/index.cjs'), builderFile);
    const outside = path.join(root, 'outside/node_modules');
    await fs.mkdir(path.join(outside, 'picomatch'), { recursive: true });
    await fs.writeFile(path.join(outside, 'picomatch/keep.txt'), 'outside runtime copy');
    if (process.platform !== 'win32') {
      await fs.symlink(path.dirname(outside), path.join(modules, 'linked'), 'dir');
      await assert.rejects(removeRuntimeBuildGlobs(path.join(modules, 'linked')), /real directory/);
    }
    assert.deepEqual(
      (await removeRuntimeBuildGlobs(modules)).sort(),
      ['picomatch', 'micromatch', path.join('@scope/tool/node_modules/picomatch')].sort(),
    );
    await assert.rejects(fs.stat(path.join(modules, 'picomatch')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(builderFile, 'utf8'), 'module.exports = "preserved";');
    assert.equal(await fs.readFile(path.join(modules, 'kept/index.cjs'), 'utf8'), 'module.exports = "preserved";');
    assert.equal(await fs.readFile(path.join(outside, 'picomatch/keep.txt'), 'utf8'), 'outside runtime copy');
    assert.equal((await fs.stat(modules)).mtimeMs, 0);
    assert.deepEqual(await removeRuntimeBuildGlobs(modules), []);
    await packageAt('picomatch', 'picomatch', '5.0.0');
    await packageAt('micromatch', 'micromatch', '4.0.8');
    await assert.rejects(removeRuntimeBuildGlobs(modules), /Review changed/);
    await fs.stat(path.join(modules, 'micromatch/index.cjs')); // No partial deletion on failed validation.
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
