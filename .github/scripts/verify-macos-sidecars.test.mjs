import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { assertSmokeResult, createSmokeProject, resolveBundledSidecarPaths } from './verify-macos-sidecars.mjs';

void test('verifies the canonical sidecar names that Tauri installs in a macOS app bundle', () => {
  const macosDirectory = join('Applications', 'Rivet 2.app', 'Contents', 'MacOS');
  const paths = resolveBundledSidecarPaths(macosDirectory);

  assert.deepEqual(paths, {
    executorPath: join(macosDirectory, 'app-executor'),
    pnpmPath: join(macosDirectory, 'pnpm'),
  });
});

void test('uses the Code node whole-value output contract in the packaged executor smoke test', () => {
  const project = createSmokeProject();
  const outputNode = project.graphs.main.nodes.find((node) => node.id === 'result-output');

  assert.equal(outputNode?.data.dataType, 'any');
  assertSmokeResult({
    data: {
      results: {
        result: { type: 'any', value: 'native sidecar' },
      },
    },
  });
});
