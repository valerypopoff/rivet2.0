import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { planInstalledUpgrade } from './lib/installed-upgrade-plan.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  HA_REQUIRED_CHECKS,
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_COOPERATIVE_AUTOSCALING_CHECKS,
} from './lib/ha-release-evidence.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  createProductionHelmValues,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (manifest) => getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
function release(letter, predecessorRelease = null) {
  return promoteStudioServerReleaseManifest(
    createStudioServerReleaseManifest({
      rootDir,
      source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: letter.repeat(40) },
      images: Object.fromEntries(
        ['api', 'executor', 'proxy', 'web'].map((role) => [
          role,
          { repository: `example/${role}`, digest: `sha256:${letter.repeat(64)}` },
        ]),
      ),
      predecessorRelease,
      candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    }),
    { promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 } },
  );
}
test('plans from installed A through B to C even when the publication pointer already advanced', async () => {
  const a = release('a'),
    b = release('b', a),
    c = release('c', b),
    reads = [];
  const plan = await planInstalledUpgrade({
    candidate: c,
    installed: createProductionHelmValues(a),
    fetchManifest: async (key) => {
      reads.push(key);
      return b;
    },
  });
  assert.equal(plan.status, 'qualified-route');
  assert.deepEqual(
    plan.steps.map((step) => step.manifestDigest),
    [digest(b), digest(c)],
  );
  assert.deepEqual(reads, [digest(b)]);
  assert.equal(plan.installedDigest, digest(a));
});
test('direct and already-installed routes do not consult a mutable publication pointer', async () => {
  const a = release('a'),
    b = release('b', a);
  const fetchManifest = () => assert.fail('No predecessor fetch is necessary');
  assert.equal(
    (await planInstalledUpgrade({ candidate: b, installed: createProductionHelmValues(a), fetchManifest })).steps
      .length,
    1,
  );
  assert.equal(
    (await planInstalledUpgrade({ candidate: a, installed: createProductionHelmValues(a), fetchManifest })).status,
    'already-installed',
  );
});
test('unrelated, corrupted or excessively long lineage cannot become an approved route', async () => {
  const a = release('a'),
    b = release('b'),
    c = release('c', b);
  assert.equal(
    (await planInstalledUpgrade({ candidate: b, installed: createProductionHelmValues(a) })).status,
    'qualification-required',
  );
  await assert.rejects(
    planInstalledUpgrade({ candidate: c, installed: createProductionHelmValues(a), fetchManifest: async () => a }),
    /digest/,
  );
  await assert.rejects(
    planInstalledUpgrade({
      candidate: c,
      installed: createProductionHelmValues(a),
      fetchManifest: async () => b,
      maximumHops: 1,
    }),
    /bounded/,
  );
});
test('a lineage path alone cannot waive HA compatibility evidence', async () => {
  const a = release('a'),
    b = release('b', a);
  const installed = { ...createProductionHelmValues(a), ha: { enabled: true } };
  const plan = await planInstalledUpgrade({ candidate: b, installed });
  assert.equal(plan.status, 'qualification-required');
  assert.match(plan.reason, /evidence|certificate/);
});

test('unknown installed readers never produce a qualified route or an already-installed success', async () => {
  const a = release('a'),
    b = release('b', a);
  for (const schema of [undefined, null, '15', NaN, 0, -1, 1.5]) {
    const installed = createProductionHelmValues(a);
    installed.release.production.database.managedWorkflowSchemaVersion = schema;
    for (const candidate of [a, b]) {
      const plan = await planInstalledUpgrade({
        candidate,
        installed,
        fetchManifest: () => assert.fail('Unknown readers must fail before registry traversal'),
      });
      assert.equal(plan.status, 'maintenance-required');
      assert.deepEqual(plan.steps, []);
      assert.match(plan.reason, /schema reader version is unknown or invalid/);
    }
  }
});

test('a matching manifest digest cannot conceal conflicting installed schema metadata', async () => {
  const candidate = release('a');
  const installed = createProductionHelmValues(candidate);
  installed.release.production.database.managedWorkflowSchemaVersion =
    candidate.database.managedWorkflowSchema.version + 1;
  const plan = await planInstalledUpgrade({
    candidate,
    installed,
    fetchManifest: () => assert.fail('No registry traversal can resolve conflicting installed metadata'),
  });
  assert.equal(plan.status, 'maintenance-required');
  assert.deepEqual(plan.steps, []);
  assert.match(plan.reason, /schema metadata disagrees/);
});

test('ordinary installed-to-candidate planning cannot require or authorize historical topology conversions', async () => {
  const a = release('a'),
    b = release('b', a);
  const browserContract = { protocol: 2, baseline: { sourceSha: a.source.sha, image: a.images.web } };
  const policyDigest = autoscalerPolicyDigest({});
  const common = {
    candidateSourceSha: b.source.sha,
    candidateImages: b.images,
    chartDigest: b.chart.contentDigest,
    requestSamples: 100,
    failedRequests: 0,
  };
  b.evidence.ha = {
    ...common,
    protocol: 3,
    mode: 'mixed',
    browserContract,
    checks: [...HA_REQUIRED_CHECKS],
    predecessorSourceSha: a.source.sha,
    predecessorImages: a.images,
  };
  b.evidence.runtimeControl = {
    ...common,
    protocol: 2,
    purpose: 'ordinary-upgrade',
    controlPlaneMode: 'singleton',
    edgeProfiles: ['compact'],
    predecessorSourceSha: a.source.sha,
    predecessorImages: a.images,
    predecessorManifestDigest: digest(a),
    autoscalerPolicyDigest: policyDigest,
    checks: [...HA_ORDINARY_RUNTIME_CHECKS],
  };
  b.evidence.runtimeAutoscaling = {
    ...common,
    protocol: 2,
    provider: 'gke',
    policyDigest,
    checks: [...HA_COOPERATIVE_AUTOSCALING_CHECKS],
  };
  const installed = {
    ...createProductionHelmValues(a),
    ha: { enabled: true, controlPlane: { mode: 'singleton' } },
    availability: { gkeGatewayProfile: 'compact' },
    replicaCount: { backend: 1, web: 1, proxy: 2, execution: 2 },
    autoscaling: {
      executionController: { enabled: true },
      execution: { enabled: false, minReplicas: 2 },
      proxy: { enabled: true, minReplicas: 2, maxReplicas: 4 },
    },
  };
  installed.release.production.browserContract = browserContract;
  assert.equal((await planInstalledUpgrade({ candidate: b, installed })).status, 'qualified-route');
  for (const altered of [
    { ...installed, availability: { gkeGatewayProfile: 'regional' } },
    { ...installed, ha: { enabled: true, controlPlane: { mode: 'singleton-overlap' } } },
    {
      ...installed,
      autoscaling: { ...installed.autoscaling, execution: { ...installed.autoscaling.execution, maxReplicas: 9 } },
    },
  ])
    assert.equal((await planInstalledUpgrade({ candidate: b, installed: altered })).status, 'qualification-required');
  delete b.evidence.runtimeAutoscaling;
  assert.equal((await planInstalledUpgrade({ candidate: b, installed })).status, 'qualification-required');
});
