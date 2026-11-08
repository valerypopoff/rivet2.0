import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The API image packages this closed autoscaler closure. These files are runtime
// inputs even though they live alongside the deployment tools.
export function isToolingOnlyPath(file) {
  if (file.startsWith('deploy/studio-server/scripts/'))
    return !/^deploy\/studio-server\/scripts\/lib\/(?:execution-autoscaler[^/]*|release-operation-(?:journal|state)|read-concurrently|kubernetes-response-error)\.mjs$/.test(
      file,
    );
  return (
    [
      'developer-docs/',
      'docs/',
      'scripts/ci/',
      'deploy/studio-server/images/qualification/',
      'packages/studio-server-api/src/tests/',
    ].some((p) => file.startsWith(p)) ||
    [
      'README.md',
      'AGENTS.md',
      '.github/workflows/studio-server-qualify-release.yml',
      '.github/workflows/studio-server-runtime-qualification.yml',
      '.github/workflows/studio-server-publish-qualification-images.yml',
      '.github/workflows/studio-server-source-contracts.yml',
      '.github/workflows/studio-server-verify.yml',
      'scripts/checks/check-ci-workflows.mjs',
      'scripts/checks/check-rollout-entrypoints.mjs',
      'scripts/build-and-publish-qualification-images.mjs',
      'scripts/qualification-image-publication.mjs',
    ].includes(file)
  );
}

/** Compare committed trees, not timestamps or a claim that images are unchanged.
 * Both commits are independently bound to successful main workflow runs. Only
 * the two trees are needed, so shallow fetches need not download Git history. */
export function assertToolingCompatibleSource(root, applicationSha, toolingSha) {
  for (const sha of [applicationSha, toolingSha]) assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  const applicationInputsDigest = applicationInputDigest(root, applicationSha);
  const files = execFileSync(
    'git',
    [
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      applicationSha,
      toolingSha,
      '--',
    ],
    { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
  const changed = files.filter((file) => !isToolingOnlyPath(file));
  if (changed.length)
    throw Object.assign(
      Error(`Application inputs changed; build application images first: ${changed.slice(0, 8).join(', ')}`),
      { code: 'RIVET_APPLICATION_REBUILD_REQUIRED' },
    );
  assert.equal(applicationInputDigest(root, toolingSha), applicationInputsDigest);
  return { applicationSha, toolingSha, applicationInputsDigest };
}

export function applicationInputDigest(root, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  const tree = execFileSync(
    'git',
    ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'ls-tree', '-rz', '--full-tree', sha],
    { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 },
  );
  const inputs = tree
    .split('\0')
    .filter(Boolean)
    .filter((entry) => {
      assert.match(entry, /^\d{6} (?:blob|commit) [a-f0-9]{40}\t/);
      return !isToolingOnlyPath(entry.slice(entry.indexOf('\t') + 1));
    })
    .sort();
  assert.ok(inputs.length, 'Application input tree is empty');
  return 'sha256:' + createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function assertToolingIdentity(value) {
  assert.deepEqual(
    Object.keys(value ?? {}).sort(),
    ['sourceSha', 'runId', 'runAttempt', 'publicationDigest', 'applicationInputsDigest'].sort(),
  );
  assert.match(value.sourceSha ?? '', /^[a-f0-9]{40}$/);
  assert.match(value.runId ?? '', /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0);
  assert.match(value.publicationDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(value.applicationInputsDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  return { ...value };
}

export function assertToolingRun(run, { repository, sourceSha, runId }) {
  assert.match(String(runId), /^[1-9][0-9]*$/);
  assert.equal(String(run.id), String(runId));
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, sourceSha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.path, '.github/workflows/studio-server-publish-qualification-images.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  return run;
}

const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((key) => [key, canonical(x[key])]),
        )
      : x;
export function toolingPublicationIdentity(publication, run, applicationInputsDigest) {
  assert.equal(publication.protocol, 1);
  assert.equal(publication.sourceSha, run.head_sha);
  assert.equal(publication.runId, String(run.id));
  assert.equal(publication.runAttempt, run.run_attempt);
  return assertToolingIdentity({
    sourceSha: publication.sourceSha,
    runId: publication.runId,
    applicationInputsDigest,
    runAttempt: publication.runAttempt,
    publicationDigest:
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify(canonical(publication)))
        .digest('hex'),
  });
}

export function releaseToolingSource(manifest) {
  const tooling = manifest.evidence.runtimeControl?.qualification?.tooling;
  return tooling ? assertToolingIdentity(tooling).sourceSha : manifest.source.sha;
}

export function operationToolingSource(operation) {
  const source = operation.qualification?.tooling?.sourceSha ?? operation.candidate.source.sha;
  assert.match(source ?? '', /^[a-f0-9]{40}$/);
  return source;
}
