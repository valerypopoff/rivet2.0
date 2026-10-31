import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { fileURLToPath } from 'node:url';
import {
  requestContinuityProfile,
  continuityFromResources,
  assertRequestContinuityEvidence,
  continuityProfileDigest,
  REQUEST_CONTINUITY_CHECKS,
  assertContinuityUpgrade,
  assertContinuityConfiguration,
  continuityRecoveryLayout,
  continuityTimeoutMs,
} from './lib/request-continuity.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const values = () => ({
  requestContinuity: {
    enabled: true,
    maxProtectedRequestSeconds: 300,
    backendServiceDrainSeconds: 360,
    propagationSeconds: 60,
  },
  lifecycle: {
    shutdownGraceSeconds: 120,
    preStopDelaySeconds: 120,
    terminationGracePeriodSeconds: 270,
    proxy: { preStopDelaySeconds: 420, terminationGracePeriodSeconds: 600 },
  },
});
test('qualification deadlines retain grace and cleanup headroom for the selected profile', () => {
  const profile = requestContinuityProfile(values());
  assert.equal(continuityTimeoutMs(profile), 1200000);
  assert.equal(continuityTimeoutMs({ ...profile, proxyTerminationGracePeriodSeconds: 1800 }), 2100000);
});

test('only exact owned recovery can admit a temporarily raised proxy floor', () => {
  const profile = requestContinuityProfile(values());
  const installed = {
    release: { production: { manifestDigest: 'candidate' } },
    autoscaling: { proxy: { minReplicas: 4, maxReplicas: 4, scaleDownPaused: true } },
  };
  const context = {
    resumeToken: 'token',
    configurationDigest: 'templates',
    manifestDigest: 'candidate',
    release: 'rivet',
    namespace: 'rivet',
    journal: {
      protocol: 1,
      phase: 'owners',
      token: 'token',
      manifestDigest: 'candidate',
      release: 'rivet',
      namespace: 'rivet',
      configurationDigest: 'templates',
      proxyContinuityIdentity: { configurationDigest: 'ingress', profileDigest: continuityProfileDigest(profile) },
      proxyContinuity: {
        configurationDigest: 'ingress',
        hpaFreezeIntent: true,
        hpaReleased: false,
        bridgeReplicas: 4,
        hpa: { spec: { minReplicas: 2, maxReplicas: 4 } },
      },
    },
  };
  assert.equal(continuityRecoveryLayout(installed, { profile }, context).autoscaling.proxy.minReplicas, 2);
  assert.equal(installed.autoscaling.proxy.minReplicas, 4, 'Raw Helm settings are never rewritten for admission');
  assert.equal(continuityRecoveryLayout(installed, { profile }, { ...context, resumeToken: undefined }), installed);
  for (const change of [
    (c) => {
      c.resumeToken = 'foreign';
    },
    (c) => {
      c.configurationDigest = 'changed';
    },
    (c) => {
      c.journal.phase = 'complete';
    },
    (c) => {
      c.journal.proxyContinuity.hpaReleased = true;
    },
    (c) => {
      c.journal.proxyContinuityIdentity.profileDigest = 'foreign';
    },
    (c) => {
      delete c.journal.proxyContinuity.configurationDigest;
      delete c.journal.proxyContinuityIdentity.configurationDigest;
    },
  ]) {
    const invalid = structuredClone(context);
    change(invalid);
    assert.throws(() => continuityRecoveryLayout(installed, { profile }, invalid));
  }
});
function render(extra = [], enabled = true) {
  const args = [
    'template',
    'continuity',
    'deploy/studio-server/helm',
    '-f',
    'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
    '-f',
    'deploy/studio-server/helm/overlays/gke-ha.yaml',
    '-f',
    'deploy/studio-server/helm/overlays/gke-runtime-ha.yaml',
    '-f',
    'deploy/studio-server/helm/overlays/gke-compact-edge.yaml',
    '-f',
    'deploy/studio-server/helm/overlays/gke-runtime-autoscaling.yaml',
    ...(enabled ? ['-f', 'deploy/studio-server/helm/overlays/gke-proxy-continuity.yaml'] : []),
    '--set',
    'objectStorage.bucket=fixture',
    '--set',
    'postgres.maxConnections=250',
    ...[
      'routeName=fixture-route',
      'backendPolicyName=fixture-policy',
      'gatewayName=fixture-gateway',
      'gcpProject=fixture-project',
      'gcpRegion=europe-central2',
    ].flatMap((x) => ['--set', `requestContinuity.${x}`]),
    ...extra.flatMap((x) => ['--set', x]),
  ];
  return parseAllDocuments(
    execFileSync(resolveHelmBinOrThrow(root), args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
  ).map((d) => d.toJS());
}
test('protected proxy lifecycle renders without extending the other serving tiers', () => {
  const resources = render();
  const baseline = render([], false);
  assert.deepEqual(continuityFromResources(resources).profile, requestContinuityProfile(values()));
  for (const r of resources.filter((x) => ['Deployment', 'StatefulSet'].includes(x.kind))) {
    const proxy = r.metadata.labels['app.kubernetes.io/component'] === 'proxy';
    const previous = baseline.find((b) => b.kind === r.kind && b.metadata.name === r.metadata.name);
    assert.equal(
      r.spec.template.spec.terminationGracePeriodSeconds,
      proxy ? 600 : previous.spec.template.spec.terminationGracePeriodSeconds,
    );
  }
  assert.equal(continuityFromResources(render([], false)), undefined);
  assert.throws(() => render(['requestContinuity.backendServiceDrainSeconds=359']), /LB drain/);
  assert.throws(() => render(['requestContinuity.propagationSeconds=120']), /LB drain/);
  assert.throws(() => render(['lifecycle.proxy.preStopDelaySeconds=419']), /preStop/);
  assert.throws(() => render(['lifecycle.proxy.terminationGracePeriodSeconds=564']), /grace/);
  assert.throws(() => render(['requestContinuity.routeName=']), /installation identity/);
  assert.throws(() => render(['requestContinuity.enabled=banana']), /boolean/);
});
test('incomplete or unsafe timing profiles fail instead of falling back to a shorter global lifecycle', () => {
  for (const change of [
    (v) => {
      v.requestContinuity.backendServiceDrainSeconds = 359;
    },
    (v) => {
      v.requestContinuity.propagationSeconds = 120;
    },
  ]) {
    const v = values();
    change(v);
    assert.throws(() => requestContinuityProfile(v), /LB drain/);
  }
  for (const n of [null, undefined, -1, 0, 0.5, '660', Number.MAX_SAFE_INTEGER + 1]) {
    const v = values();
    v.lifecycle.proxy.preStopDelaySeconds = n;
    assert.throws(() => requestContinuityProfile(v));
  }
  const v = values();
  delete v.lifecycle.proxy;
  assert.throws(() => requestContinuityProfile(v));
  assert.equal(requestContinuityProfile({}), undefined);
});
test('old or mismatched certificates cannot assert 300-second protection', () => {
  const profile = requestContinuityProfile(values());
  const release = {
    source: { sha: 'candidate' },
    images: { proxy: { digest: 'image' } },
    chart: { contentDigest: 'chart' },
    lineage: { predecessor: { manifestDigest: 'previous' } },
    evidence: {},
  };
  const proof = {
    protocol: 2,
    provider: 'gke',
    gatewayClass: 'gke-l7-regional-external-managed',
    candidateSourceSha: 'candidate',
    candidateImages: release.images,
    chartDigest: 'chart',
    predecessorManifestDigest: 'previous',
    profile,
    profileDigest: continuityProfileDigest(profile),
    failedRequests: 0,
    completedRequests: 30,
    maximumCompletedDurationMs: 300000,
    checks: REQUEST_CONTINUITY_CHECKS,
    reportSha256: 'a'.repeat(64),
    bootstrap: 'passed',
  };
  assert.deepEqual(assertRequestContinuityEvidence(proof, release, profile), proof);
  for (const change of [
    { failedRequests: 1 },
    { maximumCompletedDurationMs: 1000 },
    { checks: [] },
    { bootstrap: 'waived' },
    { predecessorManifestDigest: 'other' },
    { reportSha256: 'fake' },
    { profileDigest: 'b'.repeat(64) },
    { protocol: 1 },
  ])
    assert.throws(() => assertRequestContinuityEvidence({ ...proof, ...change }, release, profile));
  assert.throws(() => assertContinuityUpgrade(release, {}, { profile }), /requires complete/);
  release.evidence.runtimeControl = { requestContinuity: proof };
  assert.doesNotThrow(() => assertContinuityUpgrade(release, {}, { profile }));
  const installed = {
    ...values(),
    release: { production: { sourceSha: release.source.sha } },
    images: structuredClone(release.images),
  };
  assert.doesNotThrow(
    () => assertContinuityUpgrade(release, installed, { profile }),
    'The first transition can resume after Helm installs its protected values',
  );
  installed.release.production.sourceSha = 'another-source';
  assert.throws(() => assertContinuityUpgrade(release, installed, { profile }), /predecessor lifecycle/);
  assert.throws(() => assertContinuityUpgrade(release, installed, {}), /Disabling/);
  assert.doesNotThrow(
    () => assertContinuityConfiguration(installed, { profile }),
    'An explicit maintenance operation can retain its adopted timing without an ordinary-upgrade certificate',
  );
});
