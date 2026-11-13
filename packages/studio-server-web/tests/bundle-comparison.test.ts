import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBundleComparisonPairs,
  suggestBundleComparison,
  isBundleComparisonCommand,
  isBundleComparisonEditorState,
  type BundleComparisonManifest,
} from '../../studio-server-shared/workflow-bundle-comparison-types';

const project = (projectId: string, relativePath: string, name = relativePath) => ({
  projectId,
  relativePath,
  name,
  revisionId: projectId + '-revision',
  publishedRevisionId: null,
});
const catalog = (bundleId: string, projects: ReturnType<typeof project>[]) => ({
  bundleId,
  name: bundleId,
  relativePath: bundleId,
  folders: [],
  projects,
});
void test('cancellation reports remain explicit and validated independently from read failures', () => {
  assert.equal(isBundleComparisonEditorState({ owner: null, projectId: 'new', cancelled: true }), true);
  assert.equal(
    isBundleComparisonEditorState({ owner: null, projectId: 'new', error: 'Unreadable saved version' }),
    true,
  );
  assert.equal(isBundleComparisonEditorState({ owner: null, projectId: 'new', cancelled: 'yes' }), false);
  assert.equal(
    isBundleComparisonEditorState({
      owner: null,
      projectId: null,
      exitedOwner: { sessionId: 'session', generation: 2 },
    }),
    true,
  );
  assert.equal(isBundleComparisonEditorState({ owner: null, projectId: null, exitedOwner: true }), false);
  assert.equal(
    isBundleComparisonEditorState({
      owner: null,
      projectId: null,
      exitedOwner: { sessionId: 'session', generation: -1 },
    }),
    false,
  );
});
void test('comparison suggestions are one-to-one; confirmed mapping accounts for both bundles', () => {
  const manifest: BundleComparisonManifest = {
    older: catalog('old', [project('a', 'a'), project('b', 'b')]),
    newer: catalog('new', [project('a1', 'a'), project('c1', 'c')]),
    capturedAt: '',
  };
  assert.deepEqual(suggestBundleComparison(manifest), { a: 'a1', b: null });
  assert.deepEqual(buildBundleComparisonPairs(manifest, suggestBundleComparison(manifest)), [
    { olderId: 'a', newerId: 'a1' },
    { olderId: 'b', newerId: null },
    { olderId: null, newerId: 'c1' },
  ]);
  assert.throws(() => buildBundleComparisonPairs(manifest, { a: undefined, b: null }), /Choose a counterpart/);
  assert.throws(() => buildBundleComparisonPairs(manifest, { a: 'a1', b: 'a1' }), /distinct/);
});
void test('competing suggestions remain unresolved instead of choosing the first project', () => {
  const manifest = {
    older: catalog('old', [project('a', 'a', 'Same'), project('b', 'b', 'Same')]),
    newer: catalog('new', [project('c', 'c', 'Same')]),
    capturedAt: '',
  };
  assert.deepEqual(suggestBundleComparison(manifest), { a: undefined, b: undefined });
});
void test('two fully unmatched 256-project bundles produce 512 one-sided pairs', () => {
  const manifest = {
    older: catalog(
      'old',
      Array.from({ length: 256 }, (_, i) => project(`a${i}`, `a${i}`)),
    ),
    newer: catalog(
      'new',
      Array.from({ length: 256 }, (_, i) => project(`b${i}`, `b${i}`)),
    ),
    capturedAt: '',
  };
  assert.equal(buildBundleComparisonPairs(manifest, suggestBundleComparison(manifest)).length, 512);
});
void test('bridge admission rejects incomplete, duplicated or inconsistent correspondence and keeps opaque IDs case-sensitive', () => {
  const older = catalog('old', [project('A', 'first'), project('a', 'second')]);
  const command = {
    type: 'bundle-comparison',
    requestId: 'request',
    action: 'open',
    intent: {
      sessionId: 'session',
      generation: 1,
      pair: {
        older: { bundleId: 'old', projectId: 'A', revisionId: 'A-revision' },
        newer: { bundleId: 'new', projectId: 'after' },
      },
      pairs: [
        { olderId: 'A', newerId: 'after' },
        { olderId: 'a', newerId: null },
      ],
      referenceCatalog: older,
      labels: { referenceLabel: 'Older', currentLabel: 'Newer' },
    },
  };
  assert.equal(isBundleComparisonCommand(command), true);
  for (const change of [
    { pairs: [{ olderId: 'A', newerId: 'after' }] },
    {
      pairs: [
        { olderId: 'A', newerId: 'after' },
        { olderId: 'a', newerId: 'after' },
      ],
    },
    { pair: { ...command.intent.pair, older: { ...command.intent.pair.older, revisionId: 'other' } } },
    { pair: { ...command.intent.pair, newer: { bundleId: 'old', projectId: 'after' } } },
    { pair: { ...command.intent.pair, newer: null } },
  ])
    assert.equal(isBundleComparisonCommand({ ...command, intent: { ...command.intent, ...change } }), false);
});
