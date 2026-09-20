// Shrinking migration queue. Remove an entry when its test stops reading production source.
// New source-reading tests are rejected; add behavior/pure/static-owner coverage instead.
export const sourceReadingTestAllowlist = new Set([
  'packages/app-executor/bin/executor.test.mts',
  // Static bootstrap contract: importing the entrypoint would start the
  // executor's socket server, so this narrow source guard is intentional.
  'packages/app-executor/bin/executorHost.test.mts',
  'packages/cli/test/cli.test.ts',
  'packages/core/test/model/nodes/LLMChatV2Node.test.ts',
  // Static release-deployment contract: the script intentionally guards
  // source checkout and Helm argument ordering before it touches a cluster.
  'deploy/studio-server/scripts/studio-server-release-manifest.test.mjs',
  // Imported Studio Server migration baseline. Keep shrinking these entries as
  // their static integration contracts gain observable owner seams.
  'packages/studio-server-api/src/tests/app-settings.test.ts',
  'packages/studio-server-api/src/tests/filesystem-execution-cache.test.ts',
  'packages/studio-server-api/src/tests/filesystem-execution-source.test.ts',
  // Crash-recovery behavior: reads only the generated project/dataset fixture
  // to prove that canonical artifacts expose one complete generation.
  'packages/studio-server-api/src/tests/filesystem-project-transactions.test.ts',
  'packages/studio-server-api/src/tests/fixture-safety.test.ts',
  // Scheduler behavior: loads the canonical serialized project fixture, not
  // production source, to create an executable evaluation run shell.
  'packages/studio-server-api/src/tests/hosted-evaluation-coordinator.test.ts',
  'packages/studio-server-api/src/tests/hosted-project-title.test.ts',
  'packages/studio-server-api/src/tests/kubernetes-managed-release-gate.test.ts',
  // Capacity-review behavior: reads only its own generated review artifact.
  'packages/studio-server-api/src/tests/kubernetes-published-capacity-review.test.ts',
  'packages/studio-server-api/src/tests/settings-repository.test.ts',
  // Reads only its own temporary malformed settings fixture to prove that
  // fail-closed policy recovery preserves the original bytes until repair.
  'packages/studio-server-api/src/tests/trusted-clients.test.ts',
  'packages/studio-server-api/src/tests/workflow-execution-filesystem.test.ts',
  'packages/studio-server-api/src/tests/workflow-filesystem-tree.test.ts',
  'packages/studio-server-api/src/tests/workflow-publication-filesystem.test.ts',
  'packages/studio-server-api/src/tests/workflow-published-history-filesystem.test.ts',
  'packages/studio-server-api/src/tests/workflow-recordings-http.test.ts',
  'packages/studio-server-web/playwright-observe/rivet-web-app.spec.ts',
  'packages/studio-server-web/tests/hosted-fonts.test.ts',
  'packages/studio-server-web/tests/llm-profile-health-settings.test.ts',
  'packages/studio-server-web/tests/modal-theme-contract.test.ts',
  'packages/studio-server-web/tests/vite-aliases.test.ts',
]);
