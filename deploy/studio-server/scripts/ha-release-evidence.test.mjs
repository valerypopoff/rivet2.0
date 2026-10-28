import test from 'node:test';
import assert from 'node:assert/strict';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  assertHaReleaseEvidence,
  assertHaUpgradeEvidence,
  createHaReleaseEvidence,
  HA_REQUIRED_CHECKS,
  HA_BROWSER_CONTRACT,
  selectHaBrowserContract,
  assertRuntimeControlEvidence,
  HA_RUNTIME_CONTROL_CHECKS,
  HA_COMPACT_EDGE_CHECKS,
  HA_ORDINARY_RUNTIME_CHECKS,
  assertOrdinaryRuntimeLayout,
} from './lib/ha-release-evidence.mjs';

test('full-HA receipts cannot authorize singleton control; its qualification binds the exact image pair and chart', () => {
  const f = fixture();
  assert.throws(() => assertRuntimeControlEvidence(undefined, f.release), /own exact mixed-image/);
  const proof = {
    protocol: 1,
    candidateSourceSha: f.release.source.sha,
    candidateImages: f.release.images,
    chartDigest: f.release.chart.contentDigest,
    predecessorSourceSha: f.release.lineage.predecessor.sourceSha,
    predecessorImages: f.release.lineage.predecessor.images,
    failedRequests: 0,
    requestSamples: 150,
    checks: [...HA_RUNTIME_CONTROL_CHECKS],
  };
  assert.deepEqual(assertRuntimeControlEvidence(proof, f.release), proof);
  for (const change of [
    { failedRequests: 1 },
    { requestSamples: 99 },
    { candidateImages: images('c') },
    { predecessorImages: images('c') },
    { chartDigest: 'wrong' },
    { checks: proof.checks.slice(1) },
    { checks: proof.checks.filter((c) => c !== 'embedded-maintenance-capacity') },
  ])
    assert.throws(() => assertRuntimeControlEvidence({ ...proof, ...change }, f.release));
});
const images = (x) =>
  Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((name) => [
      name,
      { repository: `registry/${name}`, digest: `sha256:${x.repeat(64)}` },
    ]),
  );

test('routine evidence binds the seven-pod source layout and never grants adoption or developer overlap', () => {
  const f = fixture();
  f.release.lineage.predecessor.manifestDigest = 'sha256:' + 'd'.repeat(64);
  const proof = {
    protocol: 2,
    purpose: 'ordinary-upgrade',
    controlPlaneMode: 'singleton',
    candidateSourceSha: f.release.source.sha,
    candidateImages: f.release.images,
    chartDigest: f.release.chart.contentDigest,
    predecessorSourceSha: f.release.lineage.predecessor.sourceSha,
    predecessorImages: f.release.lineage.predecessor.images,
    predecessorManifestDigest: f.release.lineage.predecessor.manifestDigest,
    autoscalerPolicyDigest: autoscalerPolicyDigest({}),
    edgeProfiles: ['compact'],
    requestSamples: 150,
    failedRequests: 0,
    checks: [...HA_ORDINARY_RUNTIME_CHECKS],
  };
  assert.deepEqual(assertRuntimeControlEvidence(proof, f.release, 'compact'), proof);
  const values = {
    ha: { enabled: true, controlPlane: { mode: 'singleton' } },
    availability: { gkeGatewayProfile: 'compact' },
    replicaCount: { backend: 1, web: 1, proxy: 2, execution: 2 },
    autoscaling: {
      executionController: { enabled: true },
      execution: { enabled: false, minReplicas: 2 },
      proxy: { enabled: true, minReplicas: 2, maxReplicas: 4 },
    },
  };
  assert.doesNotThrow(() => assertOrdinaryRuntimeLayout(proof, values, proof.autoscalerPolicyDigest));
  assert.doesNotThrow(() =>
    assertOrdinaryRuntimeLayout(
      proof,
      { ...values, replicaCount: { ...values.replicaCount, proxy: 4, execution: 7 } },
      proof.autoscalerPolicyDigest,
    ),
  );
  assert.throws(() => assertRuntimeControlEvidence(proof, f.release, 'regional'), /edge profile/);
  assert.throws(() => assertRuntimeControlEvidence(proof, f.release, 'compact', true), /overlap/);
  for (const change of [
    { purpose: 'adoption' },
    { predecessorManifestDigest: 'wrong' },
    { failedRequests: 1 },
    { checks: [...HA_RUNTIME_CONTROL_CHECKS, ...HA_COMPACT_EDGE_CHECKS] },
  ])
    assert.throws(() => assertRuntimeControlEvidence({ ...proof, ...change }, f.release, 'compact'));
  for (const change of [
    { ha: { enabled: true, controlPlane: { mode: 'replicated' } } },
    { replicaCount: { ...values.replicaCount, proxy: 6 } },
    { autoscaling: { executionController: { enabled: false } } },
  ])
    assert.throws(() => assertOrdinaryRuntimeLayout(proof, { ...values, ...change }, proof.autoscalerPolicyDigest));
  assert.throws(() => assertOrdinaryRuntimeLayout(proof, values, 'f'.repeat(64)), /policy changes/);
});

