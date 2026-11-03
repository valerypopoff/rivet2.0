import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments, stringify } from 'yaml';
import { packageReusableStaging } from './package-reusable-staging.mjs';
import { privateCloudEvidence } from './lib/private-cloud-evidence.mjs';
import { assertActionsQualificationWindow } from './lib/runtime-qualification-execution.mjs';
import { waitForStagingJanitor, observeStagingJanitor } from './lib/staging-janitor-health.mjs';
import { stagingOwner } from './lib/reusable-staging-state.mjs';
import { assertStagingSetupAccess } from './lib/staging-coordinator-access.mjs';
import {
  setupKubernetes,
  assertClosedSetupInventory,
  saveStagingSetup,
  closeStagingSetup,
  assertSetupJanitorUpdate,
} from './lib/hosted-staging-setup.mjs';
import { deploymentFailureDetails } from './lib/deployment-diagnostics.mjs';
import { sizingInput } from './lib/resource-sizing.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runCommand = (bin, args, env = process.env) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024, // Match the existing Kubernetes inventory transport bound.
    env,
  }).trim();
function assertVariables(variables) {
  for (const value of Object.values(variables))
    assert.ok(typeof value === 'string' && value && !/[\r\n\0]/.test(value));
}
function assertClusterIdentity(identity) {
  for (const name of ['projectId', 'clusterName', 'region']) assert.match(identity[name], /^[a-z][a-z0-9-]+$/);
}

function failureCode(error) {
  if (
    String(error.stdout ?? '').trim() === 'no' ||
    /forbidden|permission.?denied|denied read/i.test(String(error.stderr ?? error.message))
  )
    return 'permission_denied';
  if (error.code === 'ENOENT') return 'command_unavailable';
  if (error.code === 'ETIMEDOUT') return 'command_timeout';
  return 'setup_failed';
}

export async function prepareHostedRelease(mode, options = {}) {
  const phase = { name: 'configuration' };
  try {
    return await prepareHostedReleaseWork(mode, { ...options, phase });
  } catch (error) {
    if (phase.receipt) {
      phase.receipt.writerClosed = true;
      try {
        await saveStagingSetup(phase.directory, phase.receipt, phase.authenticated ? phase.cloud : undefined);
      } catch (failure) {
        error = new AggregateError([error, failure], 'Setup and writer receipt persistence failed', { cause: error });
      }
    }
    throw await preparationFailure(error, phase);
  }
}

