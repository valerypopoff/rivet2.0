import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments, stringify } from 'yaml';
import { packageReusableStaging } from './package-reusable-staging.mjs';
import { privateCloudEvidence } from './lib/private-cloud-evidence.mjs';
import { assertActionsQualificationWindow } from './lib/runtime-qualification-execution.mjs';
import { waitForStagingJanitor } from './lib/staging-janitor-health.mjs';
import { stagingOwner } from './lib/reusable-staging-state.mjs';

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

export async function prepareHostedRelease(
  mode,
  {
    environment = process.env,
    run = runCommand,
    cloudEvidence = privateCloudEvidence,
    publicationFile = path.join(root, 'artifacts/qualification-image-publication/publication.json'),
  } = {},
) {
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.ok(['staging', 'production'].includes(mode));
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  if (mode === 'staging') assertActionsQualificationWindow(Number(environment.RIVET_QUALIFICATION_MAX_SECONDS));
  const configuration = JSON.parse(environment.RIVET_DEPLOYMENT_CONFIGURATION);
  delete environment.RIVET_DEPLOYMENT_CONFIGURATION;
  assert.equal(configuration.protocol, 1);
  const directory = path.join(environment.RUNNER_TEMP, `rivet-${mode}`);
  await fs.mkdir(directory, { mode: 0o700 });
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
    const cloud = cloudEvidence({ bucket: configuration.evidenceBucket, prefix: 'qualification' });
    const owner = Buffer.from(
      JSON.stringify({
        operationId: `rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
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
    credentials(p);
    credentials(s);
    const system = JSON.parse(
      run('kubectl', [
        '--kubeconfig',
        kubeconfig,
        '--context',
        s.context,
        'get',
        'namespace',
        'kube-system',
        '-o',
        'json',
        '--request-timeout=15s',
      ]),
    );
    assert.equal(system.metadata?.uid, s.clusterUid, 'Staging context points to another cluster');
    assert.ok(!system.metadata.deletionTimestamp, 'Staging cluster identity is terminating');
    const generation = await cloud.acquire(owner);
    variables.RIVET_QUALIFICATION_LOCK_GENERATION = generation;
    const registry = JSON.parse(
      run('kubectl', [
        '--kubeconfig',
        kubeconfig,
        '--context',
        s.context,
        '-n',
        s.controlNamespace,
        'get',
        'configmaps',
        '-l',
        stagingOwner,
        '-o',
        'json',
        '--request-timeout=15s',
      ]),
    );
    assert.ok(
      Array.isArray(registry.items) && !registry.metadata?.continue,
      'Staging registry inventory is incomplete',
    );
    for (const item of registry.items) {
      const record = JSON.parse(item.data?.record ?? '{}');
      assert.ok(
        record.cleanupVerified === true && record.phase === 'cleaned' && record.closed === true,
        'An existing staging operation needs cleanup; keep its current janitor',
      );
    }
    await cloudEvidence({
      bucket: configuration.evidenceBucket,
      prefix: `qualification/packages/rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
    }).saveDirectory(output);
    run('kubectl', ['--kubeconfig', kubeconfig, '--context', s.context, 'apply', '-f', updateFile]);
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
    await waitForStagingJanitor(
      (resource, name) => {
        const output = run('kubectl', [
          '--kubeconfig',
          kubeconfig,
          '--context',
          s.context,
          '-n',
          s.controlNamespace,
          'get',
          resource,
          name,
          '--ignore-not-found',
          '-o',
          'json',
          '--request-timeout=5s',
        ]);
        return output ? JSON.parse(output) : null;
      },
      s,
      packaged.driverDigest,
    );
  } else {
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
  for (const [key, value] of Object.entries(variables)) {
    await fs.appendFile(environment.GITHUB_ENV, `${key}=${value}\n`);
  }
  console.log(`Prepared ${mode} job; private configuration and credentials were not logged.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareHostedRelease(process.argv[2]).catch(() => {
    console.error('Hosted release preparation failed; inspect private receipts before any retry.');
    process.exitCode = 1;
  });
}
