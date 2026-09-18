import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { resolveBundledSidecarPaths } from './verify-macos-sidecars.mjs';

void test('verifies the canonical sidecar names that Tauri installs in a macOS app bundle', () => {
  const macosDirectory = join('Applications', 'Rivet 2.app', 'Contents', 'MacOS');
  const paths = resolveBundledSidecarPaths(macosDirectory);

  assert.deepEqual(paths, {
    executorPath: join(macosDirectory, 'app-executor'),
    pnpmPath: join(macosDirectory, 'pnpm'),
  });
});