test('compact edge requires explicit profile-bound mixed-image, roll, eviction and transition evidence', () => {
  const { release } = fixture();
  const proof = {
    protocol: 1,
    candidateSourceSha: release.source.sha,
    candidateImages: release.images,
    chartDigest: release.chart.contentDigest,
    predecessorSourceSha: release.lineage.predecessor.sourceSha,
    predecessorImages: release.lineage.predecessor.images,
    failedRequests: 0,
    requestSamples: 150,
    checks: [...HA_RUNTIME_CONTROL_CHECKS],
  };
  assert.throws(() => assertRuntimeControlEvidence(proof, release, 'compact'), /edge profile/);
  const compact = {
    ...proof,
    edgeProfiles: ['regional', 'compact'],
    checks: [...proof.checks, ...HA_COMPACT_EDGE_CHECKS],
  };
  assert.deepEqual(assertRuntimeControlEvidence(compact, release, 'compact'), compact);
  assert.doesNotThrow(() => assertRuntimeControlEvidence(compact, release, 'regional'));
  for (const change of [
    { edgeProfiles: ['typo'] },
    { edgeProfiles: ['compact', 'compact'] },
    { edgeProfiles: [] },
    { checks: proof.checks },
    { checks: compact.checks.slice(0, -1) },
  ])
    assert.throws(() => assertRuntimeControlEvidence({ ...compact, ...change }, release, 'compact'));
});

