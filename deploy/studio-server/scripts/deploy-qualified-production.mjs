import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { qualifiedDeploymentCommand } from './lib/qualified-deployment-command.mjs';

const controller = fileURLToPath(new URL('../../../', import.meta.url));
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

export async function deployQualifiedProduction({
  controllerRoot = controller,
  environment = process.env,
  cwd = process.cwd(),
  loadQualified,
} = {}) {
  const root = path.join(controllerRoot, 'qualified');
  const packet = path.join(root, 'artifacts/automated-runtime-qualification');
  const load =
    loadQualified ?? ((file) => import(pathToFileURL(path.join(root, 'deploy/studio-server/scripts', file)).href));
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  assert.equal(await fs.realpath(cwd), await fs.realpath(root));
  const selected = await read(path.join(controllerRoot, 'artifacts/qualified-deployment-inputs/selection.json'));
  assert.equal(environment.DEPLOYMENT_SOURCE_SHA, selected.sourceSha);
  assert.equal(environment.QUALIFIED_MANIFEST_DIGEST, selected.digest);
  const { deployQualifiedRelease } = await load('lib/deploy-qualified-release.mjs');
  const { runManagedGateCommand, waitForManagedGateCommands } = await load('lib/managed-gate-command.mjs');
  try {
    const result = await deployQualifiedRelease({
      root,
      packet,
      operation: await read(path.join(packet, 'operation-public.json')),
      manifest: await read(path.join(packet, 'qualified-manifest.json')),
      digest: selected.digest,
      sourceSha: selected.sourceSha,
      valuesFile: environment.RIVET_QUALIFICATION_PRODUCTION_VALUES_FILE,
      policyFile: environment.RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE,
      privateStore: environment.RIVET_PRODUCTION_PRIVATE_STORE,
      evidenceBucket: environment.RIVET_PRODUCTION_EVIDENCE_BUCKET,
      identity: {
        context: environment.RIVET_QUALIFICATION_PRODUCTION_CONTEXT,
        namespace: environment.RIVET_QUALIFICATION_PRODUCTION_NAMESPACE,
        release: environment.RIVET_QUALIFICATION_PRODUCTION_RELEASE,
      },
      run: (program, args, options) =>
        runManagedGateCommand(
          program,
          qualifiedDeploymentCommand({
            sourceSha: selected.sourceSha,
            root,
            program,
            args,
            preload: path.join(controllerRoot, 'deploy/studio-server/scripts/qualified-assert-preload.mjs'),
          }),
          options,
        ),
    });
    await fs.writeFile(path.join(packet, 'deployment-summary.json'), JSON.stringify(result, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    await waitForManagedGateCommands();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  deployQualifiedProduction().catch(() => {
    console.error(
      'Qualified production deployment stopped. Inspect the private deployment receipts before recovery; no uncertain write was retried.',
    );
    process.exitCode = 1;
  });
