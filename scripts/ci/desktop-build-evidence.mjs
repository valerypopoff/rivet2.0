import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// Read-only bridge between independent workflows. Never select by branch tip,
// a PR artifact, an arbitrary successful run, or a different source SHA.
export async function desktopBuildEvidence({
  mode,
  repository,
  sha,
  ref,
  token,
  apiUrl = 'https://api.github.com/',
  runId,
  runAttempt,
  maxWaitMs = 1_200_000,
  pollMs = 10_000,
  requestTimeoutMs = 10_000,
}) {
  assert.ok(['artifact', 'validated'].includes(mode), 'Unknown Build evidence mode.');
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(typeof sha === 'string' && sha.length === 40 && /^[a-f\d]+$/i.test(sha), 'Exact SHA required.');
  assert.ok(['refs/heads/develop', 'refs/heads/main'].includes(ref), 'Release branch required.');
  assert.ok(token, 'Read-only Actions access is required.');
  assert.ok(Number.isFinite(maxWaitMs) && maxWaitMs > 0 && maxWaitMs <= 1_200_000);
  assert.ok(Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0);
  const base = new URL(apiUrl.endsWith('/') ? apiUrl : apiUrl + '/');
  assert.ok(
    base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)),
  );
  const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (runId || runAttempt) assert.ok(positiveId(runId) && positiveId(runAttempt), 'Pinned Build run/attempt required.');
  const branch = ref.slice('refs/heads/'.length);
  const deadline = Date.now() + maxWaitMs;
  const get = async (endpoint) => {
    const response = await fetch(new URL(`repos/${repository}/${endpoint}`, base), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))),
    });
    if (!response.ok) throw Error(`Build evidence API returned HTTP ${response.status}; refusing release.`);
    return response.json();
  };
  const ownsRun = (run) =>
    run?.head_sha === sha &&
    run?.head_branch === branch &&
    run?.event === 'push' &&
    run?.path === '.github/workflows/build.yml' &&
    run?.repository?.full_name === repository &&
    run?.head_repository?.full_name === repository &&
    positiveId(run.repository.id) &&
    run.head_repository.id === run.repository.id &&
    positiveId(run.id) &&
    positiveId(run.run_attempt);
  let pinned;
  while (Date.now() < deadline) {
    if (!pinned) {
      if (runId) pinned = { id: Number(runId), attempt: Number(runAttempt) };
      else {
        const list = await get(
          `actions/workflows/build.yml/runs?event=push&branch=${encodeURIComponent(branch)}&head_sha=${sha}&per_page=100`,
        );
        assert.ok(Array.isArray(list.workflow_runs), 'Malformed Build run listing.');
        const run = list.workflow_runs.filter(ownsRun).sort((a, b) => b.id - a.id)[0];
        if (run) pinned = { id: Number(run.id), attempt: Number(run.run_attempt) };
      }
    }
    if (pinned) {
      const run = await get(`actions/runs/${pinned.id}`);
      assert.ok(
        ownsRun(run) && run.id === pinned.id && run.run_attempt === pinned.attempt,
        'Build identity/attempt changed; rerun the desktop workflow after Build settles.',
      );
      if (run.status === 'completed' && run.conclusion !== 'success')
        throw Error('The exact Build did not succeed; fix/rerun Build before releasing.');
      if (mode === 'validated' && run.status === 'completed' && run.conclusion === 'success')
        return { runId: pinned.id, runAttempt: pinned.attempt };
      if (mode === 'artifact') {
        const list = await get(`actions/runs/${pinned.id}/artifacts?per_page=100`);
        assert.ok(Array.isArray(list.artifacts), 'Malformed Build artifact listing.');
        const artifacts = list.artifacts.filter((artifact) => artifact.name === `rivet-desktop-web-${sha}`);
        assert.ok(artifacts.length <= 1, 'Ambiguous desktop artifact.');
        if (artifacts.length) {
          const artifact = artifacts[0];
          assert.ok(
            artifact.expired === false && positiveId(artifact.id) && artifact.size_in_bytes > 0,
            'Desktop artifact expired or invalid; rerun Build.',
          );
          const owner = artifact.workflow_run;
          assert.ok(
            owner?.id === pinned.id &&
              owner?.head_sha === sha &&
              owner?.head_branch === branch &&
              owner?.repository_id === run.repository.id &&
              owner?.head_repository_id === run.repository.id,
            'Desktop artifact ownership does not match the pinned Build.',
          );
          return { runId: pinned.id, runAttempt: pinned.attempt, artifactId: Number(artifact.id) };
        }
        if (run.status === 'completed') throw Error('The exact Build has no desktop artifact; rerun Build.');
      }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw Error('Timed out waiting for exact Build evidence; no release is authorized. Rerun after Build settles.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await desktopBuildEvidence({
    mode: process.argv[2],
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
    runId: process.env.BUILD_RUN_ID,
    runAttempt: process.env.BUILD_RUN_ATTEMPT,
  });
  const output =
    `run_id=${result.runId}\nrun_attempt=${result.runAttempt}\n` +
    (result.artifactId ? `artifact_id=${result.artifactId}\n` : '');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  console.log(`[desktop-build-evidence] Confirmed ${process.argv[2]} from Build ${result.runId}/${result.runAttempt}.`);
}