test('leaving a compact installation still needs compact mixed-image qualification before rollout', () => {
  const f = fixture();
  f.installed.availability = { gkeGateway: true, gkeGatewayProfile: 'compact' };
  const proof = {
    protocol: 1,
    candidateSourceSha: f.release.source.sha,
    candidateImages: f.release.images,
    chartDigest: f.release.chart.contentDigest,
    predecessorSourceSha: f.release.lineage.predecessor.sourceSha,
    predecessorImages: f.release.lineage.predecessor.images,
    failedRequests: 0,
    requestSamples: 150,
    checks: [...HA_RUNTIME_CONTROL_CHECKS],
  };
  f.release.evidence.runtimeControl = proof; // regional-only, even if destination restores six proxies
  assert.throws(() => assertHaUpgradeEvidence(f.release, f.installed), /edge profile/);
  const sameImageInstalled = {
    ...f.installed,
    images: f.release.images,
    release: { production: { ...f.installed.release.production, sourceSha: f.release.source.sha } },
  };
  assert.throws(() => assertHaUpgradeEvidence(f.release, sameImageInstalled), /edge profile/);
  f.release.evidence.runtimeControl = {
    ...proof,
    edgeProfiles: ['regional', 'compact'],
    checks: [...proof.checks, ...HA_COMPACT_EDGE_CHECKS],
  };
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, f.installed));
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, sameImageInstalled));
});
function fixture() {
  const release = {
    source: { sha: 'b'.repeat(40) },
    images: images('b'),
    chart: { contentDigest: `sha256:${'c'.repeat(64)}` },
    database: { managedWorkflowSchema: { version: 18 } },
    lineage: { predecessor: { sourceSha: 'a'.repeat(40), images: images('a'), managedWorkflowSchemaVersion: 18 } },
  };
  const evidence = {
    protocol: 3,
    browserContract: { protocol: HA_BROWSER_CONTRACT, baseline: { sourceSha: 'a'.repeat(40), image: images('a').web } },
    mode: 'mixed',
    candidateSourceSha: release.source.sha,
    candidateImages: release.images,
    chartDigest: release.chart.contentDigest,
    requestSamples: 150,
    failedRequests: 0,
    checks: [...HA_REQUIRED_CHECKS],
    predecessorSourceSha: release.lineage.predecessor.sourceSha,
    predecessorImages: release.lineage.predecessor.images,
  };
  return {
    release: { ...release, evidence: { ha: evidence } },
    evidence,
    installed: {
      ha: { enabled: true },
      release: {
        production: {
          sourceSha: release.lineage.predecessor.sourceSha,
          browserContract: evidence.browserContract,
          database: { managedWorkflowSchemaVersion: 18 },
        },
      },
      images: images('a'),
    },
  };
}
test('schema-changing rolling releases require exact mixed-repository and bounded-lock evidence', () => {
  const f = fixture();
  f.installed.release.production.database.managedWorkflowSchemaVersion = 17;
  f.release.lineage.predecessor.managedWorkflowSchemaVersion = 17;
  assert.throws(() => assertHaUpgradeEvidence(f.release, f.installed), /schema compatibility evidence/);
  const runId = 'a'.repeat(32);
  f.release.evidence.ha.schemaCompatibility = {
    protocol: 1,
    from: 17,
    to: 18,
    runId,
    predecessorApi: images('a').api,
    candidateApi: images('b').api,
    lockContention: true,
    repositories: [
      ['previous', 17],
      ['candidate', 18],
    ].map(([role, version]) => ({ role, version, runId, rounds: 2, peerRowsRead: 2 })),
  };
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, f.installed));
  const valid = structuredClone(f.release.evidence.ha.schemaCompatibility);
  assert.throws(() => createHaReleaseEvidence({}, f.release, 'mixed'), /schema compatibility evidence/);
  assert.throws(() => createHaReleaseEvidence({ schemaCompatibility: valid }, f.release, 'mixed'), /no certificate/);
  for (const change of [
    { lockContention: false },
    { candidateApi: images('a').api },
    { predecessorApi: images('b').api },
    { repositories: [valid.repositories[0], valid.repositories[0]] },
    { repositories: valid.repositories.map((r) => ({ ...r, rounds: 1 })) },
  ]) {
    f.release.evidence.ha.schemaCompatibility = { ...valid, ...change };
    assert.throws(() => assertHaUpgradeEvidence(f.release, f.installed));
  }
});
test('HA certificates bind source, all immutable images, chart, checks and exact installed predecessor', () => {
  const f = fixture();
  assert.equal(assertHaReleaseEvidence(f.evidence, f.release).mode, 'mixed');
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, f.installed));
  for (const change of [
    { candidateSourceSha: 'c'.repeat(40) },
    { predecessorSourceSha: 'c'.repeat(40) },
    { candidateImages: images('c') },
    { predecessorImages: images('c') },
    { failedRequests: 1 },
    { chartDigest: `sha256:${'d'.repeat(64)}` },
    { requestSamples: 99 },
    { checks: HA_REQUIRED_CHECKS.join(',') },
    { checks: [...HA_REQUIRED_CHECKS, HA_REQUIRED_CHECKS[0]] },
  ])
    assert.throws(() => assertHaReleaseEvidence({ ...f.evidence, ...change }, f.release));
  assert.throws(
    () => assertHaUpgradeEvidence(f.release, { ...f.installed, images: images('c') }),
    /Installed images differ/,
  );
});
test('bootstrap evidence never authorizes an uncertified rolling conversion or mixed update', () => {
  const f = fixture();
  f.release.evidence.ha = { ...f.evidence, mode: 'bootstrap' };
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, null));
  assert.throws(() => assertHaUpgradeEvidence(f.release, { ha: { enabled: false } }), /maintenance cutover/);
  assert.throws(() => assertHaUpgradeEvidence(f.release, f.installed), /No mixed-version certificate/);
});

