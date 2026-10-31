import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

// Deliberately small allowlist. Unknown/server/runtime/dependency/infra changes
// require the full suite. Editing this policy itself also changes the digest.
export function routineSourcePath(file) {
  return ['packages/app/', 'packages/studio-server-web/', 'packages/docs/', 'developer-docs/', 'docs/'].some((prefix) =>
    file.startsWith(prefix),
  );
}

/** Hash committed critical paths, modes and blob IDs after verifying the actual
 * checkout. Git objects make the fingerprint independent of CRLF and sparse UI
 * projections; replacement refs and hidden working changes remain forbidden. */
export async function qualificationSafetyDigest(root, sha) {
  const { verifyActorSource } = await import('../../images/qualification/verify-source.mjs');
  await verifyActorSource(root, sha);
  const tree = execFileSync(
    'git',
    ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'ls-tree', '-rz', '--full-tree', 'HEAD'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const critical = tree
    .split('\0')
    .filter(Boolean)
    .filter((entry) => {
      assert.match(entry, /^\d{6} (?:blob|commit) [a-f0-9]{40}\t/);
      return !routineSourcePath(entry.slice(entry.indexOf('\t') + 1));
    });
  assert.ok(critical.length, 'Critical source inventory is empty');
  return hash(critical);
}

export function qualificationConfigurationDigest(installed, policy, profile, overlap) {
  const values = structuredClone(installed.qualificationValues);
  assert.ok(values?.lifecycle && values.postgres && values.resources);
  if (profile) {
    values.requestContinuity = {
      enabled: true,
      maxProtectedRequestSeconds: profile.maxProtectedRequestSeconds,
      backendServiceDrainSeconds: profile.backendServiceDrainSeconds,
      propagationSeconds: profile.propagationSeconds,
    };
    values.lifecycle.proxy = {
      preStopDelaySeconds: profile.proxyPreStopDelaySeconds,
      terminationGracePeriodSeconds: profile.proxyTerminationGracePeriodSeconds,
    };
  }
  if (overlap) {
    values.postgres.poolMaxPerApiPod = overlap.poolMaxPerApiPod;
    values.resources.backendOverlap = overlap.backendResources;
  }
  return hash({ values, policy, controlPlaneMode: overlap ? 'singleton-overlap' : installed.controlPlaneMode });
}

export function assertQualificationPlan(plan) {
  assert.deepEqual(
    Object.keys(plan).sort(),
    ['protocol', 'tier', 'safetyDigest', 'configurationDigest', 'fullBaselineManifestDigest'].sort(),
  );
  assert.equal(plan.protocol, 1);
  assert.ok(['full', 'focused'].includes(plan.tier));
  for (const key of ['safetyDigest', 'configurationDigest']) assert.match(plan[key], /^[a-f0-9]{64}$/);
  if (plan.tier === 'full') assert.equal(plan.fullBaselineManifestDigest, null);
  else assert.match(plan.fullBaselineManifestDigest, /^sha256:[a-f0-9]{64}$/);
  return {
    protocol: 1,
    tier: plan.tier,
    safetyDigest: plan.safetyDigest,
    configurationDigest: plan.configurationDigest,
    fullBaselineManifestDigest: plan.fullBaselineManifestDigest,
  };
}

/** Select automatically; dispatch inputs cannot waive first adoption or choose
 * a cheaper suite. Every focused release still runs a real mixed-image upgrade.
 * Its certificate describes current observations, never invented chaos passes. */
export function releaseQualificationPlan({
  safetyDigest,
  previous,
  predecessorDigest,
  candidate,
  installed,
  policy,
  profile,
  overlap,
}) {
  assert.match(safetyDigest, /^[a-f0-9]{64}$/);
  const configurationDigest = qualificationConfigurationDigest(installed, policy, profile, overlap);
  const prior = previous.evidence?.runtimeControl;
  const basis = prior?.qualification;
  if (basis) assertQualificationPlan(basis);
  const scaling = previous.evidence?.runtimeAutoscaling;
  const focused =
    !overlap &&
    !!installed.qualificationValues.requestContinuity?.enabled &&
    !!profile &&
    [2, 4].includes(prior?.protocol) &&
    [2, 3].includes(previous.evidence?.runtimeAutoscaling?.protocol) &&
    JSON.stringify(canonical(basis)) === JSON.stringify(canonical(scaling?.qualification)) &&
    (basis?.tier === 'focused'
      ? prior.protocol === 4 && scaling.protocol === 3
      : prior.protocol === 2 && scaling.protocol === 2) &&
    basis?.safetyDigest === safetyDigest &&
    basis?.configurationDigest === configurationDigest &&
    candidate.chart.contentDigest === previous.chart.contentDigest &&
    candidate.database.managedWorkflowSchema.version === previous.database.managedWorkflowSchema.version &&
    JSON.stringify(canonical(prior.requestContinuity?.profile)) === JSON.stringify(canonical(profile));
  return assertQualificationPlan({
    protocol: 1,
    tier: focused ? 'focused' : 'full',
    safetyDigest,
    configurationDigest,
    fullBaselineManifestDigest: focused
      ? basis.tier === 'full'
        ? predecessorDigest
        : basis.fullBaselineManifestDigest
      : null,
  });
}
