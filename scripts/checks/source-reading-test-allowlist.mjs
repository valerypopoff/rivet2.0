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
  'packages/studio-server-api/src/tests/kubernetes-managed-release-gate.test.ts',
  'packages/studio-server-web/playwright-observe/rivet-web-app.spec.ts',
  'packages/studio-server-web/tests/vite-aliases.test.ts',
]);
