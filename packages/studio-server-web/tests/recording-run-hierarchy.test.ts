import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupRecordingRuns,
  recordingHierarchyRows,
  refreshRecordingRowMeasurements,
} from '../dashboard/recording-run-hierarchy';
import type { WorkflowRecordingRunSummary } from '../dashboard/types';

function run(id: string, correlationId?: string, child = false): WorkflowRecordingRunSummary {
  return {
    id,
    workflowId: child ? 'called-project' : 'caller',
    createdAt: '2026-10-03T00:00:00Z',
    runKind: 'editor',
    status: 'succeeded',
    durationMs: 1,
    endpointNameAtExecution: id,
    executionIdentity: { surface: child ? 'subgraph_project' : 'editor_local', correlationId },
    hasReplayDataset: false,
    recordingCompressedBytes: 1,
    recordingUncompressedBytes: 1,
    projectCompressedBytes: 1,
    projectUncompressedBytes: 1,
    datasetCompressedBytes: 0,
    datasetUncompressedBytes: 0,
  };
}

test('context groups lazily load children without treating their representative as a root', () => {
  const representative = run('anchor', 'orphan-key', true);
  const other = run('newer-child', 'orphan-key', true);
  const initial = groupRecordingRuns([representative], {});
  assert.equal(initial[0]!.root, null);
  assert.equal(initial[0]!.childLoadState, 'unloaded');
  const loaded = groupRecordingRuns([other, representative], { anchor: 'complete' });
  assert.equal(loaded[0]!.root, null);
  assert.equal(loaded[0]!.childLoadState, 'complete');
  assert.equal(recordingHierarchyRows(loaded, new Set(['correlation:orphan-key'])).length, 3);
});

test('a paginated context anchor never attaches to one visible member of an ambiguous root key', () => {
  const root = run('one-of-two-primaries', 'ambiguous');
  const child = { ...run('context-anchor', 'ambiguous', true), familyContext: true as const };
  // The unmarked duplicate models the same child returned by its browse endpoint.
  const groups = groupRecordingRuns([root, child, { ...child, familyContext: undefined }], {});
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.root?.id, root.id);
  assert.equal(groups[0]!.children.length, 0);
  assert.equal(groups[1]!.root, null);
  assert.equal(groups[1]!.childLoadState, 'unloaded');
});

test('input matches offer child discovery before any children are loaded, preserving expansion and status', () => {
  const root = run('root', 'execution');
  const initial = groupRecordingRuns([root], {});
  assert.equal(initial[0]!.childLoadState, 'unloaded');
  assert.ok(recordingHierarchyRows(initial, new Set())[0]!.family);
  const loaded = groupRecordingRuns([root, run('child', 'execution', true)], { root: 'complete' });
  assert.equal(loaded[0]!.key, initial[0]!.key);
  assert.equal(recordingHierarchyRows(loaded, new Set([initial[0]!.key])).length, 2);
  const empty = groupRecordingRuns([root], { root: 'complete' });
  assert.equal(empty[0]!.children.length, 0);
  assert.equal(recordingHierarchyRows(empty, new Set())[0]!.family, null);
});

test('roots without retained sub-runs have no disclosure, while unknown and positive presence remain discoverable', () => {
  for (const hasSubRuns of [false, true, undefined]) {
    const root = { ...run('root', 'execution'), hasSubRuns };
    const [row] = recordingHierarchyRows(groupRecordingRuns([root], {}), new Set());
    assert.equal(row!.family !== null, hasSubRuns !== false);
    // Already loaded children take precedence over an older presence snapshot.
    const [withChild] = recordingHierarchyRows(
      groupRecordingRuns([root, run('child', 'execution', true)], {}),
      new Set(),
    );
    assert.ok(withChild!.family);
  }
});

test('children preceding their root are folded beneath it without duplicating recordings', () => {
  const child = run('child', 'execution', true);
  const root = run('root', 'execution');
  const unrelated = run('other', 'another');
  const families = groupRecordingRuns([child, unrelated, root, child]);
  assert.equal(families.length, 2);
  assert.equal(families[0]!.root, root);
  assert.deepEqual(families[0]!.children, [child]);
  const collapsed = recordingHierarchyRows(families, new Set());
  assert.deepEqual(
    collapsed.map((row) => row.recording?.id),
    ['root', 'other'],
  );
  const expanded = recordingHierarchyRows(families, new Set([families[0]!.key]));
  assert.deepEqual(
    expanded.map((row) => row.recording?.id),
    ['root', 'child', 'other'],
  );
  assert.equal(expanded[1]!.isChild, true);
  assert.equal(new Set(expanded.map((row) => row.id)).size, expanded.length);
});

for (const context of ['primary', 'related', 'loaded related'] as const) {
  test(`sub-runs are chronological regardless of status and arrival order in ${context} families`, () => {
    const root = run('root', 'execution');
    const children = [
      { ...run('latest-failed', 'execution', true), createdAt: '2026-10-03T00:00:03Z', status: 'failed' as const },
      { ...run('tie-b', 'execution', true), createdAt: '2026-10-03T00:00:02Z', status: 'succeeded' as const },
      { ...run('earliest', 'execution', true), createdAt: '2026-10-03T01:00:00+01:00' },
      { ...run('tie-a', 'execution', true), createdAt: '2026-10-03T00:00:02Z', status: 'suspicious' as const },
      { ...run('middle-failed', 'execution', true), createdAt: '2026-10-03T00:00:01Z', status: 'failed' as const },
    ];
    const input = context === 'primary' ? [root, ...children] : children;
    const before = [...input];
    const states = context === 'loaded related' ? { 'latest-failed': 'complete' as const } : undefined;
    const expected = ['earliest', 'middle-failed', 'tie-a', 'tie-b', 'latest-failed'];
    const groups = groupRecordingRuns(input, states);
    assert.deepEqual(
      groups[0]!.children.map((child) => child.id),
      expected,
    );
    assert.deepEqual(
      recordingHierarchyRows(groups, new Set([groups[0]!.key]))
        .filter((row) => row.isChild)
        .map((row) => row.recording!.id),
      expected,
    );
    assert.deepEqual(input, before, 'grouping must not reorder caller-owned results');
    // Arrival order across metadata pages and retries must not determine ties.
    assert.deepEqual(
      groupRecordingRuns([...input].reverse(), states)[0]!.children.map((child) => child.id),
      expected,
    );
  });
}

