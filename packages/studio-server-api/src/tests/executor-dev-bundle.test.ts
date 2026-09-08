import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildExecutorBundle } = require(
  path.join(repoRoot, 'packages/studio-server-executor/build/bundle-executor.cjs'),
) as {
  buildExecutorBundle: (overrides: { write: false; metafile: true }) => Promise<{
    metafile: { inputs: Record<string, unknown> };
  }>;
};

test('Studio Server Node executor bundles the current Core source graph', async () => {
  const result = await buildExecutorBundle({ write: false, metafile: true });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll('\\', '/'));

  assert.ok(inputs.some((input) => input.endsWith('packages/core/src/utils/jsonPath.ts')));
  assert.ok(inputs.some((input) => input.endsWith('packages/core/src/interpolationRuntime.ts')));
  assert.equal(
    inputs.some((input) => input.includes('packages/core/dist/')),
    false,
  );
});
