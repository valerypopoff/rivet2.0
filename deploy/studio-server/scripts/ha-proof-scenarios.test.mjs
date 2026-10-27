import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHaProofTiming } from './lib/ha-proof-timing.mjs';
import {
  HA_PROOF_SCENARIOS,
  haProofRunIdentity,
  haScenarioBinding,
  createHaScenarioReport,
  assembleHaScenarioEvidence,
} from './lib/ha-scenario-evidence.mjs';
import { assembleHaProofFiles, runHaProofScenario } from './kubernetes-ha-release-gate.mjs';
import { manageHaKindCluster } from './ha-kind-cluster.mjs';
import { establishHaRecoveryBaseline } from './lib/ha-release-recovery-probes.mjs';
import { createStudioServerReleaseManifest } from './lib/studio-server-release-manifest.mjs';
import { HA_BROWSER_CONTRACT } from './lib/ha-release-evidence.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const runIdentity = { repository: 'valerypopoff/rivet2.0', runId: '123', runAttempt: 1 };
const images = Object.fromEntries(
  ['proxy', 'web', 'api', 'executor'].map((s) => [
    s,
    { repository: `example.test/${s}`, digest: `sha256:${'a'.repeat(64)}` },
  ]),
);
const ref = (image) => `${image.repository}@${image.digest}`;

function fixture(sha = 'a'.repeat(40)) {
  const candidate = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: runIdentity.repository, sha, ref: 'refs/heads/main' },
    images,
    candidateEvidence: { workflow: 'Build Images', runId: runIdentity.runId, runAttempt: runIdentity.runAttempt },
  });
  const browserContract = { protocol: HA_BROWSER_CONTRACT, baseline: { sourceSha: sha, image: images.web } };
  const binding = haScenarioBinding(candidate, runIdentity, 'bootstrap', browserContract);
  const pods = ['backend', 'backend', 'execution', 'execution', 'maintenance', 'web'].map((role, i) => ({
    metadata: { name: `${role}-${i}`, uid: `old-${i}`, labels: { 'app.kubernetes.io/component': role } },
    spec: {
      containers: [{ name: role === 'web' ? 'web' : 'backend', image: ref(images[role === 'web' ? 'web' : 'api']) }],
    },
  }));
  const notification = {
    directions: ['local-to-peer', 'peer-to-local'].map((direction) => ({
      direction,
      tree: true,
      library: true,
      revision: 1,
    })),
  };
  const browser = {
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
  };
  const upgrade = {
    samples: 150,
    failures: [],
    readiness: [{ ready: 2 }, { ready: 3 }],
    rollout: { phase: 'complete' },
    browserContract,
    before: pods,
    after: pods.map((p) => ({
      ...p,
      metadata: { ...p.metadata, uid: `new-${p.metadata.uid}` },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })),
    workloads: {
      browser,
      oldestBrowser: { ...browser, image: images.web },
      bundleVerified: true,
      folderNotifications: notification,
      notifications: [0, 1].map((i) => ({ pod: `backend-${i}`, uid: `old-${i}`, receipt: notification })),
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
      withdrawn: pods.slice(0, 5).map((p) => ({ pod: p.metadata.name, uid: p.metadata.uid })),
    },
  };
  const reports = HA_PROOF_SCENARIOS.map((scenario) => {
    let report = upgrade;
    if (scenario !== 'upgrade') {
      const before = ['backend', 'backend', 'execution', 'execution', 'maintenance'].map((role, i) => ({
        name: `${role}-${i}`,
        uid: `${scenario}-${i}`,
        role,
        workload: role,
        ready: true,
        image: ref(images.api),
      }));
      report = {
        samples: 100,
        failures: [],
        failedRequests: [],
        [scenario]: {
          passed: true,
          beginCommands: 1,
          faultInjected: true,
          beginAccepted: true,
          conflictObserved: scenario === 'leaseLoss',
          originalPod: before[0].name,
          originalUid: before[0].uid,
          protectedOwner: { name: before[0].name, uid: before[0].uid },
          resumeToken: scenario,
          baselineJournal: { token: 'completed-baseline', phase: 'complete' },
          rollout: {
            token: scenario,
            phase: 'complete',
            owner: null,
            completed: ['backend', 'execution', 'maintenance'],
          },
          before,
          after: before.map((p) => ({ ...p, uid: `new-${p.uid}` })),
          editors:
            scenario === 'leaseLoss'
              ? [{ uid: before[0].uid, receipt: { phase: 'passed', heldMs: 45_000, starts: 1, completions: 1 } }]
              : [],
        },
      };
    }
    return createHaScenarioReport({
      scenario,
      binding,
      fixture: {
        context: 'kind-rivet-managed-release',
        clusterUid: `cluster-${scenario}`,
        namespace: `ns-${scenario}`,
        namespaceUid: `nsuid-${scenario}`,
        release: 'proof',
      },
      report,
    });
  });
  return { candidate, binding, reports };
}