test('historical HA evidence remains readable but cannot authorize browser-continuous deployment', () => {
  const f = fixture();
  const legacy = {
    ...f.evidence,
    protocol: 1,
    checks: f.evidence.checks.filter(
      (check) =>
        !['browser-version-continuity', 'retained-browser-workflow', 'oldest-browser-compatibility'].includes(check),
    ),
  };
  assert.equal(assertHaReleaseEvidence(legacy, f.release).protocol, 1);
  assert.throws(
    () => assertHaUpgradeEvidence({ ...f.release, evidence: { ha: legacy } }, f.installed),
    /v3 release certificate/,
  );
  assert.throws(() => assertHaReleaseEvidence({ ...legacy, protocol: 3 }, f.release), /incomplete/);
  const v2 = {
    ...f.evidence,
    protocol: 2,
    checks: f.evidence.checks.filter(
      (check) => !['retained-browser-workflow', 'oldest-browser-compatibility'].includes(check),
    ),
  };
  assert.equal(assertHaReleaseEvidence(v2, f.release).protocol, 2);
  assert.throws(
    () => assertHaUpgradeEvidence({ ...f.release, evidence: { ha: v2 } }, f.installed),
    /v3 release certificate/,
  );
});

test('same-source HA reconfiguration still requires the exact certified image set', () => {
  const f = fixture();
  const installed = {
    ha: { enabled: true },
    release: {
      production: {
        sourceSha: f.release.source.sha,
        browserContract: f.evidence.browserContract,
        database: { managedWorkflowSchemaVersion: 18 },
      },
    },
    images: f.release.images,
  };
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, installed));
  assert.throws(
    () => assertHaUpgradeEvidence(f.release, { ...installed, images: images('c') }),
    /Same-source HA images differ/,
  );
});

test('a rebuilt source still requires real old/new artifact qualification, never a source-only shortcut', () => {
  const f = fixture();
  f.release.lineage.predecessor.sourceSha = f.release.source.sha;
  f.release.evidence.ha.predecessorSourceSha = f.release.source.sha;
  f.installed.release.production.sourceSha = f.release.source.sha;
  assert.doesNotThrow(() => assertHaUpgradeEvidence(f.release, f.installed));
  f.release.lineage.predecessor.images = f.release.images;
  f.release.evidence.ha.predecessorImages = f.release.images;
  assert.throws(() => assertHaReleaseEvidence(f.release.evidence.ha, f.release), /exact predecessor/);
});

