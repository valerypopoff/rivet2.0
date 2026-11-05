import { assertRuntimeQualificationBuild } from './runtime-qualification-publication.mjs';
import { assertToolingRun, assertToolingCompatibleSource } from './release-tooling.mjs';

/** Same selection contract at release admission and certificate publication. */
export function selectReleaseInputs({
  root,
  repository,
  sourceSha,
  applicationRun,
  applicationRunId,
  toolingRun,
  toolingRunId,
}) {
  const applicationSha = toolingRunId ? applicationRun.head_sha : sourceSha;
  const build = assertRuntimeQualificationBuild(applicationRun, {
    repository,
    sourceSha: applicationSha,
    runId: applicationRunId,
  });
  let compatibility;
  if (toolingRunId) {
    assertToolingRun(toolingRun, { repository, sourceSha, runId: toolingRunId });
    compatibility = assertToolingCompatibleSource(root, applicationSha, sourceSha);
  }
  return {
    build: { ...build, ...(toolingRunId ? { sourceSha: applicationSha } : {}) },
    toolingRunId: toolingRunId || applicationRunId,
    toolingRunAttempt: toolingRunId ? toolingRun.run_attempt : build.runAttempt,
    compatibility,
  };
}