test('parallel evidence keeps all upgrade checks and independent full-roll recovery windows', () => {
  const f = fixture();
  const proof = assembleHaScenarioEvidence(f.reports, f.candidate, f.binding);
  assert.equal(proof.protocol, 3);
  assert.equal(proof.mode, 'bootstrap');
  assert.equal(proof.requestSamples, 150, 'do not add separate traffic windows');
  for (const [mutate, message] of [
    [(r) => r.pop(), /Exactly three/],
    [
      (r) => {
        r[2] = structuredClone(r[1]);
      },
      /duplicate/,
    ],
    [
      (r) => {
        r[1].version++;
      },
      /version/,
    ],
    ...['runId', 'runAttempt', 'sourceSha', 'images', 'chartDigest', 'predecessor'].map((key) => [
      (r) => {
        r[1].binding[key] = 'foreign';
      },
      /another source/,
    ]),
    [
      (r) => {
        r[1].fixture.clusterUid = r[0].fixture.clusterUid;
      },
      /independent clusters/,
    ],
    [
      (r) => {
        delete r[1].fixture.namespaceUid;
      },
      /fixture identity/,
    ],
    [
      (r) => {
        r[0].report.workloads.browser.outputs = false;
      },
      /no certificate/,
    ],
    [
      (r) => {
        r[1].report.samples = 99;
        r[2].report.samples = 1000;
      },
      /own 100/,
    ],
    [
      (r) => {
        r[1].report.failures.push('502');
      },
      /traffic failed/,
    ],
    [
      (r) => {
        r[1].report.failedRequests.push({ status: 502 });
      },
      /failed requests/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.beginCommands = 2;
      },
      /exact-once/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.protectedOwner.uid = 'replacement';
      },
      /preserved/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.rollout.phase = 'owners';
      },
      /entire rollout/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.rollout.completed.pop();
      },
      /every workload/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.rollout.token = 'other';
      },
      /token changed/,
    ],
    [
      (r) => {
        delete r[1].report.lostAcknowledgement.baselineJournal;
      },
      /completed journal/,
    ],
    [
      (r) => {
        const p = r[1].report.lostAcknowledgement;
        p.after[4].uid = p.before[4].uid;
      },
      /skipped/,
    ],
    [
      (r) => {
        r[1].report.lostAcknowledgement.after[2].image = 'foreign';
      },
      /current and ready/,
    ],
    [
      (r) => {
        r[2].report.leaseLoss.conflictObserved = false;
      },
      /CAS conflict/,
    ],
    [
      (r) => {
        r[2].report.leaseLoss.editors[0].receipt.heldMs = 29_000;
      },
      /heartbeat/,
    ],
    [
      (r) => {
        r[2].report.leaseLoss.editors[0].receipt.completions = 2;
      },
      /strictly equal/,
    ],
  ]) {
    const invalid = structuredClone(f.reports);
    mutate(invalid);
    assert.throws(() => assembleHaScenarioEvidence(invalid, f.candidate, f.binding), message);
  }
});

