import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertQualifiedPublicationRun,
  qualifiedDeploymentSelection,
  assertQualifiedDeploymentReceipt,
  recoveredOperationReference,
} from './lib/qualified-deployment-inputs.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const command = (bin, args) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });

async function resolve(environment, { packet, command }) {
  assert.equal(environment.REUSE_DEPLOY_PRODUCTION, 'true');
  assert.equal(environment.REUSE_BUILD_RUN_ID ?? '', '');
  assert.equal(environment.REUSE_TOOLING_RUN_ID ?? '', '');
  assert.equal(environment.REUSE_SIZING_REQUESTS ?? '', '');
  const runId = environment.QUALIFIED_PUBLICATION_RUN_ID;
  assert.match(runId ?? '', /^[1-9][0-9]*$/);
  const repository = environment.GITHUB_REPOSITORY;
  assert.match(repository ?? '', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  assert.equal(Boolean(environment.RECOVERED_OPERATION_URI), Boolean(environment.RECOVERED_OPERATION_SHA256));
  if (environment.RECOVERED_OPERATION_URI) {
    // Bucket identity is checked after protected production configuration is loaded.
    const bucket = /^gs:\/\/([^/]+)\//.exec(environment.RECOVERED_OPERATION_URI)?.[1];
    recoveredOperationReference(environment.RECOVERED_OPERATION_URI, environment.RECOVERED_OPERATION_SHA256, bucket);
  }
  await fs.mkdir(path.dirname(packet), { recursive: true, mode: 0o700 });
  await fs.mkdir(packet, { mode: 0o700 });
  const run = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]));
  const artifactName = assertQualifiedPublicationRun(run, { repository, runId });
  command('gh', ['run', 'download', runId, '--repo', repository, '--name', artifactName, '--dir', packet]);
  const manifest = await read(path.join(packet, 'promoted-release-manifest.json'));
  const declarations = await read(path.join(packet, 'provider-declarations.json'));
  const selected = qualifiedDeploymentSelection({ manifest, declarations, publicationRun: run, repository });
  if (!environment.RECOVERED_OPERATION_URI)
    command('gh', [
      'run',
      'download',
      selected.runId,
      '--repo',
      repository,
      '--name',
      `qualification-result-${selected.runId}-${selected.runAttempt}`,
      '--dir',
      packet,
    ]);
  if (!environment.RECOVERED_OPERATION_URI)
    assertQualifiedDeploymentReceipt(await read(path.join(packet, 'operation-public.json')), {
      manifest,
      declarations,
    });
  await save(path.join(packet, 'selection.json'), selected);
  await fs.appendFile(
    environment.GITHUB_OUTPUT,
    `source_sha=${selected.sourceSha}\nmanifest_digest=${selected.digest}\n`,
  );
  console.log(`Reusing qualified publication ${runId}; no staging operation or image build will run.`);
}

async function materialize(environment, { root, packet, command }) {
  const selected = await read(path.join(packet, 'selection.json'));
  const manifest = await read(path.join(packet, 'promoted-release-manifest.json'));
  const declarations = await read(path.join(packet, 'provider-declarations.json'));
  let operationFile = path.join(packet, 'operation-public.json');
  if (environment.RECOVERED_OPERATION_URI) {
    const uri = recoveredOperationReference(
      environment.RECOVERED_OPERATION_URI,
      environment.RECOVERED_OPERATION_SHA256,
      environment.RIVET_PRODUCTION_EVIDENCE_BUCKET,
    );
    operationFile = path.join(packet, 'recovered-operation.json');
    command('gcloud', ['storage', 'cp', uri, operationFile]);
    await fs.chmod(operationFile, 0o600);
    const bytes = await fs.readFile(operationFile);
    assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), environment.RECOVERED_OPERATION_SHA256);
  }
  const operation = assertQualifiedDeploymentReceipt(await read(operationFile), { manifest, declarations });
  assert.equal(environment.DEPLOYMENT_SOURCE_SHA, selected.sourceSha);
  assert.equal(environment.QUALIFIED_MANIFEST_DIGEST, selected.digest);
  const target = path.join(root, 'qualified/artifacts/automated-runtime-qualification');
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await save(path.join(target, 'operation-public.json'), operation);
  await save(path.join(target, 'qualified-manifest.json'), manifest);
  console.log('Original qualification receipt and exact published manifest prepared for production.');
}

export async function prepareQualifiedDeployment(mode, environment = process.env, options = {}) {
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  const checkout = options.root ?? root;
  const context = {
    root: checkout,
    packet: path.join(checkout, 'artifacts/qualified-deployment-inputs'),
    command: options.command ?? command,
  };
  if (mode === 'resolve') return resolve(environment, context);
  if (mode === 'materialize') return materialize(environment, context);
  throw Error('Unknown qualified deployment preparation phase');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareQualifiedDeployment(process.argv[2]).catch(() => {
    console.error(
      'Qualified deployment inputs were not verified; no production rollout was started. Inspect the publication identity and original qualification receipt.',
    );
    process.exitCode = 1;
  });
