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

function findStep(job, name, label) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `${label} must contain a ${JSON.stringify(name)} step.`);
  return step;
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
const compiledArtifactUpload = findStep(
  buildJobs['compiled-artifacts'],
  'Upload compiled dependencies',
  'Compiled-artifacts job',
);
const compiledArtifactDownload = findStep(
  buildJobs['package-tests'],
  'Download compiled dependencies',
  'Package-tests job',
);
assert.equal(compiledArtifactUpload.with?.name, 'build-dependencies-${{ github.sha }}');
assert.equal(
  compiledArtifactUpload.with?.overwrite,
  true,
  'The sole compiled-artifact producer must replace an artifact when its job is re-run.',
);
assert.equal(compiledArtifactDownload.with?.name, compiledArtifactUpload.with?.name);
assert.equal(
  compiledArtifactDownload.with?.path,
  'packages',
  'Package tests must restore compiled exports beneath their package-defined paths.',
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
const compiledStudioArtifactUpload = findStep(
  studioJobs['build-studio-server'],
  'Upload compiled Studio Server dependencies',
  'Build Studio Server job',
);
assert.equal(compiledStudioArtifactUpload.with?.name, 'studio-server-build-${{ github.sha }}');
assert.equal(
  compiledStudioArtifactUpload.with?.overwrite,
  true,
  'The sole Studio Server artifact producer must replace an artifact when its job is re-run.',
);
for (const jobName of ['api-tests', 'web-tests', 'deployment-contracts']) {
  const compiledStudioArtifactDownload = findStep(
    studioJobs[jobName],
    'Download compiled Studio Server dependencies',
    `${jobName} job`,
  );
  assert.equal(compiledStudioArtifactDownload.with?.name, compiledStudioArtifactUpload.with?.name);
  assert.equal(
    compiledStudioArtifactDownload.with?.path,
    'packages',
    `${jobName} must restore compiled workspace exports beneath packages/.`,
  );
}
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
const capacityDispatchInput = images.workflow.on.workflow_dispatch?.inputs?.run_managed_kubernetes_capacity_gate;
assert.equal(
  capacityDispatchInput?.type,
  'boolean',
  'Image workflow must expose a boolean manual capacity-certificate input.',
);
assert.equal(capacityDispatchInput?.default, false, 'The capacity certificate must never run implicitly.');
const lineageBootstrapInput = images.workflow.on.workflow_dispatch?.inputs?.allow_release_lineage_bootstrap;
assert.equal(
  lineageBootstrapInput?.default,
  false,
  'Starting a new production release lineage must require an explicit manual acknowledgement.',
);
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
    'release-manifest',
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
assert.deepEqual(
  asArray(imageJobs['managed-kubernetes-release-gate'].needs),
  ['changes', 'build-and-push', 'release-manifest'],
  'The Kubernetes compatibility gate must consume the same manifest-bound predecessor that the candidate records.',
);
assert.deepEqual(asArray(imageJobs['managed-kubernetes-provider-gate'].needs), ['build-and-push']);
assertIncludesAll(
  asArray(imageJobs['promote-images'].needs),
  [
    'changes',
    'verify-repository',
    'build-and-push',
    'release-manifest',
    'fast-container-smoke',
    'managed-kubernetes-release-gate',
    'managed-kubernetes-provider-gate',
  ],
  'Image promotion dependencies',
);
const mainFreshness = findStep(
  imageJobs['promote-images'],
  'Confirm main still points to this release',
  'Image promotion job',
);
assert.equal(mainFreshness.id, 'main_freshness');
assert.match(
  String(mainFreshness.if),
  /github\.ref == 'refs\/heads\/main'/,
  'Image promotion freshness applies to mutable main aliases only.',
);
assert.match(
  mainFreshness.run,
  /git ls-remote origin refs\/heads\/main/,
  'Image promotion must re-read the current main head immediately before alias publication.',
);
for (const stepName of [
  'Promote Complete Image Set',
  'Attest promoted release manifest',
  'Publish immutable release manifest',
  'Upload promoted release manifest',
]) {
  assert.match(
    String(findStep(imageJobs['promote-images'], stepName, 'Image promotion job').if),
    /steps\.main_freshness\.outputs\.current == 'true'/,
    `${stepName} must not run for a stale main release.`,
  );
}
const candidatePredecessor = findStep(
  imageJobs['release-manifest'],
  'Resolve exact production predecessor',
  'Candidate release-manifest job',
);
assert.match(candidatePredecessor.run, /release-manifest-oci\.mjs pull/);
assert.match(candidatePredecessor.run, /allow_release_lineage_bootstrap/i);
assert.match(
  findStep(
    imageJobs['managed-kubernetes-release-gate'],
    'Resolve manifest-bound predecessor API image',
    'Managed Kubernetes release gate',
  ).run,
  /\.lineage\.predecessor\.images\.api\.digest/,
  'The compatibility rehearsal must use the exact API digest bound into the candidate manifest.',
);
assert.doesNotMatch(
  findStep(
    imageJobs['managed-kubernetes-release-gate'],
    'Resolve manifest-bound predecessor API image',
    'Managed Kubernetes release gate',
  ).run,
  /api:latest/,
  'A mutable API alias must not authorize predecessor compatibility.',
);
const promotionSteps = imageJobs['promote-images'].steps.map((step) => step.name);
assert.ok(
  promotionSteps.indexOf('Attest promoted release manifest') <
    promotionSteps.indexOf('Publish immutable release manifest') &&
    promotionSteps.indexOf('Publish immutable release manifest') <
      promotionSteps.indexOf('Promote Complete Image Set') &&
    promotionSteps.indexOf('Promote Complete Image Set') <
      promotionSteps.indexOf('Advance durable production release pointer'),
  'Promotion must validate lineage, publish immutable evidence, promote the image set, and advance the production pointer last.',
);
const lineageAdvance = findStep(
  imageJobs['promote-images'],
  'Advance durable production release pointer',
  'Image promotion job',
);
assert.match(String(lineageAdvance.if), /github\.ref == 'refs\/heads\/main'/);
assert.match(lineageAdvance.run, /release-manifest-oci\.mjs retag/);
assert.ok(images.workflow.on.push.paths.length > 0, 'Main image builds must be path-gated.');
assert.ok(images.workflow.on.schedule, 'Weekly full image verification must remain configured.');
assert.equal(
  findStep(
    imageJobs['managed-kubernetes-release-gate'],
    'Upload Managed Kubernetes Gate Artifacts',
    'Managed Kubernetes release gate',
  ).with?.name,
  'managed-kubernetes-release-gate-${{ github.run_id }}-${{ github.run_attempt }}',
  'Managed Kubernetes release-gate diagnostics must remain distinct per workflow attempt.',
);
assert.equal(
  findStep(
    imageJobs['managed-kubernetes-provider-gate'],
    'Upload Managed Kubernetes Provider Gate Artifacts',
    'Managed Kubernetes provider gate',
  ).with?.name,
  'managed-kubernetes-provider-gate-${{ github.run_id }}-${{ github.run_attempt }}',
  'Managed Kubernetes provider-gate diagnostics must remain distinct per workflow attempt.',
);
assert.ok(
  imageJobs['managed-kubernetes-capacity-gate'],
  'Image workflow must expose the protected published-capacity gate.',
);
assert.match(
  String(imageJobs['managed-kubernetes-provider-gate'].if),
  /run_managed_kubernetes_capacity_gate/,
  'The provider gate must deploy immutable candidate images before the capacity gate runs.',
);
assert.deepEqual(
  asArray(imageJobs['managed-kubernetes-capacity-gate'].needs),
  ['build-and-push', 'managed-kubernetes-provider-gate'],
  'The capacity gate must run only after the candidate images are built and deployed to protected staging.',
);
assert.equal(
  imageJobs['managed-kubernetes-capacity-gate'].environment?.name,
  'rivet-managed-staging',
  'The capacity gate must remain protected by the staging environment.',
);
assert.match(
  String(imageJobs['managed-kubernetes-capacity-gate'].if),
  /workflow_dispatch.*run_managed_kubernetes_capacity_gate.*true/,
  'The capacity gate must run only when manually requested.',
);
assert.equal(
  imageJobs['managed-kubernetes-capacity-gate'].env?.RIVET_K8S_CAPACITY_GATE_CONFIRM,
  'certify-staging',
  'The capacity gate must supply its exact staging acknowledgement.',
);
assert.equal(
  imageJobs['managed-kubernetes-capacity-gate'].env?.RIVET_K8S_CAPACITY_GATE_MODE,
  'certify',
  'The CI capacity gate must issue a real certificate rather than observations only.',
);
assert.match(
  String(
    findStep(
      imageJobs['managed-kubernetes-capacity-gate'],
      'Certify Published Endpoint Capacity',
      'Managed Kubernetes capacity gate',
    ).run,
  ),
  /studio-server:verify:kubernetes:managed-capacity/,
  'The capacity gate must run the canonical bounded published-endpoint command.',
);
assert.equal(
  findStep(
    imageJobs['managed-kubernetes-capacity-gate'],
    'Upload Published Capacity Evidence',
    'Managed Kubernetes capacity gate',
  ).with?.name,
  'managed-kubernetes-capacity-gate-${{ github.run_id }}-${{ github.run_attempt }}',
  'Capacity evidence must remain distinct per workflow attempt.',
);
assert.match(
  promotionCondition,
  /needs\.managed-kubernetes-capacity-gate\.result/,
  'Image promotion must depend on an explicitly requested capacity certificate.',
);
assert.ok(
  imageJobs['managed-kubernetes-evaluation-gate'],
  'Image workflow must expose the protected hosted-Evaluation certificate.',
);
assert.match(
  String(imageJobs['managed-kubernetes-provider-gate'].if),
  /run_managed_kubernetes_evaluation_gate/,
  'The provider gate must deploy immutable candidate images before the hosted-Evaluation certificate runs.',
);
assert.deepEqual(
  asArray(imageJobs['managed-kubernetes-evaluation-gate'].needs),
  ['build-and-push', 'managed-kubernetes-provider-gate', 'managed-kubernetes-capacity-gate'],
  'The hosted-Evaluation certificate must wait for the provider gate and any selected capacity certificate.',
);
assert.match(
  String(imageJobs['managed-kubernetes-evaluation-gate'].if),
  /always\(\)[\s\S]*run_managed_kubernetes_evaluation_gate[\s\S]*managed-kubernetes-capacity-gate\.result == 'success'[\s\S]*managed-kubernetes-capacity-gate\.result == 'skipped'/,
  'The hosted-Evaluation certificate must run after a selected capacity gate but still run when capacity was not requested.',
);
assert.equal(
  imageJobs['managed-kubernetes-evaluation-gate'].environment?.name,
  'rivet-managed-staging',
  'The hosted-Evaluation certificate must remain protected by the staging environment.',
);
for (const jobName of [
  'managed-kubernetes-provider-gate',
  'managed-kubernetes-capacity-gate',
  'managed-kubernetes-evaluation-gate',
]) {
  assert.equal(
    imageJobs[jobName].concurrency?.group,
    'rivet-managed-staging-certificates',
    `${jobName} must share the exclusive protected-staging mutation lock.`,
  );
  assert.equal(
    imageJobs[jobName].concurrency?.['cancel-in-progress'],
    false,
    `${jobName} must never cancel an in-flight protected staging certificate.`,
  );
}
assert.equal(
  imageJobs['managed-kubernetes-evaluation-gate'].env?.RIVET_K8S_EVALUATION_GATE_CONFIRM,
  'disrupt-staging-evaluations',
  'The hosted-Evaluation certificate must supply its exact disruption acknowledgement.',
);
assert.match(
  String(
    findStep(
      imageJobs['managed-kubernetes-evaluation-gate'],
      'Certify Hosted Evaluation Durability',
      'Managed Kubernetes hosted-Evaluation gate',
    ).run,
  ),
  /studio-server:verify:kubernetes:managed-evaluations/,
  'The hosted-Evaluation certificate must run the canonical durable worker-loss command.',
);
assert.equal(
  findStep(
    imageJobs['managed-kubernetes-evaluation-gate'],
    'Upload Hosted Evaluation Evidence',
    'Managed Kubernetes hosted-Evaluation gate',
  ).with?.name,
  'managed-kubernetes-evaluation-gate-${{ github.run_id }}-${{ github.run_attempt }}',
  'Hosted-Evaluation evidence must remain distinct per workflow attempt.',
);
assert.match(
  promotionCondition,
  /needs\.managed-kubernetes-evaluation-gate\.result/,
  'Image promotion must depend on an explicitly requested hosted-Evaluation certificate.',
);

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
for (const [jobName, stepName] of [
  ['build-windows', 'Upload Windows bundles'],
  ['build-macos', 'Upload macOS bundles'],
  ['build-docs', 'Upload documentation site'],
]) {
  assert.equal(
    findStep(reusableJobs[jobName], stepName, `${jobName} job`).with?.overwrite,
    true,
    `${jobName} must replace its immutable artifact when the build job is re-run.`,
  );
}
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
