import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const missingPluginsModalSource = readFileSync(new URL('./MissingAppPluginsModal.tsx', import.meta.url), 'utf8');

test('missing app plugins modal reports graph-derived plugin usage instead of stale project YAML specs', () => {
  assert.match(missingPluginsModalSource, /deriveProjectPluginSpecsFromGraphs/);
  assert.match(missingPluginsModalSource, /useProjectNodeRegistry/);
  assert.match(missingPluginsModalSource, /const projectPluginSpecs = useMemo\(/);
  assert.match(missingPluginsModalSource, /getMissingAppPluginSpecs\(projectPluginSpecs, appPluginSpecs\)/);
  assert.doesNotMatch(missingPluginsModalSource, /getMissingAppPluginSpecs\(project\.plugins/);
});
