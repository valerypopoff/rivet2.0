import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qualificationOperation,
  executeRuntimeQualification,
  assertQualificationPreflight,
} from './lib/runtime-qualification-execution.mjs';
import {
  assertRuntimeQualificationBuild,
  assertRuntimeQualificationArtifacts,
} from './lib/runtime-qualification-publication.mjs';
import { qualificationDriver, verifyQualificationDriver } from './lib/runtime-qualification-driver.mjs';
import {
  inspectQualificationInstallation,
  assertQualificationInstallationMatches,
} from './lib/runtime-qualification-installation.mjs';
import { runManagedGateCommand as run } from './kubernetes-managed-release-gate.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { assertReleaseManifestMatchesCurrentChart } from './lib/studio-server-release-manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packet = path.resolve(
  root,
  process.env.RIVET_QUALIFICATION_PACKET ?? 'artifacts/automated-runtime-qualification',
);
assert.ok(
  path.relative(root, packet) &&
    !path.relative(root, packet).startsWith('..') &&
    !path.isAbsolute(path.relative(root, packet)),
);
const read = (file) => fs.readFile(file, 'utf8').then(JSON.parse);
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const emit = (key, value) => fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
const emitText = (key, value) => fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const inspect = async () =>
  inspectQualificationInstallation({
    context: process.env.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
    namespace: process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
    release: process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
    expectedNamespaceUid: process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE_UID,
    valuesText: await fs.readFile(process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE, 'utf8'),
    helm: resolveHelmBinOrThrow(root),
    kubectl: process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
    run,
  });

