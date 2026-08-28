import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const rootDir = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function parseWorkflow(relativePath) {
  const source = read(relativePath);
  const document = parseDocument(source, { prettyErrors: true, strict: true });
  if (document.errors.length > 0) {
    throw new Error(`${relativePath} is not valid YAML:\n${document.errors.join('\n')}`);
  }
  return { source, workflow: document.toJS() };
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function assertIncludesAll(actual, expected, label) {
  for (const value of expected) {
    assert.ok(actual.includes(value), `${label} must include ${value}.`);
  }
}

const build = parseWorkflow('.github/workflows/build.yml');
const buildJobs = build.workflow.jobs;
assertIncludesAll(
  Object.keys(buildJobs),
  ['compiled-artifacts', 'package-tests', 'package-lint', 'static-validation', 'rust-audit', 'build'],
  'Build jobs',
);
assert.equal(build.workflow.concurrency['cancel-in-progress'], true, 'Build must cancel superseded refs.');
assert.equal(buildJobs['package-tests'].strategy['fail-fast'], false);
assert.equal(buildJobs['package-lint'].strategy['fail-fast'], false);
assert.equal(buildJobs['package-lint'].needs, undefined, 'Source-only lint must not wait for compiled artifacts.');
assert.deepEqual(asArray(buildJobs['package-tests'].needs), ['compiled-artifacts']);
assert.equal(buildJobs['package-tests'].strategy['max-parallel'], 6);
assert.equal(buildJobs['package-lint'].strategy['max-parallel'], 6);
assert.deepEqual(
  buildJobs['package-tests'].strategy.matrix.include.map((entry) => entry.command).sort(),
  ['test:app', 'test:app-executor', 'test:cli', 'test:core', 'test:evaluations', 'test:node'],
  'Build test matrix must retain all six package suites.',
);
assert.equal(
  build.source.includes('run: yarn check:graph-builder-assets'),
  false,
  'Build must not duplicate the graph asset check already owned by test:style.',
);
assertIncludesAll(
  asArray(buildJobs.build.needs),
  ['compiled-artifacts', 'package-tests', 'package-lint', 'static-validation', 'rust-audit'],
  'Build aggregator',
);
assert.match(build.source, /job-timing\.mjs finish-at/, 'Build must report the complete workflow critical path.');

const studio = parseWorkflow('.github/workflows/studio-server-verify.yml');
const studioJobs = studio.workflow.jobs;
assert.ok(studio.workflow.on.workflow_call, 'Studio Server verification must remain reusable by the image pipeline.');
assert.equal(
  studio.workflow.permissions.actions,
  'read',
  'Studio verification needs Actions read access for timing summaries.',
);
assert.match(
  String(studio.workflow.concurrency['cancel-in-progress']),
  /event_name.*push.*ref_type.*branch.*event_name.*pull_request/,
  'Studio verification must cancel stale branch and pull-request runs without canceling manual or tagged releases.',
);
assertIncludesAll(
  Object.keys(studioJobs),
  [
    'changes',
    'build-studio-server',
    'api-tests',
    'web-tests',
    'host-compatibility',
    'repository-contracts',
    'deployment-contracts',
    'verify',
  ],
  'Studio Server verification jobs',
);
assert.deepEqual(
  studioJobs['api-tests'].strategy.matrix.include.map((entry) => entry.shard),
  [0, 1, 2, 3],
);
assert.equal(studioJobs['api-tests'].strategy['fail-fast'], false);
assert.equal(studioJobs['api-tests'].strategy['max-parallel'], 4);
assert.deepEqual(asArray(studioJobs['build-studio-server'].needs), ['changes']);
assert.deepEqual(asArray(studioJobs['api-tests'].needs), ['changes', 'build-studio-server']);
assert.deepEqual(asArray(studioJobs['web-tests'].needs), ['changes', 'build-studio-server']);
assert.deepEqual(asArray(studioJobs['host-compatibility'].needs), ['changes']);
assert.deepEqual(asArray(studioJobs['repository-contracts'].needs), ['changes']);
assert.deepEqual(asArray(studioJobs['deployment-contracts'].needs), ['changes', 'build-studio-server']);
assertIncludesAll(
  asArray(studioJobs.verify.needs),
  [
    'changes',
    'build-studio-server',
    'api-tests',
    'web-tests',
    'host-compatibility',
    'repository-contracts',
    'deployment-contracts',
  ],
  'Studio Server verify aggregator',
);
assert.match(
  studio.source,
  /Studio Server verification critical path[\s\S]*job-timing\.mjs finish-at/,
  'Studio verification must report its total critical path.',
);

const images = parseWorkflow('.github/workflows/studio-server-images.yml');
const imageJobs = images.workflow.jobs;
assert.equal(
  images.workflow.permissions.actions,
  'read',
  'Image builds must pass Actions read access into reusable verification.',
);
assert.match(
  String(images.workflow.concurrency['cancel-in-progress']),
  /event_name.*push.*ref_type.*branch/,
  'Image runs may be canceled only for stale branch pushes.',
);
assert.equal(
  imageJobs['build-and-push'].needs,
  undefined,
  'Candidate image builds must start in parallel with repository verification.',
);
assert.equal(imageJobs['verify-repository'].uses, './.github/workflows/studio-server-verify.yml');
assert.match(
  images.source,
  /SOURCE_TAG: candidate-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  'Candidate image tags must be isolated per workflow attempt so a re-run cannot overwrite another candidate.',
);
assertIncludesAll(
  Object.keys(imageJobs),
  [
    'changes',
    'verify-repository',
    'build-and-push',
    'fast-container-smoke',
    'managed-kubernetes-release-gate',
    'promote-images',
  ],
  'Image jobs',
);
assert.match(String(imageJobs['managed-kubernetes-release-gate'].if), /full_kubernetes/);
const promotionCondition = String(imageJobs['promote-images'].if);
for (const requiredGate of [
  'verify-repository',
  'build-and-push',
  'fast-container-smoke',
  'managed-kubernetes-release-gate',
  'managed-kubernetes-provider-gate',
]) {
  assert.match(
    promotionCondition,
    new RegExp(`needs\\.${requiredGate.replaceAll('-', '\\-')}\\.result`),
    `Image promotion must depend on ${requiredGate}.`,
  );
}
assert.match(
  promotionCondition,
  /full_kubernetes == 'true'.*managed-kubernetes-release-gate\.result == 'success'/,
  'A full-Kubernetes release may be promoted only after the Kind gate succeeds.',
);
assert.match(
  promotionCondition,
  /full_kubernetes != 'true'.*managed-kubernetes-release-gate\.result == 'skipped'/,
  'A skipped Kind gate is acceptable only when classification selected the fast path.',
);
assert.deepEqual(asArray(imageJobs['fast-container-smoke'].needs), ['build-and-push']);
assert.deepEqual(asArray(imageJobs['managed-kubernetes-release-gate'].needs), ['changes', 'build-and-push']);
assert.deepEqual(asArray(imageJobs['managed-kubernetes-provider-gate'].needs), ['build-and-push']);
assertIncludesAll(
  asArray(imageJobs['promote-images'].needs),
  [
    'changes',
    'verify-repository',
    'build-and-push',
    'fast-container-smoke',
    'managed-kubernetes-release-gate',
    'managed-kubernetes-provider-gate',
  ],
  'Image promotion dependencies',
);
assert.ok(images.workflow.on.push.paths.length > 0, 'Main image builds must be path-gated.');
assert.ok(images.workflow.on.schedule, 'Weekly full image verification must remain configured.');

const reusableDesktop = parseWorkflow('.github/workflows/desktop-release.yml');
const reusableJobs = reusableDesktop.workflow.jobs;
for (const buildJob of ['build-windows', 'build-macos', 'build-docs']) {
  assert.equal(
    reusableJobs[buildJob].needs,
    undefined,
    `${buildJob} must run concurrently with graph asset verification.`,
  );
}
assert.equal(reusableJobs['publish-pages'].concurrency.group, 'rivet-docs-pages');
assertIncludesAll(
  asArray(reusableJobs['publish-pages'].needs),
  ['verify-ai-graph-builder-assets', 'build-windows', 'build-macos', 'build-docs'],
  'Desktop publication gate',
);
assert.match(reusableDesktop.source, /git ls-remote origin/);
assert.match(reusableDesktop.source, /steps\.freshness\.outputs\.current == 'true'/);
assert.match(
  reusableDesktop.source,
  /id: asset_freshness[\s\S]*Publish desktop release assets[\s\S]*steps\.asset_freshness\.outputs\.current == 'true'/,
  'Desktop release assets must recheck the branch head immediately before publication.',
);
assert.match(
  reusableDesktop.source,
  /id: pages_freshness[\s\S]*Upload Pages artifact[\s\S]*steps\.pages_freshness\.outputs\.current == 'true'/,
  'Pages publication must recheck the branch head immediately before its transaction.',
);

for (const workflowPath of [
  '.github/workflows/developer-windows-release.yml',
  '.github/workflows/official-windows-release.yml',
]) {
  const caller = parseWorkflow(workflowPath);
  assert.ok(caller.workflow.on.push.paths.length > 0, `${workflowPath} must be path-gated.`);
  assert.match(
    String(caller.workflow.concurrency['cancel-in-progress']),
    /github\.event_name == 'push'/,
    `${workflowPath} must cancel only superseded push builds, not manual releases.`,
  );
  assert.match(
    String(caller.workflow.concurrency.group),
    /github\.run_id/,
    `${workflowPath} must keep manual releases out of the push cancellation group.`,
  );
  assert.equal(caller.workflow.jobs.release.uses, './.github/workflows/desktop-release.yml');
}

const npmPublish = parseWorkflow('.github/workflows/publish-npm-packages.yml');
assert.ok(npmPublish.workflow.on.push.paths.length > 0, 'npm publishing must be path-gated.');
assert.equal(
  npmPublish.workflow.concurrency['cancel-in-progress'],
  false,
  'An active npm publication must never be canceled.',
);

console.log('GitHub workflow CI policy is valid.');
