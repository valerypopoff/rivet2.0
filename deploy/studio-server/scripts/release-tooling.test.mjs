import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyActorSource } from '../images/qualification/verify-source.mjs';
import { selectReleaseInputs } from './lib/release-inputs.mjs';
import {
  isToolingOnlyPath,
  applicationInputDigest,
  assertToolingCompatibleSource,
  assertToolingRun,
  toolingPublicationIdentity,
  assertToolingIdentity,
  operationToolingSource,
} from './lib/release-tooling.mjs';

test('actor and execution lock use tooling source while application provenance remains unchanged', () => {
  const operation = {
    operationId: 'rivet-q-42-1',
    candidate: { source: { sha: 'a'.repeat(40) } },
    qualification: { tooling: { sourceSha: 'b'.repeat(40) } },
  };
  const setupOwner = { operationId: operation.operationId, sourceSha: 'b'.repeat(40) };
  const executionOwner = { operationId: operation.operationId, sourceSha: operationToolingSource(operation) };
  assert.deepEqual(executionOwner, setupOwner);
  assert.equal(operation.candidate.source.sha, 'a'.repeat(40));
  delete operation.qualification;
  assert.equal(operationToolingSource(operation), 'a'.repeat(40));
});

test('application reuse rejects runtime/container/chart/dependency changes including the embedded autoscaler closure', () => {
  for (const file of [
    'packages/core/src/index.ts',
    'yarn.lock',
    'package.json',
    '.github/workflows/studio-server-images.yml',
    '.github/actions/setup-yarn/action.yml',
    'deploy/studio-server/helm/values.yaml',
    'deploy/studio-server/images/proxy/nginx.conf',
    'deploy/studio-server/images/api/retire-backend.mjs',
    'deploy/studio-server/images/lib/prepare-autoscaler-runtime.mjs',
    ...[
      'execution-autoscaler-entry',
      'execution-autoscaler-kubernetes',
      'release-operation-journal',
      'release-operation-state',
      'read-concurrently',
    ].map((f) => `deploy/studio-server/scripts/lib/${f}.mjs`),
  ])
    assert.equal(isToolingOnlyPath(file), false, file);
  for (const file of [
    'deploy/studio-server/scripts/lib/ha-background-probe.mjs',
    'deploy/studio-server/scripts/qualification/provider-entry.mjs',
    'scripts/ci/verify-rollout-source.mjs',
    'scripts/checks/check-rollout-entrypoints.mjs',
    'developer-docs/studio-server/production-update-continuity.md',
    'packages/studio-server-api/src/tests/ha-background-admission.test.ts',
  ])
    assert.equal(isToolingOnlyPath(file), true, file);
});

test('real committed-tree comparison permits tooling-only changes and rejects renamed or modified application inputs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-tooling-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init');
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  git('add', '.');
  git('commit', '-m', 'app');
  const app = git('rev-parse', 'HEAD');
  await fs.mkdir(path.join(dir, 'deploy/studio-server/scripts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'deploy/studio-server/scripts/probe.mjs'), 'export const probe=1');
  await fs.mkdir(path.join(dir, 'scripts/checks'), { recursive: true });
  await fs.writeFile(path.join(dir, 'scripts/checks/check-rollout-entrypoints.mjs'), 'export const validate=1');
  git('add', '.');
  git('commit', '-m', 'tooling');
  const tools = git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => assertToolingCompatibleSource(dir, app, tools));
  const proof = assertToolingCompatibleSource(dir, app, tools);
  const applicationRun = {
    ...run(),
    id: 7,
    head_sha: app,
    path: '.github/workflows/studio-server-images.yml',
    event: 'push',
  };
  const selection = {
    root: dir,
    repository: 'owner/repo',
    sourceSha: tools,
    applicationRun,
    applicationRunId: '7',
    toolingRun: { ...run(), head_sha: tools },
    toolingRunId: '42',
  };
  const selected = selectReleaseInputs(selection);
  assert.equal(selected.build.sourceSha, app);
  assert.equal(selected.toolingRunId, '42');
  assert.deepEqual(selected.compatibility, proof);
  assert.throws(
    () => selectReleaseInputs({ ...selection, toolingRunId: '' }),
    'Do not infer application reuse without explicit tooling',
  );
  assert.throws(() =>
    selectReleaseInputs({ ...selection, applicationRun: { ...applicationRun, conclusion: 'failure' } }),
  );
  const actor = dir + '-actor';
  t.after(() => fs.rm(actor, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--depth=1', pathToFileURL(dir).href, actor], { stdio: 'pipe' });
  execFileSync('git', ['config', '--remove-section', 'remote.origin'], { cwd: actor, stdio: 'pipe' });
  await verifyActorSource(actor, tools);
  assert.throws(() => execFileSync('git', ['cat-file', '-e', app], { cwd: actor, stdio: 'pipe' }));
  assert.equal(
    applicationInputDigest(actor, tools),
    proof.applicationInputsDigest,
    'a one-commit actor verifies the application fingerprint without missing Git history or network access',
  );
  git('mv', 'package.json', 'deploy/studio-server/scripts/old-package.json');
  git('commit', '-m', 'rename');
  assert.throws(() => assertToolingCompatibleSource(dir, app, git('rev-parse', 'HEAD')), /Application inputs changed/);
  assert.throws(
    () =>
      selectReleaseInputs({
        ...selection,
        sourceSha: git('rev-parse', 'HEAD'),
        toolingRun: { ...run(), head_sha: git('rev-parse', 'HEAD') },
      }),
    /Application inputs changed/,
  );
});

const run = () => ({
  id: 42,
  run_attempt: 1,
  repository: { full_name: 'owner/repo' },
  head_repository: { full_name: 'owner/repo' },
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  path: '.github/workflows/studio-server-publish-qualification-images.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
});
test('tooling selection accepts only the exact successful trusted main publication', () => {
  const context = { repository: 'owner/repo', sourceSha: 'a'.repeat(40), runId: '42' };
  assert.doesNotThrow(() => assertToolingRun(run(), context));
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'develop' },
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { path: '.github/workflows/studio-server-images.yml' },
    { id: 43 },
    { head_repository: { full_name: 'foreign/repo' } },
  ])
    assert.throws(() => assertToolingRun({ ...run(), ...change }, context));
});
test('tooling identity binds the exact publication, source and run attempt', () => {
  const publication = {
    protocol: 1,
    sourceSha: 'a'.repeat(40),
    runId: '42',
    runAttempt: 1,
    actor: { image: 'fixture' },
  };
  const inputs = 'sha256:' + 'c'.repeat(64);
  const identity = toolingPublicationIdentity(publication, run(), inputs);
  assert.notEqual(
    toolingPublicationIdentity({ ...publication, actor: { image: 'changed' } }, run(), inputs).publicationDigest,
    identity.publicationDigest,
  );
  assert.throws(() => toolingPublicationIdentity({ ...publication, runAttempt: 2 }, run(), inputs));
  assert.throws(() => assertToolingIdentity({ ...identity, unbound: true }));
});
