import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const REQUEST_CONTINUITY_CHECKS = [
  'full-body-300-second-requests',
  'full-body-duration-matrix',
  'bridge-return-handoff',
  'late-admission-and-connection-reuse',
  'proxy-pod-and-neg-replacement',
  'proxy-hpa-removal',
  'execution-owner-300-second-drain',
  'accepted-action-resume',
  'request-recording-and-no-duplicates',
];
export const CONTINUITY_DURATION_STAGES = {
  'duration-60': 60000,
  'duration-180': 180000,
  'duration-295': 295000,
};
export const FOCUSED_CONTINUITY_CHECKS = REQUEST_CONTINUITY_CHECKS.filter(
  (check) => !['full-body-duration-matrix', 'bridge-return-handoff', 'proxy-hpa-removal'].includes(check),
);
export function continuityStages(adopted, kind, tier = 'full') {
  if (tier === 'focused') {
    assert.equal(adopted, true, 'Focused qualification cannot adopt request continuity');
    return kind === 'upgrade' ? ['late-admission', 'execution-retirement', 'protected-roll'] : [];
  }
  assert.equal(tier, 'full');
  return kind === 'upgrade'
    ? [
        'late-admission',
        'execution-retirement',
        'protected-roll',
        ...Object.keys(CONTINUITY_DURATION_STAGES),
        ...(!adopted ? ['policy-adoption', 'bootstrap', 'return-handoff'] : []),
      ]
    : ['hpa-removal'];
}
// A route handoff needs the complete request lifetime after a propagation
// allowance. The LB drain timeout is a ceiling, not a mandatory quiet wait.
export const continuityHandoffSeconds = (profile) => {
  assertRequestContinuityProfile(profile);
  return profile.maxProtectedRequestSeconds + profile.propagationSeconds;
};
export function continuityTimeoutMs(profile) {
  assertRequestContinuityProfile(profile);
  const timeout = Math.max(
    1200000,
    (Math.max(
      profile.backendServiceDrainSeconds,
      profile.propagationSeconds,
      profile.proxyTerminationGracePeriodSeconds,
    ) +
      300) *
      1000,
  );
  assert.ok(Number.isSafeInteger(timeout), 'Continuity deadline exceeds safe timer range');
  return timeout;
}
const profileKeys = [
  'protocol',
  'maxProtectedRequestSeconds',
  'backendServiceDrainSeconds',
  'propagationSeconds',
  'proxyPreStopDelaySeconds',
  'proxyTerminationGracePeriodSeconds',
];
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
export function assertRequestContinuityProfile(profile, shutdownSeconds = 120) {
  assert.ok(profile && typeof profile === 'object' && !Array.isArray(profile), 'Request continuity profile missing');
  assert.deepEqual(Object.keys(profile).sort(), [...profileKeys].sort(), 'Unknown or missing continuity fields');
  assert.ok(
    profileKeys.every((key) => whole(profile[key])),
    'Continuity values must be safe whole numbers',
  );
  assert.equal(profile.protocol, 1);
  assert.equal(profile.maxProtectedRequestSeconds, 300);
  assert.ok(profile.backendServiceDrainSeconds >= 600 && profile.backendServiceDrainSeconds <= 3600);
  assert.ok(profile.propagationSeconds >= 60);
  assert.ok(profile.proxyPreStopDelaySeconds >= profile.backendServiceDrainSeconds + profile.propagationSeconds);
  assert.ok(whole(shutdownSeconds) && shutdownSeconds > 0);
  assert.ok(profile.proxyTerminationGracePeriodSeconds >= profile.proxyPreStopDelaySeconds + shutdownSeconds + 25);
  return structuredClone(profile);
}
export function requestContinuityProfile(values) {
  if (values.requestContinuity === undefined) return undefined;
  assert.equal(typeof values.requestContinuity.enabled, 'boolean');
  if (!values.requestContinuity.enabled) return undefined;
  const c = values.requestContinuity,
    l = values.lifecycle;
  const override = (key) => (l.proxy && Object.hasOwn(l.proxy, key) ? l.proxy[key] : l[key]);
  return assertRequestContinuityProfile(
    {
      protocol: 1,
      maxProtectedRequestSeconds: c.maxProtectedRequestSeconds,
      backendServiceDrainSeconds: c.backendServiceDrainSeconds,
      propagationSeconds: c.propagationSeconds,
      proxyPreStopDelaySeconds: override('preStopDelaySeconds'),
      proxyTerminationGracePeriodSeconds: override('terminationGracePeriodSeconds'),
    },
    l.shutdownGraceSeconds,
  );
}
export function continuityFromResources(resources) {
  const configs = resources.filter(
    (r) => r.kind === 'ConfigMap' && r.metadata.labels?.['app.kubernetes.io/component'] === 'request-continuity',
  );
  assert.ok(configs.length <= 1, 'Duplicate request continuity configuration');
  if (!configs.length) return undefined;
  const profile = assertRequestContinuityProfile(JSON.parse(configs[0].data.profile));
  const network = JSON.parse(configs[0].data.network);
  const keys = ['routeName', 'backendPolicyName', 'gatewayName', 'gcpProject', 'gcpRegion'];
  assert.deepEqual(Object.keys(network).sort(), keys.sort());
  assert.ok(
    Object.values(network).every((v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(v)),
    'Explicit network identity required',
  );
  const proxy = resources.find(
    (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === 'proxy',
  );
  assert.ok(proxy, 'Continuity proxy Deployment missing');
  assertProtectedProxyTemplate(proxy.spec.template, profile);
  return { profile, network, proxyName: proxy.metadata.name, configName: configs[0].metadata.name };
}
export function assertProtectedProxyTemplate(template, profile) {
  assert.ok(
    template.spec.terminationGracePeriodSeconds >= profile.proxyTerminationGracePeriodSeconds,
    'Proxy pod grace is too short',
  );
  const containers = template.spec.containers;
  assert.ok(
    containers?.length &&
      containers.every((c) => {
        const command = c.lifecycle?.preStop?.exec?.command;
        return (
          command?.length === 3 &&
          command[0] === '/bin/sh' &&
          command[1] === '-c' &&
          /^sleep \d+$/.test(command[2]) &&
          Number(command[2].slice(6)) >= profile.proxyPreStopDelaySeconds
        );
      }),
    'Every proxy container must retain the protected preStop',
  );
}
export function continuityProfileDigest(profile) {
  const normalized = assertRequestContinuityProfile(profile);
  return createHash('sha256')
    .update(JSON.stringify(profileKeys.map((key) => [key, normalized[key]])))
    .digest('hex');
}
export function assertRequestContinuityEvidence(proof, release, profile) {
  assertRequestContinuityProfile(profile);
  assert.ok(
    proof && [2, 3].includes(proof.protocol),
    '300-second request continuity requires complete provider evidence',
  );
  assert.equal(proof.provider, 'gke');
  assert.equal(proof.gatewayClass, 'gke-l7-regional-external-managed');
  assert.equal(proof.candidateSourceSha, release.source.sha);
  assert.deepEqual(proof.candidateImages, release.images);
  assert.equal(proof.chartDigest, release.chart.contentDigest);
  assert.equal(proof.predecessorManifestDigest, release.lineage?.predecessor?.manifestDigest);
  assert.deepEqual(proof.profile, profile);
  assert.equal(proof.profileDigest, continuityProfileDigest(profile));
  assert.equal(proof.failedRequests, 0);
  const focused = proof.protocol === 3;
  assert.ok((focused ? ['already-protected'] : ['passed', 'already-protected']).includes(proof.bootstrap));
  assert.equal(proof.completedRequests, focused ? 9 : proof.bootstrap === 'passed' ? 30 : 21);
  assert.ok(
    Number.isSafeInteger(proof.maximumCompletedDurationMs) &&
      proof.maximumCompletedDurationMs >= 300_000 &&
      proof.maximumCompletedDurationMs <= 330_000,
  );
  assert.deepEqual(
    [...proof.checks].sort(),
    [...(focused ? FOCUSED_CONTINUITY_CHECKS : REQUEST_CONTINUITY_CHECKS)].sort(),
  );
  assert.match(proof.reportSha256, /^[a-f0-9]{64}$/);
  return structuredClone(proof);
}
export function assertContinuityConfiguration(installed, target) {
  const sourceProfile = requestContinuityProfile(installed ?? {});
  if (sourceProfile && target !== undefined)
    assert.ok(target.profile, 'Disabling adopted request continuity requires a separate reviewed transition');
  const profile = target?.profile ?? sourceProfile;
  if (sourceProfile)
    assert.deepEqual(
      sourceProfile,
      profile,
      'Changing an adopted continuity profile requires a new transition contract',
    );
  if (sourceProfile && target?.network)
    for (const [key, value] of Object.entries(target.network))
      assert.equal(
        value,
        installed.requestContinuity[key],
        'Changing adopted ingress identities requires a separate transition',
      );
  return { sourceProfile, profile };
}
export function assertContinuityAcceptance(receipt, profile) {
  assert.deepEqual(receipt.profile, profile);
  assert.equal(receipt.protectedProxies, true, 'Normal proxies have not adopted the protected lifecycle');
  assert.ok(
    receipt.actualBackendServiceDrainSeconds >= profile.backendServiceDrainSeconds,
    'Actual backend drain has regressed',
  );
  assert.ok(
    receipt.policyBackendServiceDrainSeconds >= profile.backendServiceDrainSeconds,
    'Backend policy no longer retains the protected drain',
  );
}

/** Only exact-token recovery may normalize the journal-owned temporary HPA
 * floor for ordinary-layout admission. Raw installed values remain untouched
 * for baseline checks and all live HPA checks still use the frozen spec. */
export function continuityRecoveryLayout(
  installed,
  target,
  { journal, resumeToken, configurationDigest, manifestDigest, release, namespace },
) {
  if (installed?.autoscaling?.proxy?.minReplicas === 2 || !target || !resumeToken || !journal?.proxyContinuity)
    return installed;
  const state = journal.proxyContinuity,
    identity = journal.proxyContinuityIdentity;
  assert.equal(journal.protocol, 1);
  assert.ok(
    ['templates', 'owners'].includes(journal.phase),
    'Only an unfinished template/owner operation can own a stored proxy floor',
  );
  assert.equal(journal.token, resumeToken, 'Temporary proxy floor belongs to another operation');
  assert.equal(journal.release, release);
  assert.equal(journal.namespace, namespace);
  assert.equal(journal.manifestDigest, manifestDigest);
  assert.equal(installed.release.production.manifestDigest, manifestDigest);
  assert.equal(journal.configurationDigest, configurationDigest, 'Proxy floor recovery configuration changed');
  assert.ok(
    typeof state.configurationDigest === 'string' && state.configurationDigest.length > 0,
    'Proxy floor recovery identity missing',
  );
  assert.equal(state.configurationDigest, identity?.configurationDigest);
  assert.equal(identity?.profileDigest, continuityProfileDigest(target.profile));
  assert.equal(state.hpaFreezeIntent, true);
  assert.ok(!state.hpaReleased);
  assert.equal(state.hpa.spec.minReplicas, 2);
  assert.equal(state.hpa.spec.maxReplicas, 4);
  assert.equal(state.bridgeReplicas, 4);
  assert.equal(installed.autoscaling.proxy.minReplicas, 4);
  assert.equal(installed.autoscaling.proxy.maxReplicas, 4);
  assert.equal(installed.autoscaling.proxy.scaleDownPaused, true);
  return {
    ...installed,
    autoscaling: { ...installed.autoscaling, proxy: { ...installed.autoscaling.proxy, minReplicas: 2 } },
  };
}
export function assertContinuityUpgrade(release, installed, target) {
  const { sourceProfile, profile } = assertContinuityConfiguration(installed, target);
  if (!profile) return;
  const proof = release.evidence?.runtimeControl?.requestContinuity;
  assertRequestContinuityEvidence(proof, release, profile);
  const candidateAlreadyInstalled =
    sourceProfile &&
    installed.release?.production?.sourceSha === release.source.sha &&
    Object.entries(release.images).every(
      ([name, image]) =>
        installed.images?.[name]?.repository === image.repository && installed.images[name].digest === image.digest,
    );
  if (!candidateAlreadyInstalled)
    assert.equal(
      proof.bootstrap,
      sourceProfile ? 'already-protected' : 'passed',
      'Continuity predecessor lifecycle does not match the qualification',
    );
}
