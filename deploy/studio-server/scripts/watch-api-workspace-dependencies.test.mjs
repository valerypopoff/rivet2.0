import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { missingWorkspaceDependencyEntrypoints } from './watch-api-workspace-dependencies.mjs';

test('detects exactly the Studio Server API workspace outputs needed by the dev watcher', () => {
  const rootDir = '/workspace';
  const expected = [
    'packages/core/dist/esm/index.js',
    'packages/node/dist/esm/index.js',
    'packages/evaluations/dist/esm/index.js',
  ].map((entrypoint) => join(rootDir, entrypoint));

  const present = new Set(expected);
  assert.deepEqual(
    missingWorkspaceDependencyEntrypoints(rootDir, (entrypoint) => present.has(entrypoint)),
    [],
  );

  for (const unavailableEntrypoint of expected) {
    present.delete(unavailableEntrypoint);
    assert.deepEqual(
      missingWorkspaceDependencyEntrypoints(rootDir, (entrypoint) => present.has(entrypoint)),
      [unavailableEntrypoint],
    );
    present.add(unavailableEntrypoint);
  }
});
