// Hosted total case-time estimates, using the higher per-file work from runs
// 43429991232 and 43434671248, rounded up to five seconds. Not parallel wall time.
// Hints balance work; they never select or omit individual test cases.
const weightedSpecs = [
  ['explicit-bundles.spec.ts', 165],
  // Comparison, recovery, modal layout and native drag journeys.
  ['bundle-merge.spec.ts', 170],
  // Complete comparison/edit/save/swap/recovery and iframe-owner journeys.
  ['bundle-comparison.spec.ts', 260],
  ['modal-sizing.spec.ts', 15],
  ['scheduled-runs.spec.ts', 105],
  ['fullscreen-output-search-paging.spec.ts', 20],
  ['hosted-modal-focus.spec.ts', 155],
  ['hosted-editor-search-shortcuts.spec.ts', 35],
  ['hosted-dashboard-contracts.spec.ts', 30],
  // Preview recording, incomplete-history and receipt recovery.
  ['hosted-executor-origin.spec.ts', 110],
  // Includes admission races and error-recovery regressions.
  ['project-bundle.spec.ts', 110],
  ['project-bundle-upload.spec.ts', 15],
  ['sidebar-name-wrapping.spec.ts', 20],
  ['streaming-nodes.spec.ts', 30],
  ['project-tree-activation.spec.ts', 240],
  ['port-connection-warnings.spec.ts', 25],
  ['cross-project-subgraph-loading.spec.ts', 200],
  ['subgraph-bundle-scope.spec.ts', 20],
  ['bundle-local-execution-history.spec.ts', 15],
  ['hosted-subgraph-auth.spec.ts', 280],
  ['remote-bundle-observation.spec.ts', 230],
  ['ha-latest-replay.spec.ts', 20],
  // Complete hosted fixture, including scoped HA transport, runs and reconnect.
  ['managed-debugger-channels.spec.ts', 265],
  ['ha-recording-selection.spec.ts', 15],
  ['recording-playback-history.spec.ts', 65],
  ['graph-deletion-references.spec.ts', 75],
  ['node-editor-ownership.spec.ts', 95],
  ['node-editor-lifecycle.spec.ts', 195],
  ['llm-temperature.spec.ts', 60],
  ['evaluation-history-paging.spec.ts', 40],
  ['evaluation-trial-orchestration.spec.ts', 15],
  ['partial-run-preload.spec.ts', 10],
  // Crossing/curved/bent wire routes through pan, zoom, resize and culling.
  ['wire-viewport-culling.spec.ts', 45],
  ['tunnel-cache-retention.spec.ts', 5],
  ['run-statistics-modal.spec.ts', 45],
  // Hosted CI work estimate; isolated cases can share both browser workers.
  ['run-recordings-modal.spec.ts', 680],
  // Debug node discovery, output labels, icons and documentation links.
  ['graph-call-path-node.spec.ts', 15],
  // Real local PostgreSQL/MinIO + provider HTTP, including cancellation settlement.
  ['run-cost-statistics.spec.ts', 55],
];

export const editorCiSpecs = Object.freeze(weightedSpecs.map(([spec]) => spec));
const groups = Array.from({ length: 4 }, () => ({ specs: [], seconds: 0 }));
for (const [spec, seconds] of [...weightedSpecs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  const group = groups.reduce((best, candidate) => (candidate.seconds < best.seconds ? candidate : best));
  group.specs.push(spec);
  group.seconds += seconds;
}
export const editorCiShards = Object.freeze(
  groups.map((group) =>
    Object.freeze({
      specs: Object.freeze(group.specs.sort()),
      seconds: group.seconds,
    }),
  ),
);

/** No shard means the complete CI suite, preserving local commands. */
export function selectEditorCiSpecs(shard) {
  if (shard === undefined) return editorCiSpecs;
  const index = ['1/4', '2/4', '3/4', '4/4'].indexOf(shard);
  if (index < 0) throw Error('RIVET_EDITOR_TEST_SHARD must be 1/4, 2/4, 3/4 or 4/4.');
  return editorCiShards[index].specs;
}