test('certificate production requires actual workload receipts, readiness and exact UID replacements', () => {
  const f = fixture();
  const before = ['backend', 'backend', 'execution', 'execution', 'maintenance'].map((role, i) => ({
    metadata: {
      name: `${role}-${i}`,
      uid: `old-${i}`,
      labels: { 'app.kubernetes.io/component': role },
    },
    spec: {
      containers: [
        {
          name: 'backend',
          image: `${f.release.lineage.predecessor.images.api.repository}@${f.release.lineage.predecessor.images.api.digest}`,
        },
      ],
    },
  }));
  before.push({
    metadata: { name: 'web', uid: 'old-web', labels: { 'app.kubernetes.io/component': 'web' } },
    spec: {
      containers: [
        {
          name: 'web',
          image: `${f.release.lineage.predecessor.images.web.repository}@${f.release.lineage.predecessor.images.web.digest}`,
        },
      ],
    },
  });
  const report = {
    browserContract: f.evidence.browserContract,
    samples: 150,
    failures: [],
    readiness: [{ ready: 2 }, { ready: 3 }],
    rollout: { phase: 'complete' },
    before,
    recovery: {
      samples: 100,
      failures: [],
      lostAcknowledgement: { passed: true, beginCommands: 1 },
      leaseLoss: { passed: true, beginCommands: 1, conflictObserved: true },
    },
    after: before.map((p, i) => ({
      metadata: { ...p.metadata, uid: `new-${i}` },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
      spec: {
        containers:
          p.metadata.name === 'web'
            ? [{ name: 'web', image: `${f.release.images.web.repository}@${f.release.images.web.digest}` }]
            : [{ name: 'backend', image: `${f.release.images.api.repository}@${f.release.images.api.digest}` }],
      },
    })),
    workloads: {
      browser: {
        passed: true,
        originalBuild: 'a'.repeat(64),
        candidateBuild: 'b'.repeat(64),
        reloads: 0,
        iframeReloads: 0,
        lazyScreen: true,
        pinnedEditor: true,
        oldWebPodsRemoved: true,
        unsavedEdit: true,
        savedByCandidate: true,
        newRun: true,
        outputs: true,
        recordingOpened: true,
        recordingIds: ['one', 'two'],
      },
      bundleVerified: true,
      folderNotifications: {
        directions: ['local-to-peer', 'peer-to-local'].map((direction) => ({
          direction,
          tree: true,
          library: true,
          revision: 1,
        })),
      },
      notifications: [0, 1].map((i) => ({
        pod: `backend-${i}`,
        uid: `old-${i}`,
        receipt: {
          directions: ['local-to-peer', 'peer-to-local'].map((direction) => ({
            direction,
            tree: true,
            library: true,
            revision: i + 1,
          })),
        },
      })),
      editors: [0, 1].map((i) => ({
        pod: `backend-${i}`,
        uid: `old-${i}`,
        receipt: {
          phase: 'passed',
          editorResumed: true,
          latestMesh: true,
          heldMs: 25_000,
          starts: 1,
          completions: 1,
          latestPauseCount: 1,
        },
      })),
      evaluations: [0, 1].map((i) => ({
        pod: `backend-${i}`,
        uid: `old-${i}`,
        preserved: true,
        jobs: [{ attempt: 1 }],
      })),
      background: [2, 3].map((i) => ({
        pod: `execution-${i}`,
        uid: `old-${i}`,
        recordingId: `recording-${i}`,
        correlationId: `correlation-${i}`,
      })),
      withdrawn: before
        .filter((p) => p.metadata.name !== 'web')
        .map((p) => ({ pod: p.metadata.name, uid: p.metadata.uid })),
    },
  };
  report.workloads.oldestBrowser = { ...report.workloads.browser, image: f.evidence.browserContract.baseline.image };
  assert.equal(createHaReleaseEvidence(report, f.release, 'mixed').mode, 'mixed');
  const monotonic = structuredClone(report);
  monotonic.workloads.editors[0].receipt.heldMs = Math.floor(25_085.306396);
  assert.equal(
    createHaReleaseEvidence(monotonic, f.release, 'mixed').mode,
    'mixed',
    'monotonic observations must retain the existing whole-millisecond evidence format',
  );
  for (const corrupt of [
    (r) => {
      r.after.find((p) => p.metadata.name === 'web').spec.containers[0].image = 'wrong@sha256:' + 'c'.repeat(64);
    },
    (r) => {
      delete r.workloads.browser;
    },
    (r) => {
      r.workloads.browser.reloads = 1;
    },
    (r) => {
      r.workloads.browser.oldWebPodsRemoved = false;
    },
    ...['unsavedEdit', 'savedByCandidate', 'newRun', 'outputs', 'recordingOpened'].map((key) => (r) => {
      r.workloads.browser[key] = false;
    }),
    (r) => {
      r.workloads.browser.recordingIds = ['one', 'one'];
    },
    (r) => {
      delete r.workloads.oldestBrowser;
    },
    (r) => {
      r.workloads.oldestBrowser.savedByCandidate = false;
    },
    (r) => {
      r.workloads.oldestBrowser.image = images('c').web;
    },
    (r) => {
      r.readiness[0].ready = 1;
    },
    (r) => {
      r.failures.push('502');
    },
    (r) => {
      r.workloads.bundleVerified = false;
    },
    (r) => {
      delete r.workloads.folderNotifications;
    },
    (r) => {
      r.workloads.editors[0].receipt.starts = 2;
    },
    (r) => {
      delete r.workloads.editors[0].receipt.heldMs;
    },
    (r) => {
      r.workloads.editors[0].receipt.heldMs = '25000';
    },
    (r) => {
      r.workloads.editors[0].receipt.heldMs = NaN;
    },
    (r) => {
      r.workloads.editors[0].receipt.heldMs = 25_085.306396;
    },
    (r) => {
      r.workloads.evaluations[0].preserved = 'false';
    },
    (r) => {
      r.workloads.evaluations[0].jobs[0].attempt = 2;
    },
    (r) => {
      r.workloads.background[0].recordingId = null;
    },
    (r) => {
      r.after[0].metadata.uid = r.before[0].metadata.uid;
    },
    (r) => {
      r.workloads.withdrawn.pop();
    },
    (r) => {
      r.rollout.phase = 'owners';
    },
    (r) => {
      r.before[0].spec.containers[0].image = r.after[0].spec.containers[0].image;
    },
    (r) => {
      r.workloads.editors[0].uid = r.workloads.editors[1].uid;
    },
    (r) => {
      r.recovery.lostAcknowledgement.beginCommands = 2;
    },
    (r) => {
      r.recovery.leaseLoss.conflictObserved = false;
    },
    (r) => {
      r.workloads.notifications[0].receipt.directions[0].tree = false;
    },
  ]) {
    const invalid = structuredClone(report);
    corrupt(invalid);
    assert.throws(() => createHaReleaseEvidence(invalid, f.release, 'mixed'), /no certificate/);
  }
});

