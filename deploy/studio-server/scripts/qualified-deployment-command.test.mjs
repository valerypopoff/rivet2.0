import assert from 'node:assert/strict';
// test-style: fixture-read: Inspect only the deployment summary generated in the test-owned temporary checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { legacyAssertionSource, qualifiedDeploymentCommand } from './lib/qualified-deployment-command.mjs';
import { rolloutEntryPointMessages } from '../../../scripts/checks/check-rollout-entrypoints.mjs';
import { deployQualifiedProduction } from './deploy-qualified-production.mjs';

const preload = fileURLToPath(new URL('./qualified-assert-preload.mjs', import.meta.url));
test('the source gate catches a production-only missing import without running a deployment', () => {
  const missing = rolloutEntryPointMessages('export function verify() { assert.equal(1, 1); }');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].ruleId, 'no-undef');
  assert.deepEqual(
    rolloutEntryPointMessages(
      "import assert from 'node:assert/strict'; export function verify() { assert.equal(1, 1); }",
    ),
    [],
  );
});
test('legacy compatibility is limited to the exact qualified revision and production CLI command', () => {
  const root = path.resolve('qualified');
  const args = [path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'), '--preflight-only'];
  const input = { sourceSha: legacyAssertionSource, root, program: process.execPath, args, preload };
  assert.deepEqual(qualifiedDeploymentCommand(input), ['--import', pathToFileURL(preload).href, ...args]);
  for (const change of [{ sourceSha: 'a'.repeat(40) }, { program: 'kubectl' }, { args: ['other.mjs'] }]) {
    const value = { ...input, ...change };
    assert.equal(qualifiedDeploymentCommand(value), value.args);
  }
});

test('the legacy Node binding executes strict assertions and is not propagated through child environments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-legacy-assert-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'legacy.mjs');
  await fs.writeFile(file, 'assert.equal(1, 2);\n');
  const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  const original = run([file]);
  assert.notEqual(original.status, 0);
  assert.match(original.stderr, /ReferenceError: assert is not defined/);
  const protectedRun = run(['--import', pathToFileURL(preload).href, file]);
  assert.notEqual(protectedRun.status, 0);
  assert.match(protectedRun.stderr, /AssertionError/);
  const childFile = path.join(root, 'child.mjs');
  await fs.writeFile(childFile, 'assert.equal(1, 1);\n');
  await fs.writeFile(
    file,
    `
    import strict from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    strict.equal(globalThis.assert, strict);
    const child = spawnSync(process.execPath, [${JSON.stringify(childFile)}], {encoding:'utf8'});
    strict.notEqual(child.status, 0);
    strict.match(child.stderr, /assert is not defined/);
  `,
  );
  const result = run(['--import', pathToFileURL(preload).href, file]);
  assert.equal(result.status, 0, result.stderr);
});

test('the hosted production controller delegates once to the qualified implementation and settles commands on failure', async (t) => {
  const controllerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-qualified-controller-'));
  t.after(() => fs.rm(controllerRoot, { recursive: true, force: true }));
  const root = path.join(controllerRoot, 'qualified'),
    packet = path.join(root, 'artifacts/automated-runtime-qualification');
  const selection = path.join(controllerRoot, 'artifacts/qualified-deployment-inputs');
  await fs.mkdir(packet, { recursive: true });
  await fs.mkdir(selection, { recursive: true });
  const digest = 'sha256:' + 'a'.repeat(64);
  await fs.writeFile(
    path.join(selection, 'selection.json'),
    JSON.stringify({ sourceSha: legacyAssertionSource, digest }),
  );
  for (const name of ['operation-public.json', 'qualified-manifest.json'])
    await fs.writeFile(path.join(packet, name), '{}');
  const environment = {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    DEPLOYMENT_SOURCE_SHA: legacyAssertionSource,
    QUALIFIED_MANIFEST_DIGEST: digest,
    RIVET_QUALIFICATION_PRODUCTION_CONTEXT: 'production',
    RIVET_QUALIFICATION_PRODUCTION_NAMESPACE: 'rivet',
    RIVET_QUALIFICATION_PRODUCTION_RELEASE: 'rivet',
  };
  let invoked = 0,
    settled = 0,
    fail = false;
  const options = {
    controllerRoot,
    environment,
    cwd: root,
    loadQualified: async (file) =>
      file === 'lib/deploy-qualified-release.mjs'
        ? {
            deployQualifiedRelease: async (input) => {
              invoked++;
              assert.equal(input.root, root);
              assert.equal(input.packet, packet);
              assert.equal(input.digest, digest);
              assert.equal(input.sourceSha, legacyAssertionSource);
              assert.deepEqual(input.identity, { context: 'production', namespace: 'rivet', release: 'rivet' });
              await input.run(
                process.execPath,
                [path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs')],
                { capture: true },
              );
              return { status: 'deployed', manifestDigest: digest };
            },
          }
        : {
            runManagedGateCommand: async (program, args, commandOptions) => {
              assert.equal(program, process.execPath);
              assert.equal(args[0], '--import');
              assert.equal(commandOptions.capture, true);
              if (fail) throw Error('Known command failure');
            },
            waitForManagedGateCommands: async () => {
              settled++;
            },
          },
  };
  await deployQualifiedProduction(options);
  assert.equal(invoked, 1);
  assert.equal(settled, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(packet, 'deployment-summary.json'), 'utf8')), {
    status: 'deployed',
    manifestDigest: digest,
  });
  fail = true;
  await assert.rejects(deployQualifiedProduction(options), /Known command failure/);
  assert.equal(invoked, 2);
  assert.equal(settled, 2);
  await assert.rejects(
    deployQualifiedProduction({ ...options, environment: { ...environment, DEPLOYMENT_SOURCE_SHA: 'b'.repeat(40) } }),
  );
  assert.equal(invoked, 2);
  await assert.rejects(
    deployQualifiedProduction({ ...options, environment: { ...environment, QUALIFIED_PREFLIGHT_ONLY: 'invalid' } }),
  );
  assert.equal(invoked, 2, 'Malformed preflight selection cannot fall through to deployment');
  await assert.rejects(
    deployQualifiedProduction({ ...options, environment: { ...environment, QUALIFIED_PREFLIGHT_ONLY: 'true' } }),
  );
  assert.equal(invoked, 2, 'A failed preflight cannot invoke the qualified deployment implementation');
});
