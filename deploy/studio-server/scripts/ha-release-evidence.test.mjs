import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHaReleaseEvidence,
  assertHaUpgradeEvidence,
  createHaReleaseEvidence,
  HA_REQUIRED_CHECKS,
  selectHaBrowserContract,
} from './lib/ha-release-evidence.mjs';
const images = (x) =>
  Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((name) => [
      name,
      { repository: `registry/${name}`, digest: `sha256:${x.repeat(64)}` },
    ]),
  );
function fixture() {
  const release = {
    source: { sha: 'b'.repeat(40) },
    images: images('b'),
    chart: { contentDigest: `sha256:${'c'.repeat(64)}` },
    lineage: { predecessor: { sourceSha: 'a'.repeat(40), images: images('a') } },
  };
  const evidence = {
    protocol: 3,
    browserContract: { protocol: 1, baseline: { sourceSha: 'a'.repeat(40), image: images('a').web } },
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
        production: { sourceSha: release.lineage.predecessor.sourceSha, browserContract: evidence.browserContract },
      },
      images: images('a'),
    },
  };
}
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
    release: { production: { sourceSha: f.release.source.sha, browserContract: f.evidence.browserContract } },
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
