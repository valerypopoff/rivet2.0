import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseManifestMatchesCurrentChart,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import {
  assertRuntimeQualificationBuild,
  prepareRuntimeQualification,
  assertRuntimeQualificationPointer,
} from './lib/runtime-qualification-publication.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = path.join(root, 'artifacts/runtime-qualification-publication');
const read = (name) => fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse);
const write = (name, value) =>
  fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const output = (name, value) => fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
const context = () => ({
  repository: process.env.GITHUB_REPOSITORY,
  sourceSha: process.env.GITHUB_SHA,
  runId: process.env.BUILD_RUN_ID,
});
const jsonInput = (key) => {
  const value = process.env[key];
  assert.ok(value && value.length <= 16384);
  return JSON.parse(value);
};

async function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.match(process.env.GITHUB_REPOSITORY ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const mode = process.argv[2];
  if (mode === 'validate-run-id') {
    assert.match(process.env.BUILD_RUN_ID ?? '', /^[1-9][0-9]*$/);
    await fs.mkdir(dir, { recursive: true });
    await output('run_id', process.env.BUILD_RUN_ID);
  } else if (mode === 'metadata') {
    const build = assertRuntimeQualificationBuild(await read('build-run.json'), context());
    await write('build-identity.json', build);
    await output('run_attempt', build.runAttempt);
  } else if (mode === 'prepare') {
    const result = prepareRuntimeQualification({
      ...context(),
      build: await read('build-identity.json'),
      candidate: await read('candidate/candidate-release-manifest.json'),
      promoted: await read('original/promoted-release-manifest.json'),
      control: jsonInput('RUNTIME_CONTROL_DECLARATION'),
      autoscaling: jsonInput('RUNTIME_AUTOSCALING_DECLARATION'),
    });
    assertReleaseManifestMatchesCurrentChart(result.candidate, root, { requirePromoted: false });
    await write('qualified-candidate.json', result.candidate);
    await write('provider-declarations.json', result.declarations);
    await write('publication-plan.json', {
      expectedProductionDigest: result.expectedProductionDigest,
      predecessorDigest: result.predecessorDigest,
      publicationBaselineDigest: result.publicationBaselineDigest,
    });
    await output(
      'promotion_base_reference',
      `ghcr.io/${process.env.GITHUB_REPOSITORY.toLowerCase()}-studio-server/release-manifest:manifest-${result.publicationBaselineDigest.slice(7)}`,
    );
  } else if (mode === 'verify-pointer') {
    assertRuntimeQualificationPointer(
      await read('current-production.json'),
      (await read('publication-plan.json')).expectedProductionDigest,
    );
  } else if (mode === 'verify-published') {
    const expected = getStudioServerReleaseManifestDigest(await read('promoted-release-manifest.json'), {
      requirePromoted: true,
    });
    assertRuntimeQualificationPointer(await read('published-production.json'), expected);
    console.log(`Runtime-qualified immutable manifest verified: ${expected}. No GCP workload was changed.`);
  } else throw Error('Unknown publication phase');
}
main().catch(() => {
  // Declarations must not contain secrets, but even malformed operator input
  // must not be echoed by assert's actual/expected diagnostic rendering.
  const phase = ['validate-run-id', 'metadata', 'prepare', 'verify-pointer', 'verify-published'].includes(
    process.argv[2],
  )
    ? process.argv[2]
    : 'input';
  console.error(
    `[runtime-qualification:${phase}] Validation failed. No declaration values were logged; inspect the source/build identity and documented provider declaration contract.`,
  );
  process.exitCode = 1;
});
