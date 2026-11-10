import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBundleMergeSuggestions,
  describeBundleMergeSite,
  suggestBundleMergeCounterpart,
} from '../dashboard/bundleMerge.js';
import type { BundleMergeChoices, BundleMergePreview } from '../../studio-server-shared/workflow-bundle-types.js';

test('counterpart suggestions prefer one exact relative path and leave ambiguous names unresolved', () => {
  const source = { projectId: 'copy', title: 'Same', relativePath: 'Nested/A.rivet-project' };
  const targets = [
    { projectId: 'one', title: 'Same', relativePath: 'Other/A.rivet-project' },
    { projectId: 'two', title: 'Same', relativePath: 'Nested/A.rivet-project' },
  ];
  assert.equal(suggestBundleMergeCounterpart(source, targets), 'two');
  assert.equal(suggestBundleMergeCounterpart({ ...source, relativePath: 'Missing.rivet-project' }, targets), null);
  assert.equal(suggestBundleMergeCounterpart(source, targets.slice(0, 1)), 'one');
  assert.equal(suggestBundleMergeCounterpart(source, []), null);
});

test('review locations distinguish same-name projects and identify saved variants', () => {
  const catalogs = {
    source: {
      bundleId: 'copy',
      namespaceId: 'copy-folder',
      name: 'Bundle',
      relativePath: 'Copies/Bundle',
      projects: [{ projectId: 'source', title: 'Same', relativePath: 'Nested/Same.rivet-project' }],
    },
    destination: {
      bundleId: 'original',
      namespaceId: 'original-folder',
      name: 'Bundle',
      relativePath: 'Original/Bundle',
      projects: [{ projectId: 'target', title: 'Same', relativePath: 'Other/Same.rivet-project' }],
    },
  };
  const site = {
    projectId: 'source',
    projectTitle: 'Same',
    graphName: 'Main',
    nodeId: 'call',
    variantIndex: 0,
    active: false,
  };
  assert.equal(
    describeBundleMergeSite(site, catalogs),
    'Copies/Bundle/Nested/Same.rivet-project / Main / (call) / variant 1 / (inactive)',
  );
  assert.equal(
    describeBundleMergeSite({ ...site, projectId: 'target' }, catalogs),
    'Original/Bundle/Other/Same.rivet-project / Main / (call) / variant 1 / (inactive)',
  );
  assert.equal(describeBundleMergeSite(site, null), 'Same (source) / Main / (call) / variant 1 / (inactive)');
});

test('automatic choices include only changed/new projects and required clear matches', () => {
  const source = ['changed', 'new', 'same', 'ambiguous'].map((projectId) => ({
    projectId,
    title: projectId,
    relativePath: projectId + '.rivet-project',
  }));
  const suggestions: NonNullable<BundleMergePreview['suggestions']> = [
    { sourceProjectId: 'changed', state: 'changed', targetProjectId: 'original' },
    { sourceProjectId: 'new', state: 'new' },
    { sourceProjectId: 'same', state: 'unchanged', targetProjectId: 'kept' },
    { sourceProjectId: 'ambiguous', state: 'ambiguous' },
  ];
  const preview = {
    source: { projects: source },
    destination: { projects: [] },
    requiredProjects: [{ project: source[2]!, sites: [] }],
    suggestions,
  } as unknown as BundleMergePreview;
  const choices: BundleMergeChoices = { destinationBundleId: 'destination', actions: [], dependencies: [], graphs: [] };
  const defaults = applyBundleMergeSuggestions(choices, preview, suggestions, true);
  assert.deepEqual(defaults.actions, [
    { sourceProjectId: 'changed', kind: 'replace', targetProjectId: 'original' },
    { sourceProjectId: 'new', kind: 'add', relativePath: 'new.rivet-project' },
  ]);
  assert.deepEqual(defaults.dependencies, [{ sourceProjectId: 'same', kind: 'existing', targetProjectId: 'kept' }]);
  const edited = {
    ...defaults,
    actions: [{ sourceProjectId: 'new', kind: 'add' as const, relativePath: 'Custom/New.rivet-project' }],
    dependencies: [{ sourceProjectId: 'same', kind: 'add' as const, relativePath: 'Custom/Same.rivet-project' }],
  };
  assert.equal(applyBundleMergeSuggestions(edited, preview, suggestions, false), edited);
  assert.equal(
    applyBundleMergeSuggestions(
      choices,
      { ...preview, requiredProjects: [] },
      suggestions.filter((value) => value.state === 'unchanged'),
      true,
    ),
    choices,
  );
});