test('independent recovery setup retains completed-journal reuse without repairing unfinished work', async () => {
  let record = null;
  let owners = [{ uid: 'ordinary-owner' }];
  let completions = 0;
  const options = {
    readJournal: async () => record,
    inspectOwners: async () => structuredClone(owners),
    completeNoChange: async () => {
      completions++;
      record = { token: 'baseline', phase: 'complete' };
    },
  };
  assert.equal((await establishHaRecoveryBaseline(options)).baselineJournal.token, 'baseline');
  await establishHaRecoveryBaseline(options);
  assert.equal(completions, 1, 'reuse an already acknowledged completed journal');
  record = { token: 'busy', phase: 'owners' };
  await assert.rejects(establishHaRecoveryBaseline(options), /unfinished work/);
  assert.equal(completions, 1, 'never repair or overwrite unfinished work');
  record = null;
  await assert.rejects(
    establishHaRecoveryBaseline({
      ...options,
      completeNoChange: async () => {
        owners = [{ uid: 'replacement' }];
        record = { token: 'new', phase: 'complete' };
      },
    }),
    /replaced an owner/,
  );
});

test('scenario run metadata is bound to the candidate build and unknown scenarios touch nothing', async () => {
  const f = fixture();
  assert.deepEqual(
    haProofRunIdentity({ GITHUB_REPOSITORY: runIdentity.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }),
    runIdentity,
  );
  for (const key of ['repository', 'runId', 'runAttempt'])
    assert.throws(() =>
      haScenarioBinding(f.candidate, { ...runIdentity, [key]: 'different' }, 'bootstrap', f.binding.browserContract),
    );
  await assert.rejects(runHaProofScenario({}, { scenario: 'typo' }), /known HA proof scenario/);
});

test('timing uses monotonic phases, logs progress, and never changes success or the primary error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const logs = [];
  const artifacts = [];
  const timing = createHaProofTiming({
    now: () => now,
    log: (line) => logs.push(line),
    artifact: async (name, value) => artifacts.push([name, JSON.parse(value)]),
  });
  timing.status('owners/backend-0');
  t.mock.timers.tick(30_000);
  assert.ok(logs.some((line) => line.includes('[ha-progress] owners/backend-0')));
  assert.equal(
    await timing.measure('setup', async () => {
      now = 120;
      return 'ready';
    }),
    'ready',
  );
  const error = Error('secret-response-must-not-be-logged');
  await assert.rejects(
    timing.measure('fault', async () => {
      now = 220;
      throw error;
    }),
    (e) => e === error,
  );
  const receipt = await timing.close();
  const closedLogCount = logs.length;
  t.mock.timers.tick(60_000);
  assert.equal(logs.length, closedLogCount, 'closing timing must stop its heartbeat');
  assert.deepEqual(
    receipt.phases.map((p) => [p.name, p.outcome, p.elapsedMs]),
    [
      ['setup', 'passed', 120],
      ['fault', 'failed', 100],
    ],
  );
  assert.ok(artifacts.length >= 2 && !JSON.stringify(logs).includes(error.message));
  await assert.rejects(
    timing.measure('closed', async () => {}),
    /lifetime/,
  );
  const unavailable = createHaProofTiming({
    artifact: async () => {
      throw Error('disk');
    },
    log: () => {},
  });
  try {
    assert.equal(await unavailable.measure('setup', async () => 1), 1);
  } finally {
    await unavailable.close();
  }
});

test('exact file assembly rejects wrong names and cannot overwrite an earlier certificate', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-assembly-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture();
  const reports = path.join(dir, 'reports');
  await fs.mkdir(reports);
  const output = path.join(dir, 'certificate.json');
  for (const r of f.reports) await fs.writeFile(path.join(reports, `${r.scenario}.json`), JSON.stringify(r));
  await assembleHaProofFiles({ directory: reports, candidate: f.candidate, binding: f.binding, output });
  await assert.rejects(
    assembleHaProofFiles({ directory: reports, candidate: f.candidate, binding: f.binding, output }),
    /EEXIST/,
  );
  await fs.writeFile(path.join(reports, 'extra.json'), '{}');
  await assert.rejects(
    assembleHaProofFiles({ directory: reports, candidate: f.candidate, binding: f.binding, output: `${output}.bad` }),
    /exactly the three/,
  );
});

