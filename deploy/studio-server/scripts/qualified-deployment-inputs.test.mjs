import assert from 'node:assert/strict';
// test-style: fixture-read: Inspect only operation receipts generated in the test-owned temporary checkout.
import test from 'node:test';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  assertQualifiedPublicationRun,
  assertPublishedDeclarations,
  assertQualifiedDeploymentReceipt,
  recoveredOperationReference,
} from './lib/qualified-deployment-inputs.mjs';
import { qualificationConfigurationDigest } from './lib/release-qualification-policy.mjs';
import { prepareQualifiedDeployment } from './prepare-qualified-deployment.mjs';

const sha = 'a'.repeat(40),
  digest = 'sha256:' + 'b'.repeat(64);
const publication = () => ({
  id: 123,
  repository: { full_name: 'example/rivet' },
  head_repository: { full_name: 'example/rivet' },
  head_branch: 'main',
  head_sha: sha,
  path: '.github/workflows/studio-server-runtime-qualification.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 2,
});
test('publication admission binds repository, workflow, main, success and the exact attempt', () => {
  const options = { repository: 'example/rivet', runId: '123' };
  assert.equal(assertQualifiedPublicationRun(publication(), options), 'studio-server-release-manifest-123-2');
  for (const change of [
    { id: 124 },
    { repository: { full_name: 'other/rivet' } },
    { head_repository: { full_name: 'fork/rivet' } },
    { head_branch: 'develop' },
    { head_sha: 'main' },
    { path: '.github/workflows/studio-server-images.yml' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { run_attempt: 0 },
  ])
    assert.throws(() => assertQualifiedPublicationRun({ ...publication(), ...change }, options));
  assert.throws(() => assertQualifiedPublicationRun(publication(), { ...options, runId: '123\nextra=x' }));
});

function fixture() {
  const installed = {
    manifestDigest: digest,
    valuesDigest: digest,
    settingsDigest: digest,
    namespaceUid: 'namespace',
    clusterUid: 'cluster',
    controlPlaneMode: 'singleton',
    qualificationValues: { lifecycle: {}, postgres: {}, resources: {} },
    policy: { minReplicas: 2 },
  };
  const qualification = { configurationDigest: qualificationConfigurationDigest(installed, installed.policy) };
  const manifest = {
    source: { sha },
    images: { api: { repository: 'example/api', digest } },
    chart: { contentDigest: digest },
    lineage: { predecessor: { manifestDigest: digest } },
    evidence: { runtimeControl: { qualification }, runtimeAutoscaling: { policyDigest: 'policy' } },
  };
  const declarations = Object.fromEntries(
    [
      ['control', manifest.evidence.runtimeControl],
      ['autoscaling', manifest.evidence.runtimeAutoscaling],
    ].map(([kind, evidence]) => [
      kind,
      {
        provider: 'gke',
        scope: 'isolated-provider',
        outcome: 'passed',
        cleanupVerified: true,
        operationId: 'rivet-q-456-1',
        evidence: structuredClone(evidence),
        ...(kind === 'autoscaling' ? { policy: installed.policy } : {}),
      },
    ]),
  );
  const operation = {
    protocol: 1,
    operationId: 'rivet-q-456-1',
    inputHash: 'c'.repeat(64),
    driverBundleSha256: 'd'.repeat(64),
    predecessorManifestDigest: digest,
    installed,
    candidate: { sourceSha: sha, images: manifest.images, chartDigest: digest },
  };
  return { operation, manifest, declarations };
}

test('existing qualified receipt is reused without reconstructing or refreshing its original baseline', () => {
  const f = fixture();
  assert.equal(assertQualifiedDeploymentReceipt(f.operation, f), f.operation);
  const original = structuredClone(f.operation);
  assertPublishedDeclarations(f.manifest, f.declarations);
  assert.deepEqual(f.operation, original);
});

test('cleanup recovery cannot substitute a different certificate, operation or production baseline', () => {
  const mutations = [
    (f) => (f.declarations.control.cleanupVerified = false),
    (f) => (f.declarations.control.outcome = 'failed'),
    (f) => (f.declarations.autoscaling.operationId = 'rivet-q-789-1'),
    (f) => (f.declarations.control.evidence.extra = true),
    (f) => (f.operation.operationId = 'rivet-q-789-1'),
    (f) => (f.operation.sizingRequests = {}),
    (f) => (f.operation.candidate.sourceSha = 'e'.repeat(40)),
    (f) => (f.operation.candidate.images = {}),
    (f) => (f.operation.candidate.chartDigest = 'sha256:' + 'f'.repeat(64)),
    (f) => (f.operation.installed.manifestDigest = 'sha256:' + 'f'.repeat(64)),
    (f) => (f.operation.installed.settingsDigest = 'unknown'),
    (f) => (f.operation.installed.namespaceUid = ''),
    (f) => (f.operation.installed.controlPlaneMode = 'singleton-overlap'),
    (f) => (f.operation.installed.qualificationValues.resources.web = { requests: { cpu: '5' } }),
    (f) => (f.operation.tooling = { sourceSha: 'e'.repeat(40) }),
    (f) => (f.operation.installed.policy = { minReplicas: 1 }),
  ];
  for (const mutate of mutations) {
    const f = structuredClone(fixture());
    mutate(f);
    assert.throws(() => assertQualifiedDeploymentReceipt(f.operation, f));
  }
});

test('recovered receipt reads require a checksum, exact generation, fixed prefix and protected bucket', () => {
  const uri = 'gs://private-evidence/qualification-receipts/rivet-q-456-1/receipt.json#1234';
  assert.equal(recoveredOperationReference(uri, digest, 'private-evidence'), uri);
  for (const invalid of [
    uri.split('#')[0],
    uri + '\n',
    uri.replace('qualification-receipts/', 'installation/'),
    uri.replace('/receipt.json', '/../receipt.json'),
    uri.replace('#1234', '#0'),
    'https://example.test/receipt.json#1234',
  ])
    assert.throws(() => recoveredOperationReference(invalid, digest, 'private-evidence'));
  assert.throws(() => recoveredOperationReference(uri, digest, 'other-evidence'));
  assert.throws(() => recoveredOperationReference(uri, 'unchecked', 'private-evidence'));
});

test('dispatch rejects mixed modes and non-main use before invoking any external command', async () => {
  const env = {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'example/rivet',
    QUALIFIED_PUBLICATION_RUN_ID: '123',
    REUSE_DEPLOY_PRODUCTION: 'true',
  };
  for (const mutation of [
    { GITHUB_REF: 'refs/heads/develop' },
    { REUSE_DEPLOY_PRODUCTION: 'false' },
    { REUSE_BUILD_RUN_ID: '12' },
    { REUSE_TOOLING_RUN_ID: '12' },
    { REUSE_SIZING_REQUESTS: '{}' },
    { QUALIFIED_PUBLICATION_RUN_ID: '123;echo' },
    { RECOVERED_OPERATION_URI: 'gs://private-evidence/a.json#1' },
    { RECOVERED_OPERATION_SHA256: digest },
  ])
    await assert.rejects(prepareQualifiedDeployment('resolve', { ...env, ...mutation }));
});

test('a fresh controller creates its artifact parent and rejects failed publication metadata before downloading', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-qualified-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  await assert.rejects(
    prepareQualifiedDeployment(
      'resolve',
      {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'example/rivet',
        QUALIFIED_PUBLICATION_RUN_ID: '123',
        REUSE_DEPLOY_PRODUCTION: 'true',
      },
      {
        root,
        command: (bin, args) => {
          calls.push([bin, ...args]);
          return JSON.stringify({ ...publication(), conclusion: 'failure' });
        },
      },
    ),
  );
  assert.deepEqual(calls, [['gh', 'api', 'repos/example/rivet/actions/runs/123']]);
  assert.ok((await fs.stat(path.join(root, 'artifacts/qualified-deployment-inputs'))).isDirectory());
});

