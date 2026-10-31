import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { overlapAdoptionValues } from './lib/overlap-adoption.mjs';
import { pullReleaseManifestArtifact, PRODUCTION_RELEASE_MANIFEST_REFERENCE } from './release-manifest-oci.mjs';
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
import { continuityTimeoutMs } from './lib/request-continuity.mjs';
import { prepareQualificationReadinessPolicy } from './lib/runtime-qualification-readiness.mjs';
import { qualificationSafetyDigest } from './lib/release-qualification-policy.mjs';
import { deployQualifiedRelease } from './lib/deploy-qualified-release.mjs';
import { privateCloudEvidence } from './lib/private-cloud-evidence.mjs';
import { coordinatorKubernetes, prepareStagingActor } from './lib/reusable-staging-coordinator.mjs';

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
    ...(process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_SHA256
      ? { valuesDigest: process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_SHA256 }
      : { valuesText: await fs.readFile(process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE, 'utf8') }),
    helm: resolveHelmBinOrThrow(root),
    kubectl: process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
    run: (bin, args, options) =>
      run(bin, args, {
        ...options,
        env: {
          ...process.env,
          KUBECONFIG: process.env.RIVET_QUALIFICATION_PRODUCTION_KUBECONFIG ?? process.env.KUBECONFIG,
        },
      }),
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
  if (mode === 'deploy') {
    const result = await deployQualifiedRelease({
      root,
      packet,
      operation: await read(path.join(packet, 'operation-public.json')),
      manifest: await read(path.join(packet, 'qualified-manifest.json')),
      digest: process.env.QUALIFIED_MANIFEST_DIGEST,
      sourceSha: process.env.GITHUB_SHA,
      valuesFile: process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE,
      policyFile: process.env.RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE,
      privateStore: process.env.RIVET_PRODUCTION_PRIVATE_STORE,
      evidenceBucket: process.env.RIVET_PRODUCTION_EVIDENCE_BUCKET,
      identity: {
        context: process.env.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
        namespace: process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
        release: process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
      },
      run,
    });
    await write(path.join(packet, 'deployment-summary.json'), result);
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
    const adoptionStage =
      qualified.evidence.runtimeControl?.protocol === 3 && operation.installed.controlPlaneMode === 'singleton'
        ? operation.installed.qualificationValues.postgres.poolMaxPerApiPod ===
          qualified.evidence.runtimeControl.developerOverlap.profile.poolMaxPerApiPod
          ? 'ownership'
          : 'sizing'
        : undefined;
    let preflightValues = process.env.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE;
    let preflightValuesDigest = operation.installed.valuesDigest;
    const adoptionArgs = [];
    if (adoptionStage) {
      const predecessor = await pullReleaseManifestArtifact(
        PRODUCTION_RELEASE_MANIFEST_REFERENCE.replace(
          /:production$/,
          `:manifest-${operation.predecessorManifestDigest.slice(7)}`,
        ),
        path.join(packet, 'predecessor.json'),
      );
      assert.equal(
        getStudioServerReleaseManifestDigest(predecessor.manifest, { requirePromoted: true }),
        operation.predecessorManifestDigest,
      );
      await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
      const values = overlapAdoptionValues(
        parse(await fs.readFile(preflightValues, 'utf8')),
        qualified.evidence.runtimeControl.developerOverlap.profile,
        adoptionStage,
      );
      preflightValues = path.join(artifacts, 'adoption-sizing-values.json');
      const bytes = JSON.stringify(values, null, 2) + '\n';
      await fs.writeFile(preflightValues, bytes, { flag: 'wx', mode: 0o600 });
      preflightValuesDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      adoptionArgs.push('--overlap-adoption-certificate', file, '--overlap-adoption-stage', adoptionStage);
      if (adoptionStage === 'ownership') adoptionArgs.push('--ha-control-plane-transition');
    }
    const policyFile = await prepareQualificationReadinessPolicy({
      policyFile: process.env.RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE,
      root,
      packet,
      identity: {
        context: process.env.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
        namespace: process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
        release: process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
      },
    });
    await run(
      process.execPath,
      [
        path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
        '--preflight-only',
        ...(qualified.evidence.runtimeControl?.requestContinuity
          ? ['--timeout', `${continuityTimeoutMs(qualified.evidence.runtimeControl.requestContinuity.profile) / 1000}s`]
          : []),
        '--manifest',
        adoptionStage ? path.join(packet, 'predecessor.json') : file,
        ...adoptionArgs,
        '--context',
        process.env.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
        '--namespace',
        process.env.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
        '--release',
        process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
        '--confirm',
        process.env.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
        '--values',
        preflightValues,
        '--deployment-policy',
        policyFile,
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
      { adoptionStage, valuesDigest: preflightValuesDigest },
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
  assert.ok(
    ['', 'reusable-cluster', 'temporary'].includes(process.env.RIVET_QUALIFICATION_ENVIRONMENT_MODE ?? ''),
    'Unknown staging environment mode',
  );
  if (process.env.RIVET_QUALIFICATION_ENVIRONMENT_MODE === 'temporary') {
    const { executeTemporaryQualification } = await import('./temporary-staging.mjs');
    await executeTemporaryQualification({
      packet,
      inputs: {
        candidate,
        previous,
        installed,
        policy: installed.policy,
        ...(process.env.RIVET_QUALIFICATION_CONTINUITY_PROFILE
          ? { requestContinuityProfile: await read(process.env.RIVET_QUALIFICATION_CONTINUITY_PROFILE) }
          : {}),
        ...(process.env.RIVET_QUALIFICATION_OVERLAP_PROFILE
          ? { developerOverlapProfile: await read(process.env.RIVET_QUALIFICATION_OVERLAP_PROFILE) }
          : {}),
      },
      refreshInstalled: inspect,
    });
    return;
  }
  const bundle = process.env.RIVET_QUALIFICATION_DRIVER_DIRECTORY;
  const bundleDigest = process.env.RIVET_QUALIFICATION_DRIVER_SHA256;
  assert.ok(
    Number(process.env.RIVET_QUALIFICATION_MAX_SECONDS) <= 7200,
    'Actions qualification must leave an hour for settlement before the job limit',
  );
  assert.ok(process.env.RIVET_QUALIFICATION_STAGING_KUBECONFIG, 'An isolated staging credential context is required');
  await verifyQualificationDriver(bundle, bundleDigest); // Before provisioning or creating an operation.
  const driverManifest = await read(path.join(bundle, 'driver.json'));
  const settings = driverManifest.files['settings.json'] ? await read(path.join(bundle, 'settings.json')) : {};
  const operation = qualificationOperation({
    candidate,
    previous,
    installed,
    policy: installed.policy,
    operationId: `rivet-q-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    approval: {
      ...(driverManifest.files['settings.json']
        ? { safetyDigest: await qualificationSafetyDigest(root, candidate.source.sha) }
        : {}),
      developerOverlapProfile: settings.developerOverlapProfile,
      requestContinuityProfile: settings.requestContinuityProfile,
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
    let lastState, actor;
    const cloud = process.env.RIVET_QUALIFICATION_EVIDENCE_BUCKET
      ? privateCloudEvidence({
          bucket: process.env.RIVET_QUALIFICATION_EVIDENCE_BUCKET,
          prefix: 'qualification',
        })
      : undefined;
    const owner = Buffer.from(JSON.stringify({ operationId: operation.operationId, sourceSha: candidate.source.sha }));
    const cloudGeneration = process.env.RIVET_QUALIFICATION_LOCK_GENERATION;
    if (cloud) await cloud.assertOwner(cloudGeneration, owner);
    const journal = cloud
      ? privateCloudEvidence({
          bucket: process.env.RIVET_QUALIFICATION_EVIDENCE_BUCKET,
          prefix: `qualification/${operation.operationId}`,
        })
      : undefined;
    const persist = async () => {
      await journal?.saveDirectory(privateDirectory);
    };
    const signal = new AbortController();
    const stop = () => signal.abort(Error('Qualification admission stopped'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      if (process.env.RIVET_QUALIFICATION_COORDINATOR_MODE === 'external') {
        actor = await prepareStagingActor(operation, {
          api: coordinatorKubernetes(settings),
          settings,
          bundle,
          digest: bundleDigest,
          privateDirectory,
          persist,
        });
      }
      const result = await executeRuntimeQualification(
        operation,
        actor?.driver ??
          qualificationDriver(bundle, bundleDigest, {
            cwd: root,
            privateDirectory,
            timeoutMs: 7_200_000,
            env: { ...process.env, RIVET_QUALIFICATION_SOURCE_ROOT: root },
          }),
        async (state) => {
          lastState = state;
          await write(path.join(privateDirectory, `${String(sequence++).padStart(3, '0')}-state.json`), state);
          await persist();
        },
        { signal: signal.signal },
      );
      await actor?.close({ cleanupVerified: lastState?.cleanupVerified });
      actor = undefined;
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
      await persist();
      if (cloud) await cloud.release(cloudGeneration);
      succeeded = true;
      console.log(
        `Qualified ${operation.candidate.source.sha}; cleanup verified. Production deployment was not started.`,
      );
    } finally {
      await actor?.close({ cleanupVerified: lastState?.cleanupVerified });
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
    '[runtime-qualification-execution] Phase failed. Inspect private qualification/deployment receipts; no uncertain write was retried and no receipt contents were logged.',
  );
  process.exitCode = 1;
});
