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

// This fingerprint binds evidence to the critical source. It does not select
// the duration of the cloud test or imply that earlier stress tests ran again.
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
  assert.ok([1, 2].includes(plan.protocol));
  assert.deepEqual(
    Object.keys(plan).sort(),
    [
      'protocol',
      'tier',
      'safetyDigest',
      'configurationDigest',
      ...(plan.protocol === 1 ? ['fullBaselineManifestDigest'] : []),
    ].sort(),
  );
  assert.ok(['full', 'focused'].includes(plan.tier));
  for (const key of ['safetyDigest', 'configurationDigest']) assert.match(plan[key], /^[a-f0-9]{64}$/);
  if (plan.protocol === 1) {
    if (plan.tier === 'full') assert.equal(plan.fullBaselineManifestDigest, null);
    else assert.match(plan.fullBaselineManifestDigest, /^sha256:[a-f0-9]{64}$/);
  }
  return {
    protocol: plan.protocol,
    tier: plan.tier,
    safetyDigest: plan.safetyDigest,
    configurationDigest: plan.configurationDigest,
    ...(plan.protocol === 1 ? { fullBaselineManifestDigest: plan.fullBaselineManifestDigest } : {}),
  };
}

/** Request continuity is the ordinary release gate, including first adoption.
 * Full autoscaler stress is a separate protected configuration choice; overlap
 * and releases without the bounded continuity contract retain the full suite.
 * Neither tier reuses test results from a predecessor. */
export function releaseQualificationPlan({ safetyDigest, installed, policy, profile, overlap, suite }) {
  assert.match(safetyDigest, /^[a-f0-9]{64}$/);
  assert.ok(suite === undefined || ['focused', 'full'].includes(suite), 'Unknown qualification suite');
  const configurationDigest = qualificationConfigurationDigest(installed, policy, profile, overlap);
  const focused = installed.controlPlaneMode === 'singleton' && !overlap && !!profile && suite !== 'full';
  if (suite === 'focused') assert.ok(focused, 'Focused qualification requires singleton request continuity');
  return assertQualificationPlan({
    protocol: 2,
    tier: focused ? 'focused' : 'full',
    safetyDigest,
    configurationDigest,
  });
}