async function materializationFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-qualified-deployment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packet = path.join(root, 'artifacts/qualified-deployment-inputs');
  await fs.mkdir(packet, { recursive: true });
  const f = fixture();
  for (const [name, value] of Object.entries({
    'selection.json': { sourceSha: sha, digest },
    'promoted-release-manifest.json': f.manifest,
    'provider-declarations.json': f.declarations,
    'operation-public.json': f.operation,
  }))
    await fs.writeFile(path.join(packet, name), JSON.stringify(value));
  const environment = {
    GITHUB_REF: 'refs/heads/main',
    DEPLOYMENT_SOURCE_SHA: sha,
    QUALIFIED_MANIFEST_DIGEST: digest,
    RIVET_PRODUCTION_EVIDENCE_BUCKET: 'private-evidence',
  };
  return { root, ...f, environment, target: path.join(root, 'qualified/artifacts/automated-runtime-qualification') };
}

test('production-only preparation materializes original artifacts once without cloud commands or a new baseline', async (t) => {
  const f = await materializationFixture(t);
  const options = { root: f.root, command: () => assert.fail('Normal artifacts require no cloud read') };
  await prepareQualifiedDeployment('materialize', f.environment, options);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'operation-public.json'), 'utf8')), f.operation);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'qualified-manifest.json'), 'utf8')), f.manifest);
  await assert.rejects(prepareQualifiedDeployment('materialize', f.environment, options), { code: 'EEXIST' });
});

test('cleanup-recovery preparation reads the exact immutable private object and verifies bytes before materializing', async (t) => {
  const f = await materializationFixture(t),
    bytes = Buffer.from(JSON.stringify(f.operation));
  const uri = 'gs://private-evidence/qualification-receipts/rivet-q-456-1/receipt.json#1234';
  const env = {
    ...f.environment,
    RECOVERED_OPERATION_URI: uri,
    RECOVERED_OPERATION_SHA256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  };
  let reads = 0;
  const options = {
    root: f.root,
    command: (bin, args) => {
      reads++;
      assert.equal(bin, 'gcloud');
      assert.deepEqual(args.slice(0, 3), ['storage', 'cp', uri]);
      writeFileSync(args[3], bytes);
    },
  };
  await assert.rejects(
    prepareQualifiedDeployment('materialize', { ...env, RIVET_PRODUCTION_EVIDENCE_BUCKET: 'other-evidence' }, options),
  );
  assert.equal(reads, 0);
  await assert.rejects(
    prepareQualifiedDeployment('materialize', { ...env, RECOVERED_OPERATION_SHA256: digest }, options),
  );
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  await prepareQualifiedDeployment('materialize', env, options);
  assert.equal(reads, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'operation-public.json'), 'utf8')), f.operation);
});