test('sorting descendants does not reorder primary recording families', () => {
  const newest = run('newest-root', 'new');
  const older = { ...run('older-root', 'old'), createdAt: '2026-10-02T00:00:00Z' };
  const groups = groupRecordingRuns([newest, older, run('new-child', 'new', true), run('old-child', 'old', true)]);
  assert.deepEqual(
    groups.map((group) => group.root?.id),
    ['newest-root', 'older-root'],
  );
});

test('filtered, page-split and retained orphan children get context, never a fake root', () => {
  const families = groupRecordingRuns([run('child-a', 'execution', true), run('child-b', 'execution', true)]);
  assert.equal(families.length, 1);
  assert.equal(families[0]!.root, null);
  assert.equal(recordingHierarchyRows(families, new Set())[0]!.recording, null);
  assert.deepEqual(
    recordingHierarchyRows(families, new Set([families[0]!.key]))
      .slice(1)
      .map((row) => row.recording?.id),
    ['child-a', 'child-b'],
  );
});

test('legacy children without execution keys remain individually discoverable', () => {
  const families = groupRecordingRuns([run('child-a', undefined, true), run('child-b', ' ', true), run('root')]);
  assert.equal(families.length, 3);
  assert.deepEqual(
    families.slice(0, 2).map((family) => family.root),
    [null, null],
  );
  assert.deepEqual(
    recordingHierarchyRows(families, new Set(families.map((family) => family.key)))
      .filter((row) => row.recording)
      .map((row) => row.recording!.id),
    ['child-a', 'child-b', 'root'],
  );
});

test('ambiguous primary keys do not assign children to an arbitrary primary', () => {
  const families = groupRecordingRuns([run('root-a', 'same'), run('child', 'same', true), run('root-b', 'same')]);
  assert.deepEqual(
    families.map((family) => family.root?.id ?? null),
    ['root-a', null, 'root-b'],
  );
  assert.equal(families[1]!.children[0]!.id, 'child');
});

test('correlation keys are exact and never inferred from workflow or graph names', () => {
  const families = groupRecordingRuns([run('root', 'A'), run('child', 'a', true)]);
  assert.equal(families.length, 2);
  assert.deepEqual(families[0]!.children, []);
  assert.equal(families[1]!.root, null);
});

test('descendants remain individually virtualized even for a large family', () => {
  const root = run('root', 'execution');
  const children = Array.from({ length: 5000 }, (_, i) => run(`child-${i}`, 'execution', true));
  const families = groupRecordingRuns([...children, root]);
  assert.equal(recordingHierarchyRows(families, new Set()).length, 1);
  assert.equal(recordingHierarchyRows(families, new Set([families[0]!.key])).length, 5001);
});

test('appending an older primary preserves an expanded filtered family identity', () => {
  const child = run('child', 'execution', true);
  const before = groupRecordingRuns([child]);
  const after = groupRecordingRuns([child, run('root', 'execution')]);
  // Correlation-backed families keep their key as search discovers older roots.
  assert.equal(before[0]!.key, after[0]!.key);
});

test('regrouping invalidates a changed offscreen row even when it moves to another index', () => {
  const root = run('root', 'execution');
  const other = run('other');
  const before = recordingHierarchyRows(groupRecordingRuns([other, root]), new Set());
  const after = recordingHierarchyRows(groupRecordingRuns([root, run('child', 'execution', true), other]), new Set());
  const heights = new Map([
    ['recording:root', 100],
    ['recording:other', 120],
    ['recording:deleted', 80],
  ]);
  assert.equal(refreshRecordingRowMeasurements(before, after, heights), 0);
  assert.equal(heights.has('recording:root'), false, 'the added family toggle changes the root height');
  assert.equal(heights.get('recording:other'), 120, 'unchanged moved rows retain their measurements');
  assert.equal(heights.has('recording:deleted'), false);
});

test('measurement refresh preserves stable rows and handles collapse and removal offsets', () => {
  const families = groupRecordingRuns([run('root', 'execution'), run('child', 'execution', true), run('other')]);
  const expanded = recordingHierarchyRows(families, new Set([families[0]!.key]));
  const heights = new Map(expanded.map((row) => [row.id, 100]));
  assert.equal(
    refreshRecordingRowMeasurements(expanded, recordingHierarchyRows(families, new Set([families[0]!.key])), heights),
    null,
  );
  assert.equal(refreshRecordingRowMeasurements(expanded, recordingHierarchyRows(families, new Set()), heights), 0);
  assert.equal(heights.has('recording:root'), false);
  assert.equal(heights.has('recording:child'), false);
  assert.equal(heights.get('recording:other'), 100);
  assert.equal(refreshRecordingRowMeasurements(expanded, [], heights), 0);
  assert.equal(heights.size, 0);
});
