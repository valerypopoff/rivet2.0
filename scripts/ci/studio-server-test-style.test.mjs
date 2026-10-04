import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertNoUpstreamAppSourceContracts,
  extractTestPaths,
} from '../../deploy/studio-server/scripts/verify-test-style.mjs';

test('explicit script paths cover the same TypeScript suffixes as API discovery', () => {
  assert.deepEqual(
    extractTestPaths(
      'tsx --test src/tests/a.test.ts "src/tests/nested/b.test.mts" src/tests/c.test.cts src/tests/d.spec.tsx src/fixture.ts && node verify.mjs',
    ),
    ['src/tests/a.test.ts', 'src/tests/nested/b.test.mts', 'src/tests/c.test.cts', 'src/tests/d.spec.tsx'],
  );
});

test('wrapper source policy rejects private App references while keeping the approved CSS seam', () => {
  assert.doesNotThrow(() =>
    assertNoUpstreamAppSourceContracts(['wrapper.test.ts'], () => "readRepoFile('packages/app/src/host.css')"),
  );
  for (const source of [
    "readRepoFile('packages/app/src/hooks/useActivateOpenedProject.ts')",
    String.raw`assert.match(source, /packages\/app\/src\/hooks\/useSyncProjectDirtyState.ts/);`,
    "readRepoFile('packages/app/src/host.css.backup')",
    "readRepoFile('packages/app/src/host.css'); readRepoFile('packages/app/src/state/savedGraphs.ts')",
  ]) {
    assert.throws(
      () => assertNoUpstreamAppSourceContracts(['wrapper.test.ts'], () => source),
      /wrapper\.test\.ts reads packages\/app\/src/,
    );
  }
});

test('root style verification also executes the actual Studio Server test policy CLI', () => {
  const rootDir = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'deploy/studio-server/scripts/verify-test-style.mjs')],
    { cwd: rootDir, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Test style guardrails passed/);
});
