// Hosted total case-time estimates, using the higher per-file work from runs
// 44964153448, 45041549860 and 45045691893, rounded up to five seconds.
// Hints balance work; they never select or omit individual test cases.
const weightedSpecs = [
  ['explicit-bundles.spec.ts', 180],
  // Comparison, recovery, modal layout and native drag journeys.
  ['bundle-merge.spec.ts', 155],
  // Complete comparison/edit/save/swap/recovery and iframe-owner journeys.
  ['bundle-comparison.spec.ts', 295],
  ['modal-sizing.spec.ts', 25],
  ['deployment-status.spec.ts', 35],
  // Initial local total case work on 2026-11-24, rounded up to five seconds:
  // panel 450.7s, prompt 137.5s. Refresh with hosted evidence; no speed claim.
  ['local-storage-upgrade.spec.ts', 455],
  ['local-storage-upgrade-prompt.spec.ts', 140],
  ['scheduled-runs.spec.ts', 90],
  ['fullscreen-output-search-paging.spec.ts', 30],
  ['hosted-modal-focus.spec.ts', 165],
  ['hosted-editor-search-shortcuts.spec.ts', 45],
  ['hosted-dashboard-contracts.spec.ts', 25],
  // Initial local case-work allocation (1.8s, rounded up); the shared beforeAll
  // startup uses setup headroom. Refresh with hosted evidence, not a speed claim.
  ['oauth-mechanics.spec.ts', 5],
  // Preview recording, incomplete-history and receipt recovery.
  ['hosted-executor-origin.spec.ts', 110],
  // Includes admission races and error-recovery regressions.
  ['project-bundle.spec.ts', 120],
  ['project-bundle-upload.spec.ts', 15],
  ['sidebar-name-wrapping.spec.ts', 30],
  ['streaming-nodes.spec.ts', 25],
  ['project-tree-activation.spec.ts', 230],
  ['port-connection-warnings.spec.ts', 25],
  ['cross-project-subgraph-loading.spec.ts', 180],
  ['subgraph-bundle-scope.spec.ts', 20],
  ['data-bus-order.spec.ts', 20],
  ['passthrough-port-labels.spec.ts', 30],
  ['bundle-local-execution-history.spec.ts', 15],
  ['hosted-subgraph-auth.spec.ts', 290],
  ['remote-bundle-observation.spec.ts', 280],
  ['ha-latest-replay.spec.ts', 25],
  // Complete hosted fixture, including scoped HA transport, runs and reconnect.
  ['managed-debugger-channels.spec.ts', 265],
  ['ha-browser-contracts.spec.ts', 25],
  ['recording-playback-history.spec.ts', 90],
  ['graph-deletion-references.spec.ts', 90],
  ['published-revision-history.spec.ts', 90],
  // Local 2026-11-25 case work: 94.4s in CI, 102.9s with observe artifacts.
  // Keep the higher rounded hint; refresh with hosted evidence, not a speed claim.
  ['project-settings-modal.spec.ts', 105],
  ['node-editor-ownership.spec.ts', 90],
  ['node-editor-lifecycle.spec.ts', 220],
  ['llm-temperature.spec.ts', 60],
  ['evaluation-history-paging.spec.ts', 45],
  ['evaluation-trial-orchestration.spec.ts', 15],
  ['partial-run-preload.spec.ts', 5],
  // Crossing/curved/bent wire routes through pan, zoom, resize and culling.
  ['wire-viewport-culling.spec.ts', 35],
  ['tunnel-cache-retention.spec.ts', 5],
  ['run-statistics-modal.spec.ts', 90],
  // Isolated recordings cases can share both browser workers.
  ['run-recordings-modal.spec.ts', 665],
  // Debug node discovery, output labels, icons and documentation links.
  ['graph-call-path-node.spec.ts', 15],
  // Real local PostgreSQL/MinIO + provider HTTP, including cancellation settlement.
  ['run-cost-statistics.spec.ts', 50],
];

export const editorCiSpecs = Object.freeze(weightedSpecs.map(([spec]) => spec));
const groups = Array.from({ length: 5 }, () => ({ specs: [], seconds: 0 }));
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
  const index = ['1/5', '2/5', '3/5', '4/5', '5/5'].indexOf(shard);
  if (index < 0) throw Error('RIVET_EDITOR_TEST_SHARD must be 1/5, 2/5, 3/5, 4/5 or 5/5.');
  return editorCiShards[index].specs;
}
