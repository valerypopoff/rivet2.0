import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createCodeRunnerRequire,
  getCodeRunnerRequireAnchorPath,
  getCodeRunnerRequireRoot,
} from './codeRunnerRequire.mjs';

void describe('app-executor codeRunnerRequire', () => {
  void it('matches the public Node code-runner require env contract', () => {
    assert.equal(getCodeRunnerRequireRoot({}, '/workspace/project'), '/workspace/project');
    assert.equal(
      getCodeRunnerRequireAnchorPath({ RIVET_CODE_RUNNER_REQUIRE_ROOT: '/data/runtime-libraries/current' }, '/ignored'),
      join('/data/runtime-libraries/current', '__rivet_node_code_runner__.cjs'),
    );
    assert.equal(
      getCodeRunnerRequireAnchorPath({
        RIVET_CODE_RUNNER_REQUIRE_ANCHOR: '/data/runtime-libraries/current/custom-anchor.cjs',
        RIVET_CODE_RUNNER_REQUIRE_ROOT: '/ignored',
      }),
      '/data/runtime-libraries/current/custom-anchor.cjs',
    );
  });
  void it('invalidates nested CommonJS packages after atomic runtime release replacement and removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-runtime-refresh-'));
    const current = join(root, 'current');
    const env = { RIVET_CODE_RUNNER_REQUIRE_ROOT: current };
    const stage = async (name: string, value?: number) => {
      const directory = join(root, name);
      await mkdir(join(directory, 'node_modules', 'example'), { recursive: true });
      if (value !== undefined) {
        await writeFile(
          join(directory, 'node_modules', 'example', 'index.js'),
          "module.exports=require('./value.cjs');",
        );
        await writeFile(join(directory, 'node_modules', 'example', 'value.cjs'), `module.exports=${value};`);
      }
      return directory;
    };
    try {
      await rename(await stage('first', 84), current);
      const nestedEnv = { RIVET_CODE_RUNNER_REQUIRE_ROOT: join(current, 'node_modules') };
      assert.equal(createCodeRunnerRequire(env)('example'), 84);
      assert.equal(createCodeRunnerRequire(nestedEnv)('example'), 84);
      const second = await stage('second', 42);
      await rename(current, join(root, 'retained-first'));
      await rename(second, current);
      assert.equal(createCodeRunnerRequire(nestedEnv)('example'), 42);
      assert.equal(createCodeRunnerRequire(env)('example'), 42);
      const empty = await stage('empty');
      await rename(current, join(root, 'retained-second'));
      await rename(empty, current);
      assert.throws(() => createCodeRunnerRequire(env)('example'), /Cannot find module|ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  void it('resolves changed package entry points through versioned runtime-cache activation links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-runtime-entry-refresh-'));
    const current = join(root, 'current');
    const env = { RIVET_CODE_RUNNER_REQUIRE_ROOT: current };
    const stage = async (name: string, entry: string, value: number) => {
      const directory = join(root, name);
      const pkg = join(directory, 'node_modules', 'example');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'example', main: entry }));
      await writeFile(join(pkg, entry), `module.exports=${value};`);
      return directory;
    };
    try {
      await symlink(await stage('first', 'first.cjs', 84), current, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(createCodeRunnerRequire(env)('example'), 84);
      await unlink(current);
      await symlink(
        await stage('second', 'second.cjs', 42),
        current,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      assert.equal(createCodeRunnerRequire(env)('example'), 42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
