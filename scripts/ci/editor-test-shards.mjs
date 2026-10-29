// File-level weights from successful browser journeys in run 40051188301.
// Hints balance work; they never select or omit individual test cases.
const weightedSpecs = [
  ['explicit-bundles.spec.ts', 132],
  ['modal-sizing.spec.ts', 9],
  ['scheduled-runs.spec.ts', 101],
  ['fullscreen-output-search-paging.spec.ts', 16],
  ['hosted-modal-focus.spec.ts', 117],
  ['hosted-editor-search-shortcuts.spec.ts', 22],
  ['hosted-dashboard-contracts.spec.ts', 27],
  ['hosted-executor-origin.spec.ts', 50],
  ['project-bundle.spec.ts', 55],
  ['project-bundle-upload.spec.ts', 13],
  ['sidebar-name-wrapping.spec.ts', 22],
  ['streaming-nodes.spec.ts', 23],
  ['project-tree-activation.spec.ts', 228],
  ['port-connection-warnings.spec.ts', 20],
  ['cross-project-subgraph-loading.spec.ts', 122],
  ['subgraph-bundle-scope.spec.ts', 15],
  ['bundle-local-execution-history.spec.ts', 15],
  ['hosted-subgraph-auth.spec.ts', 198],
  ['remote-bundle-observation.spec.ts', 220],
  ['ha-latest-replay.spec.ts', 16],
  // Two independent contexts, scoped HA transport, real runs and reconnect.
  ['managed-debugger-channels.spec.ts', 56],
  ['ha-recording-selection.spec.ts', 12],
  ['recording-playback-history.spec.ts', 50],
  ['graph-deletion-references.spec.ts', 46],
  ['node-editor-ownership.spec.ts', 84],
  ['node-editor-lifecycle.spec.ts', 197],
  ['llm-temperature.spec.ts', 43],
  ['evaluation-history-paging.spec.ts', 41],
  // Initial estimate for the isolated trial/recording integration fixture.
  ['evaluation-trial-orchestration.spec.ts', 20],
  // Initial estimate for the isolated history/preload regression.
  ['partial-run-preload.spec.ts', 13],
  // Crossing/curved/bent wire routes through pan, zoom, resize and culling.
  ['wire-viewport-culling.spec.ts', 25],
  ['tunnel-cache-retention.spec.ts', 1],
  ['run-statistics-modal.spec.ts', 15],
  // Debug node discovery, output labels, icons and documentation links.
  ['graph-call-path-node.spec.ts', 15],
  // Real local PostgreSQL/MinIO + provider HTTP, including cancellation settlement.
  ['run-cost-statistics.spec.ts', 60],
];

export const editorCiSpecs = Object.freeze(weightedSpecs.map(([spec]) => spec));
const groups = Array.from({ length: 3 }, () => ({ specs: [], seconds: 0 }));
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
  const index = ['1/3', '2/3', '3/3'].indexOf(shard);
  if (index < 0) throw Error('RIVET_EDITOR_TEST_SHARD must be 1/3, 2/3 or 3/3.');
  return editorCiShards[index].specs;
}
