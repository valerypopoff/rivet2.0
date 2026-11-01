import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments, stringify } from 'yaml';
import { packageReusableStaging } from './package-reusable-staging.mjs';
import { privateCloudEvidence } from './lib/private-cloud-evidence.mjs';
import { assertActionsQualificationWindow } from './lib/runtime-qualification-execution.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = (bin, args, env = process.env) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    timeout: 600000,
    env,
  }).trim();
const mode = process.argv[2];
async function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.ok(['staging', 'production'].includes(mode));
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  if (mode === 'staging') assertActionsQualificationWindow(Number(process.env.RIVET_QUALIFICATION_MAX_SECONDS));
  const configuration = JSON.parse(process.env.RIVET_DEPLOYMENT_CONFIGURATION);
  delete process.env.RIVET_DEPLOYMENT_CONFIGURATION;
  assert.equal(configuration.protocol, 1);
  const directory = path.join(process.env.RUNNER_TEMP, `rivet-${mode}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const variables = {};
  const kubeconfig = path.join(directory, 'kubeconfig');
  const env = { ...process.env, KUBECONFIG: kubeconfig, USE_GKE_GCLOUD_AUTH_PLUGIN: 'True' };
  const credentials = (identity) => {
    for (const name of ['projectId', 'clusterName', 'region']) assert.match(identity[name], /^[a-z][a-z0-9-]+$/);
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
      env,
    );
  };
  const p = configuration.production;
  credentials(p);
  for (const [key, value] of Object.entries({
    CONTEXT: p.context,
    NAMESPACE: p.namespace,
    RELEASE: p.release,
    NAMESPACE_UID: p.namespaceUid,
  }))
    variables[`RIVET_QUALIFICATION_PRODUCTION_${key}`] = value;
  variables.KUBECONFIG = kubeconfig;
  variables.RIVET_QUALIFICATION_PRODUCTION_KUBECONFIG = kubeconfig;
  if (mode === 'staging') {
    const s = configuration.staging;
    credentials(s);
    assert.match(p.valuesDigest, /^sha256:[a-f0-9]{64}$/);
    variables.RIVET_QUALIFICATION_PRODUCTION_VALUES_SHA256 = p.valuesDigest;
    const publication = JSON.parse(
      await fs.readFile(path.join(root, 'artifacts/qualification-image-publication/publication.json'), 'utf8'),
    );
    assert.equal(publication.sourceSha, process.env.GITHUB_SHA);
    for (const [name, image] of [
      ['qualification', publication.actor.image],
      ['qualification-minio', publication.minio.image],
    ]) {
      const prefix = `ghcr.io/${process.env.GITHUB_REPOSITORY.toLowerCase()}-studio-server/${name}@`;
      assert.ok(image.startsWith(prefix));
      assert.match(image.slice(prefix.length), /^sha256:[a-f0-9]{64}$/);
    }
    const settings = { ...s, actorImage: publication.actor.image, objectStorageImage: publication.minio.image };
    const cloud = privateCloudEvidence({ bucket: configuration.evidenceBucket, prefix: 'qualification' });
    const owner = Buffer.from(
      JSON.stringify({
        operationId: `rivet-q-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
        sourceSha: process.env.GITHUB_SHA,
      }),
    );
    const generation = await cloud.acquire(owner);
    const output = path.join(directory, 'package');
    const packaged = await packageReusableStaging({
      settings,
      output,
      janitorImage: publication.actor.image,
      googleServiceAccount: configuration.janitorServiceAccount,
    });
    await privateCloudEvidence({
      bucket: configuration.evidenceBucket,
      prefix: `qualification/packages/rivet-q-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    }).saveDirectory(output);
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
    Object.assign(variables, {
      RIVET_QUALIFICATION_LOCK_GENERATION: generation,
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
  } else {
    assert.match(configuration.installationUri, /^gs:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_-]+\.json#[1-9][0-9]*$/);
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
  for (const [key, value] of Object.entries(variables)) {
    assert.ok(typeof value === 'string' && value && !/[\r\n\0]/.test(value));
    await fs.appendFile(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
  console.log(`Prepared ${mode} job; private configuration and credentials were not logged.`);
}
main().catch(() => {
  console.error('Hosted release preparation failed; inspect private receipts before any retry.');
  process.exitCode = 1;
});