async function main(mode) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  await fs.mkdir(packet, { recursive: true, mode: 0o700 });
  if (mode === 'validate-run-id') {
    assert.equal(process.env.RIVET_AUTOMATED_QUALIFICATION_ENABLED, 'true');
    assert.match(process.env.BUILD_RUN_ID ?? '', /^[1-9][0-9]*$/);
    return;
  }
  if (mode === 'validate-build') {
    const build = assertRuntimeQualificationBuild(await read(path.join(packet, 'build-run.json')), {
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
      runId: process.env.BUILD_RUN_ID,
    });
    await write(path.join(packet, 'build-identity.json'), build);
    await emitText('run_attempt', String(build.runAttempt));
    return;
  }
  const artifacts = async () =>
    assertRuntimeQualificationArtifacts({
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
      build: await read(path.join(packet, 'build-identity.json')),
      candidate: await read(path.join(packet, 'candidate/candidate-release-manifest.json')),
      promoted: await read(path.join(packet, 'original/promoted-release-manifest.json')),
    });
  if (mode === 'validate-candidate') {
    const { candidate } = await artifacts();
    assertReleaseManifestMatchesCurrentChart(candidate, root, { requirePromoted: false });
    await emitText(
      'predecessor_reference',
      `ghcr.io/${process.env.GITHUB_REPOSITORY.toLowerCase()}-studio-server/release-manifest:manifest-${candidate.lineage.predecessor.manifestDigest.slice(7)}`,
    );
    return;
  }
  if (mode === 'inspect') {
    await write(path.join(packet, 'installed.json'), await inspect());
    return;
  }
  if (mode === 'preflight') {
    const operation = await read(path.join(packet, 'operation-public.json'));
    assert.equal(operation.installed.manifestDigest, operation.predecessorManifestDigest);
    assertQualificationInstallationMatches(await inspect(), operation.installed);
    const file = path.join(packet, 'qualified-manifest.json');
    const qualified = await read(file);
    const digest = process.env.QUALIFIED_MANIFEST_DIGEST;
    const { getStudioServerReleaseManifestDigest } = await import('./lib/studio-server-release-manifest.mjs');
    assert.equal(getStudioServerReleaseManifestDigest(qualified, { requirePromoted: true }), digest);
    assert.equal(qualified.source.sha, operation.candidate.sourceSha);
    assert.deepEqual(qualified.images, operation.candidate.images);
    assert.equal(qualified.chart.contentDigest, operation.candidate.chartDigest);
    assert.equal(qualified.lineage.predecessor.manifestDigest, operation.predecessorManifestDigest);
    const artifacts = path.join(packet, 'private-preflight');
    await run(
      process.execPath,
      [
        path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
        '--preflight-only',
        '--manifest',
        file,
        '--context',
        process.env.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
        '--namespace',
        process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
        '--release',
        process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
        '--confirm',
        process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
        '--values',
        process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE,
        '--deployment-policy',
        process.env.RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE,
        '--artifacts',
        artifacts,
      ],
      { capture: true },
    );
    assertQualificationInstallationMatches(await inspect(), operation.installed);
    const result = assertQualificationPreflight(
      await read(path.join(artifacts, 'deployment-preflight.json')),
      operation,
      digest,
    );
    await write(path.join(packet, 'deployment-readiness.json'), result);
    return;
  }
  assert.equal(mode, 'execute');
  const { candidate } = await artifacts();
  const previous = await read(path.join(packet, 'predecessor.json'));
  assert.equal(candidate.source.sha, process.env.GITHUB_SHA);
  assert.equal(candidate.source.repository, process.env.GITHUB_REPOSITORY);
  assertReleaseManifestMatchesCurrentChart(candidate, root, { requirePromoted: false });
  const installed = await read(path.join(packet, 'installed.json'));
  const bundle = process.env.RIVET_QUALIFICATION_DRIVER_DIRECTORY;
  const bundleDigest = process.env.RIVET_QUALIFICATION_DRIVER_SHA256;
  assert.ok(
    Number(process.env.RIVET_QUALIFICATION_MAX_SECONDS) <= 7200,
    'Actions qualification must leave an hour for settlement before the job limit',
  );
  assert.ok(process.env.RIVET_QUALIFICATION_STAGING_KUBECONFIG, 'An isolated staging credential context is required');
  await verifyQualificationDriver(bundle, bundleDigest); // Before provisioning or creating an operation.
  const operation = qualificationOperation({
    candidate,
    previous,
    installed,
    policy: installed.policy,
    operationId: `rivet-q-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    approval: {
      enabled: process.env.RIVET_AUTOMATED_QUALIFICATION_ENABLED === 'true',
      projectId: process.env.RIVET_QUALIFICATION_PROJECT_ID,
      projectNumber: process.env.RIVET_QUALIFICATION_PROJECT_NUMBER,
      maxUsd: Number(process.env.RIVET_QUALIFICATION_MAX_USD),
      maxSeconds: Number(process.env.RIVET_QUALIFICATION_MAX_SECONDS),
      driverBundleSha256: bundleDigest,
      staging: {
        mode: 'reusable-cluster',
        clusterUid: process.env.RIVET_QUALIFICATION_CLUSTER_UID,
        clusterServer: process.env.RIVET_QUALIFICATION_CLUSTER_SERVER,
        gatewayUid: process.env.RIVET_QUALIFICATION_GATEWAY_UID,
      },
    },
  });
  const store = process.env.RIVET_QUALIFICATION_PRIVATE_STORE;
  assert.ok(store && path.isAbsolute(store));
  const storeRelative = path.relative(root, store);
  assert.ok(
    storeRelative.startsWith(`..${path.sep}`) || storeRelative === '..' || path.isAbsolute(storeRelative),
    'Durable private inventory must be outside the checkout',
  );
  await fs.mkdir(store, { recursive: true, mode: 0o700 });
  const lock = await fs.open(path.join(store, 'active.lock'), 'wx', 0o600);
  let succeeded = false;
  try {
    await lock.writeFile(
      JSON.stringify({
        operationId: operation.operationId,
        bundleDigest,
        pid: process.pid,
        startedAt: operation.startedAt,
      }),
    );
    const privateDirectory = path.join(store, operation.operationId);
    await fs.mkdir(privateDirectory, { mode: 0o700 }); // Existing operation is never restarted/replayed.
    await write(path.join(privateDirectory, 'operation.json'), { operation, bundleDigest });
    let sequence = 0;
    const signal = new AbortController();
    const stop = () => signal.abort(Error('Qualification admission stopped'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const result = await executeRuntimeQualification(
        operation,
        qualificationDriver(bundle, bundleDigest, {
          cwd: root,
          privateDirectory,
          timeoutMs: 7_200_000,
          env: { ...process.env, RIVET_QUALIFICATION_SOURCE_ROOT: root },
        }),
        (state) => write(path.join(privateDirectory, `${String(sequence++).padStart(3, '0')}-state.json`), state),
        { signal: signal.signal },
      );
      await write(path.join(packet, 'qualification-result.json'), result);
      // No project data, credentials, raw Helm settings, provider logs or prompts.
      await write(path.join(packet, 'operation-public.json'), {
        protocol: 1,
        operationId: operation.operationId,
        inputHash: operation.inputHash,
        predecessorManifestDigest: operation.predecessorManifestDigest,
        installed: operation.installed,
        driverBundleSha256: bundleDigest,
        candidate: {
          sourceSha: candidate.source.sha,
          images: candidate.images,
          chartDigest: candidate.chart.contentDigest,
        },
      });
      await emit('control', result.control);
      await emit('autoscaling', result.autoscaling);
      succeeded = true;
      console.log(
        `Qualified ${operation.candidate.source.sha}; cleanup verified. Production deployment was not started.`,
      );
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  } finally {
    await lock.close();
    // A failed/uncertain operation keeps the installation lock for exact recovery.
    // A stale PID is never authority to remove it or admit a new paid test.
    if (succeeded) await fs.unlink(path.join(store, 'active.lock'));
  }
}
main(process.argv[2]).catch(() => {
  console.error(
    '[runtime-qualification-execution] Phase failed. Inspect private operation inventory; no uncertain write was retried and no receipt contents were logged.',
  );
  process.exitCode = 1;
});