test('actual assembly CLI creates evidence without Kubernetes or registry access', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git([
    '-c',
    'user.name=HA fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const f = fixture(git(['rev-parse', 'HEAD']));
  const reports = path.join(dir, 'reports');
  await fs.mkdir(reports);
  for (const r of f.reports) await fs.writeFile(path.join(reports, `${r.scenario}.json`), JSON.stringify(r));
  const manifest = path.join(dir, 'candidate.json');
  await fs.writeFile(manifest, JSON.stringify(f.candidate));
  const env = {
    ...process.env,
    GIT_DIR: path.join(dir, '.git'),
    GIT_WORK_TREE: dir,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: runIdentity.repository,
    RIVET_HA_CANDIDATE_MANIFEST: manifest,
    RIVET_HA_SCENARIO_REPORTS: reports,
    RIVET_HA_EVIDENCE_OUTPUT: path.join(dir, 'evidence.json'),
    RIVET_HA_PREDECESSOR_MANIFEST: '',
  };
  const cli = () =>
    spawnSync(
      process.execPath,
      [path.join(rootDir, 'deploy/studio-server/scripts/kubernetes-ha-release-gate.mjs'), 'assemble'],
      { cwd: dir, env, encoding: 'utf8', windowsHide: true },
    );
  const result = cli();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fs.readFile(env.RIVET_HA_EVIDENCE_OUTPUT, 'utf8')).protocol, 3);
  env.GITHUB_RUN_ATTEMPT = '2';
  env.RIVET_HA_EVIDENCE_OUTPUT += '.wrong-attempt';
  const rejected = cli();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /attempt differs/);
});

test('Kind cleanup is bound to exact recorded containers and never deletes unknown creation or replacements', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-kind-owner-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const owner = { ...runIdentity, scenario: 'upgrade' };
  let ids = [];
  const removed = [];
  const command = async (bin, args) => {
    if (bin === 'kind') {
      ids = ['a', 'b', 'c', 'd'];
      return { stdout: '' };
    }
    if (args[0] === 'ps') return { stdout: ids.join('\n') };
    if (args[0] === 'inspect')
      return {
        stdout: JSON.stringify(
          ids.map((Id) => ({ Id, Config: { Labels: { 'io.x-k8s.kind.cluster': 'rivet-managed-release' } } })),
        ),
      };
    assert.deepEqual(args.slice(0, 3), ['rm', '-f', '--volumes']);
    removed.push(...args.slice(3));
    ids = [];
    return { stdout: '' };
  };
  const options = { receipt: path.join(dir, 'receipt.json'), kubeconfig: path.join(dir, 'kubeconfig'), owner, command };
  await manageHaKindCluster('create', options);
  await assert.rejects(
    manageHaKindCluster('cleanup', { ...options, owner: { ...owner, runAttempt: 2 } }),
    /another run/,
  );
  ids.push('foreign');
  await assert.rejects(manageHaKindCluster('cleanup', options), /inventory changed/);
  ids.pop();
  assert.deepEqual(removed, []);
  await manageHaKindCluster('cleanup', options);
  assert.deepEqual(removed, ['a', 'b', 'c', 'd']);
  await manageHaKindCluster('cleanup', options);
  assert.equal(removed.length, 4);
  await fs.writeFile(
    options.receipt,
    JSON.stringify({ version: 1, cluster: 'rivet-managed-release', owner, state: 'creating' }),
  );
  await assert.rejects(manageHaKindCluster('cleanup', options), /Uncertain Kind creation/);
});
