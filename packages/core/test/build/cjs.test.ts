import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);

for (const hasSerialization of [false, true]) {
  test(`shared CJS builder handles a workspace ${hasSerialization ? 'with' : 'without'} serialization`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rivet-cjs-build-'));
    try {
      mkdirSync(path.join(directory, 'src'));
      writeFileSync(path.join(directory, 'src/index.ts'), 'export const main = "workspace";');
      if (hasSerialization) {
        writeFileSync(path.join(directory, 'src/serialization.ts'), 'export const serialize = JSON.stringify;');
      }
      const result = spawnSync(
        process.execPath,
        ['--require', path.join(root, '.pnp.cjs'), path.join(root, 'packages/core/bundle.esbuild.cjs')],
        { cwd: directory, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = path.join(directory, 'dist/cjs');
      assert.deepEqual(
        readdirSync(output).filter((name) => name.endsWith('.cjs')).sort(),
        hasSerialization ? ['bundle.cjs', 'serialization.cjs'] : ['bundle.cjs'],
      );
      assert.equal(require(path.join(output, 'bundle.cjs')).main, 'workspace');
      if (hasSerialization) {
        assert.equal(require(path.join(output, 'serialization.cjs')).serialize({ value: 1 }), '{"value":1}');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