test('browser support baseline is sticky across multiple releases and may only change through maintenance', () => {
  const f = fixture();
  const next = { ...f.release, source: { sha: 'c'.repeat(40) }, images: images('c') };
  const selected = selectHaBrowserContract(next, f.release);
  assert.deepEqual(selected, f.evidence.browserContract);
  assert.notDeepEqual(selected.baseline.image, f.release.images.web);
  assert.throws(
    () =>
      assertHaUpgradeEvidence(f.release, {
        ...f.installed,
        release: {
          production: {
            ...f.installed.release.production,
            browserContract: { ...selected, baseline: { sourceSha: next.source.sha, image: next.images.web } },
          },
        },
      }),
    /baseline requires maintenance/,
  );
  assert.throws(
    () =>
      assertHaUpgradeEvidence(f.release, {
        ...f.installed,
        release: { production: { sourceSha: f.installed.release.production.sourceSha } },
      }),
    /baseline requires maintenance/,
  );
  assert.deepEqual(selectHaBrowserContract(next, null).baseline, {
    sourceSha: next.source.sha,
    image: next.images.web,
  });
});

test('pre-recording-continuity browsers cannot become the supported rolling baseline', () => {
  const f = fixture();
  const previous = structuredClone(f.release);
  previous.evidence.ha.browserContract.protocol = 1;
  const selected = selectHaBrowserContract(f.release, previous);
  assert.equal(selected.protocol, 2);
  assert.deepEqual(selected.baseline, { sourceSha: f.release.source.sha, image: f.release.images.web });
  assert.throws(
    () =>
      assertHaUpgradeEvidence(f.release, {
        ...f.installed,
        release: {
          production: { ...f.installed.release.production, browserContract: previous.evidence.ha.browserContract },
        },
      }),
    /browser|maintenance/i,
  );
});