async function preparationFailure(error, phase) {
  const failures = [error];
  const primary = error instanceof AggregateError ? error.cause ?? error.errors[0] : error;
  const detail = { phase: phase.name, code: failureCode(primary), ...deploymentFailureDetails(error) };
  const filename = phase.name === 'setup-closure' ? 'setup-closure-failure.json' : 'preparation-failure.json';
  if (phase.directory) {
    try {
      await fs.writeFile(path.join(phase.directory, filename), JSON.stringify(detail), { mode: 0o600 });
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (phase.authenticated && phase.cloud) {
    try {
      await phase.cloud.put(`setup/${phase.operationId}/${filename}`, Buffer.from(JSON.stringify(detail)));
    } catch (failure) {
      failures.push(failure);
    }
  }
  const wrapped = new Error(
    `Hosted release preparation failed at ${phase.name} (${detail.code}); inspect private setup evidence.`,
    { cause: failures.length === 1 ? error : new AggregateError(failures, 'Setup and diagnostic persistence failed') },
  );
  // Only this fixed message is public. Native command errors remain in the private cause/receipt.
  wrapped.name = 'HostedPreparationError';
  return wrapped;
}

async function prepareHostedReleaseWork(
  mode,
  {
    environment = process.env,
    run = runCommand,
    cloudEvidence = privateCloudEvidence,
    publicationFile = path.join(root, 'artifacts/qualification-image-publication/publication.json'),
    phase,
  } = {},
) {
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.ok(['staging', 'production'].includes(mode));
  const sizing = sizingInput(environment);
  assert.ok(!sizing || mode === 'staging', 'Sizing cannot prepare production access');
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  if (mode === 'staging') assertActionsQualificationWindow(Number(environment.RIVET_QUALIFICATION_MAX_SECONDS));
  const rawConfiguration = environment.RIVET_DEPLOYMENT_CONFIGURATION;
  delete environment.RIVET_DEPLOYMENT_CONFIGURATION;
  const directory = path.join(environment.RUNNER_TEMP, `rivet-${mode}`);
  await fs.mkdir(directory, { mode: 0o700 });
  phase.directory = directory;
  assert.ok(rawConfiguration, 'Protected deployment configuration secret is missing');
  const configuration = JSON.parse(rawConfiguration);
  assert.equal(configuration.protocol, 1);
  const variables = {};
  const kubeconfig = path.join(directory, 'kubeconfig');
  const credentialEnvironment = { ...environment, KUBECONFIG: kubeconfig, USE_GKE_GCLOUD_AUTH_PLUGIN: 'True' };
  const credentials = (identity) => {
    run(
      'gcloud',
      [
        'container',
        'clusters',
        'get-credentials',
        identity.clusterName,
        '--project',
        identity.projectId,
        '--region',
        identity.region,
        ...(identity.dnsEndpoint ? ['--dns-endpoint'] : []),
      ],
      credentialEnvironment,
    );
  };
  const p = configuration.production;
  assertClusterIdentity(p);
  for (const [key, value] of Object.entries({
    CONTEXT: p.context,
    NAMESPACE: p.namespace,
    RELEASE: p.release,
    NAMESPACE_UID: p.namespaceUid,
  }))
    variables[`RIVET_QUALIFICATION_PRODUCTION_${key}`] = value;
  variables.KUBECONFIG = kubeconfig;
  variables.RIVET_QUALIFICATION_PRODUCTION_KUBECONFIG = kubeconfig;
  assertVariables(variables);
  if (mode === 'staging') {
    phase.name = 'package';
    assert.match(environment.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
    const s = configuration.staging;
    assertClusterIdentity(s);
    assert.match(p.valuesDigest, /^sha256:[a-f0-9]{64}$/);
    variables.RIVET_QUALIFICATION_PRODUCTION_VALUES_SHA256 = p.valuesDigest;
    const publication = JSON.parse(await fs.readFile(publicationFile, 'utf8'));
    assert.equal(publication.sourceSha, environment.GITHUB_SHA);
    for (const [name, image] of [
      ['qualification', publication.actor.image],
      ['qualification-minio', publication.minio.image],
      ['qualification-janitor', publication.janitor.image],
    ]) {
      const prefix = `ghcr.io/${environment.GITHUB_REPOSITORY.toLowerCase()}-studio-server/${name}@`;
      assert.ok(image.startsWith(prefix));
      assert.match(image.slice(prefix.length), /^sha256:[a-f0-9]{64}$/);
    }
    const settings = { ...s, actorImage: publication.actor.image, objectStorageImage: publication.minio.image };
    if (sizing) {
      settings.sizingRequests = sizing;
      delete settings.requestContinuityProfile;
      delete settings.developerOverlapProfile;
    }
    const cloud = cloudEvidence({ bucket: configuration.evidenceBucket, prefix: 'qualification' });
    phase.cloud = cloud;
    const operationId = `rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`;
    phase.operationId = operationId;
    const owner = Buffer.from(
      JSON.stringify({
        operationId,
        sourceSha: environment.GITHUB_SHA,
      }),
    );
    const output = path.join(directory, 'package');
    const packaged = await packageReusableStaging({
      settings,
      output,
      janitorImage: publication.janitor.image,
      googleServiceAccount: configuration.janitorServiceAccount,
    });
    // Initial SA/RBAC/health installation is administrator-owned. CI can update
    // code and the janitor workload, but cannot install or expand those grants.
    const objects = parseAllDocuments(await fs.readFile(path.join(output, 'janitor.yaml'), 'utf8')).map((d) => {
      assert.equal(d.errors.length, 0);
      return d.toJS();
    });
    const update = objects.filter((o) => o.kind === 'Deployment' || (o.kind === 'ConfigMap' && o.immutable === true));
    assert.equal(update.length, 2);
    const updateFile = path.join(directory, 'janitor-update.yaml');
    await fs.writeFile(updateFile, update.map((o) => stringify(o)).join('\n---\n'), { flag: 'wx', mode: 0o600 });
    Object.assign(variables, {
      RIVET_QUALIFICATION_EVIDENCE_BUCKET: configuration.evidenceBucket,
      RIVET_QUALIFICATION_DRIVER_DIRECTORY: path.join(output, 'driver'),
      RIVET_QUALIFICATION_DRIVER_SHA256: packaged.driverDigest,
      RIVET_QUALIFICATION_STAGING_KUBECONFIG: kubeconfig,
      RIVET_QUALIFICATION_PRIVATE_STORE: path.join(directory, 'inventory'),
      RIVET_QUALIFICATION_CLUSTER_UID: s.clusterUid,
      RIVET_QUALIFICATION_CLUSTER_SERVER: s.clusterServer,
      RIVET_QUALIFICATION_GATEWAY_UID: s.gatewayUid,
      RIVET_QUALIFICATION_PROJECT_ID: s.projectId,
      RIVET_QUALIFICATION_PROJECT_NUMBER: s.projectNumber,
    });
    assertVariables(variables);
    phase.name = 'credentials';
    // The workflow has already authenticated to Google. Preserve credential-fetch
    // failures privately too, even if cluster access itself is denied.
    phase.authenticated = true;
    credentials(p);
    credentials(s);
    phase.name = 'cluster-identity';
    const read = setupKubernetes(s, kubeconfig, run);
    const system = read('namespace', 'kube-system', null);
    assert.equal(system?.metadata?.uid, s.clusterUid, 'Staging context points to another cluster');
    assert.ok(!system.metadata.deletionTimestamp, 'Staging cluster identity is terminating');
    phase.name = 'permissions';
    assertStagingSetupAccess(s, kubeconfig, run);
    // Reject a known unresolved operation without taking a new lock. Repeat
    // under the lock below to cover concurrent admission between these reads.
    phase.name = 'registry';
    assertClosedSetupInventory(read('configmaps', undefined, s.controlNamespace, stagingOwner));
    phase.name = 'baseline-health';
    const deployment = read('deployments', 'rivet-qualification-janitor');
    assert.ok(deployment?.metadata.uid && !deployment.metadata.deletionTimestamp, 'Cleanup worker identity is missing');
    const baselineDigest = JSON.parse(
      read('configmaps', 'rivet-qualification-janitor-health')?.data?.health ?? '{}',
    ).driverDigest;
    assert.match(baselineDigest ?? '', /^[a-f0-9]{64}$/, 'Existing cleanup worker driver is missing');
    assert.ok(await observeStagingJanitor(read, s, baselineDigest), 'Existing cleanup worker is not freshly healthy');
    const receipt = (phase.receipt = {
      protocol: 1,
      operationId,
      sourceSha: environment.GITHUB_SHA,
      bucket: configuration.evidenceBucket,
      settings: s,
      deploymentUid: deployment.metadata.uid,
      baselineSpec: deployment.spec,
      baselineDriverDigest: baselineDigest,
      driverDigest: packaged.driverDigest,
      janitorImage: publication.janitor.image,
      codeName: update.find((o) => o.kind === 'ConfigMap').metadata.name,
      updateIssued: false,
      writerClosed: false,
    });
    phase.name = 'lock';
    await saveStagingSetup(directory, receipt);
    const generation = await cloud.acquire(owner);
    receipt.generation = generation;
    await saveStagingSetup(directory, receipt, cloud);
    variables.RIVET_QUALIFICATION_LOCK_GENERATION = generation;
    phase.name = 'registry';
    assertClosedSetupInventory(read('configmaps', undefined, s.controlNamespace, stagingOwner));
    phase.name = 'private-evidence';
    await cloudEvidence({
      bucket: configuration.evidenceBucket,
      prefix: `qualification/packages/rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
    }).saveDirectory(output);
    phase.name = 'janitor-update';
    receipt.updateIssued = true;
    await saveStagingSetup(directory, receipt, cloud);
    run('kubectl', ['--kubeconfig', kubeconfig, '--context', s.context, 'apply', '-f', updateFile]);
    const applied = read('deployments', 'rivet-qualification-janitor');
    assertSetupJanitorUpdate(applied, receipt);
    receipt.appliedSpec = applied.spec;
    receipt.updateAcknowledged = true;
    await saveStagingSetup(directory, receipt, cloud);
    phase.name = 'janitor-rollout';
    run('kubectl', [
      '--kubeconfig',
      kubeconfig,
      '--context',
      s.context,
      'rollout',
      'status',
      'deployment/rivet-qualification-janitor',
      '-n',
      s.controlNamespace,
      '--timeout=10m',
    ]);
    phase.name = 'janitor-health';
    await waitForStagingJanitor(read, s, packaged.driverDigest);
  } else {
    phase.name = 'production-installation';
    assert.match(configuration.installationUri, /^gs:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_-]+\.json#[1-9][0-9]*$/);
    credentials(p);
    const file = path.join(directory, 'installation.json');
    run('gcloud', ['storage', 'cp', configuration.installationUri, file]);
    await fs.chmod(file, 0o600);
    const installation = JSON.parse(await fs.readFile(file, 'utf8'));
    const values = path.join(directory, 'values.json'),
      policy = path.join(directory, 'policy.json');
    await fs.writeFile(values, Buffer.from(installation.valuesBase64, 'base64'), { flag: 'wx', mode: 0o600 });
    for (const name of ['backup', 'acceptance']) {
      const script = path.join(directory, `${name}.mjs`);
      await fs.writeFile(script, Buffer.from(installation.adapters[name], 'base64'), { flag: 'wx', mode: 0o600 });
      installation.policy[name].script = `${name}.mjs`;
    }
    await fs.writeFile(policy, JSON.stringify(installation.policy), { flag: 'wx', mode: 0o600 });
    Object.assign(variables, {
      RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE: values,
      RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE: policy,
      RIVET_PRODUCTION_PRIVATE_STORE: path.join(directory, 'inventory'),
      RIVET_PRODUCTION_EVIDENCE_BUCKET: configuration.evidenceBucket,
    });
  }
  assertVariables(variables);
  phase.name = 'export';
  for (const [key, value] of Object.entries(variables)) {
    await fs.appendFile(environment.GITHUB_ENV, `${key}=${value}\n`);
  }
  if (phase.receipt) {
    phase.receipt.writerClosed = true;
    await saveStagingSetup(directory, phase.receipt, phase.cloud);
  }
  console.log(`Prepared ${mode} job; private configuration and credentials were not logged.`);
}

export async function cleanupHostedStagingSetup({
  environment = process.env,
  run = runCommand,
  cloudEvidence = privateCloudEvidence,
} = {}) {
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  const directory = path.join(environment.RUNNER_TEMP, 'rivet-staging');
  try {
    return await closeStagingSetup({ directory, environment, run, cloudEvidence });
  } catch (error) {
    const phase = { name: 'setup-closure', directory };
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(directory, 'staging-setup.json'), 'utf8'));
      if (
        receipt.sourceSha === environment.GITHUB_SHA &&
        receipt.operationId === `rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`
      ) {
        Object.assign(phase, {
          authenticated: true,
          operationId: receipt.operationId,
          cloud: cloudEvidence({ bucket: receipt.bucket, prefix: 'qualification' }),
        });
      }
    } catch {
      /* Preserve the original closure failure even if its receipt cannot be read. */
    }
    throw await preparationFailure(error, phase);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cleanup = process.argv[2] === 'cleanup-staging-setup';
  (cleanup
    ? cleanupHostedStagingSetup().then((result) => console.log(`Staging setup closure: ${result.state}`))
    : prepareHostedRelease(process.argv[2])
  ).catch((error) => {
    console.error(
      error.name === 'HostedPreparationError'
        ? error.message
        : 'Staging setup closure is unconfirmed; retain the lock and inspect private evidence.',
    );
    process.exitCode = 1;
  });
}
