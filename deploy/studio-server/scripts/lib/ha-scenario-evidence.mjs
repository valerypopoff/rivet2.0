import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHaReleaseEvidence } from './ha-release-evidence.mjs';
import { getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';

export const HA_PROOF_SCENARIOS = ['upgrade', 'lostAcknowledgement', 'leaseLoss'];
export const HA_SCENARIO_REPORT_VERSION = 1;

export function haProofRunIdentity(env) {
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_REPOSITORY: repository } = env;
  assert.match(runId ?? '', /^[1-9]\d*$/, 'HA proof requires an explicit run ID');
  assert.match(attempt ?? '', /^[1-9]\d*$/, 'HA proof requires an explicit run attempt');
  assert.ok(Number.isSafeInteger(Number(attempt)), 'Invalid HA run attempt');
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'Invalid HA repository identity');
  return { repository, runId, runAttempt: Number(attempt) };
}

export function haScenarioBinding(candidate, run, mode, browserContract) {
  assert.ok(['mixed', 'bootstrap'].includes(mode), 'Invalid HA certification mode');
  assert.equal(candidate.source.repository, run.repository, 'HA repository differs from the candidate');
  assert.equal(candidate.evidence.candidate.runId, run.runId, 'HA run differs from the candidate build');
  assert.equal(candidate.evidence.candidate.runAttempt, run.runAttempt, 'HA attempt differs from the candidate build');
  return {
    ...run,
    candidateManifestDigest: getStudioServerReleaseManifestDigest(candidate),
    sourceSha: candidate.source.sha,
    images: candidate.images,
    chartDigest: candidate.chart.contentDigest,
    predecessor: candidate.lineage?.predecessor ?? null,
    mode,
    browserContract,
  };
}

export function createHaScenarioReport({ scenario, binding, fixture, report }) {
  assert.ok(HA_PROOF_SCENARIOS.includes(scenario), 'Unknown HA scenario');
  assert.ok(
    fixture?.namespace && fixture?.namespaceUid && fixture?.clusterUid && fixture?.release,
    'Missing HA fixture identity',
  );
  return { version: HA_SCENARIO_REPORT_VERSION, scenario, binding, fixture, report };
}

export const assertHaRecoveryOwners = (pods, image) => {
  assert.ok(Array.isArray(pods) && pods.length === 5, 'Recovery requires all five ordinary owners');
  assert.equal(new Set(pods.map((p) => p.name)).size, 5, 'Duplicate recovery owner names');
  assert.equal(new Set(pods.map((p) => p.uid)).size, 5, 'Duplicate recovery owner UIDs');
  for (const [role, count] of [
    ['backend', 2],
    ['execution', 2],
    ['maintenance', 1],
  ]) {
    assert.equal(pods.filter((p) => p.role === role).length, count, 'Recovery topology changed');
  }
  for (const pod of pods)
    assert.ok(pod.name && pod.uid && pod.ready && pod.image === image, 'Recovery owner is not current and ready');
};

export function assertHaRecoveryScenario(report, scenario, images) {
  assert.ok(['lostAcknowledgement', 'leaseLoss'].includes(scenario), 'Invalid recovery scenario');
  assert.ok(
    Number.isSafeInteger(report?.samples) && report.samples >= 100,
    'Each recovery needs its own 100 traffic samples',
  );
  assert.deepEqual(report.failures, [], 'Recovery traffic failed');
  assert.deepEqual(report.failedRequests, [], 'Recovery has failed requests');
  const proof = report[scenario];
  assert.ok(
    proof?.passed === true && proof.beginCommands === 1 && proof.faultInjected === true && proof.beginAccepted === true,
    'Recovery did not prove its fault and exact-once begin',
  );
  if (scenario === 'leaseLoss') assert.equal(proof.conflictObserved, true, 'Missing real lease CAS conflict');
  const image = `${images.api.repository}@${images.api.digest}`;
  assertHaRecoveryOwners(proof.before, image);
  assertHaRecoveryOwners(proof.after, image);
  const original = proof.before.find((p) => p.name === proof.originalPod && p.uid === proof.originalUid);
  assert.ok(
    original && proof.protectedOwner?.uid === original.uid && proof.protectedOwner.name === original.name,
    'Unconfirmed owner was not preserved',
  );
  assert.equal(proof.rollout?.phase, 'complete', 'Recovery must finish the entire rollout');
  assert.equal(proof.rollout.owner, null, 'Recovery still owns an unfinished retirement');
  assert.ok(proof.rollout.token && proof.rollout.token === proof.resumeToken, 'Recovery token changed');
  assert.ok(
    proof.baselineJournal?.phase === 'complete' &&
      proof.baselineJournal.token &&
      proof.baselineJournal.token !== proof.resumeToken,
    'Recovery did not start a new operation from a completed journal',
  );
  const names = new Set(proof.before.map((p) => p.workload));
  assert.equal(names.size, 3, 'Recovery workload inventory changed');
  assert.deepEqual([...proof.rollout.completed].sort(), [...names].sort(), 'Recovery did not finish every workload');
  for (const old of proof.before) {
    const next = proof.after.find((p) => p.name === old.name);
    assert.ok(next && next.uid !== old.uid, 'Recovery skipped an ordinary pod replacement');
  }
  if (scenario === 'leaseLoss') {
    assert.equal(proof.editors?.length, 1, 'Lease recovery needs its accepted editor probe');
    const editor = proof.editors[0];
    assert.equal(editor.uid, original.uid);
    assert.equal(editor.receipt?.phase, 'passed');
    assert.ok(editor.receipt.heldMs >= 45_000, 'Lease-loss probe did not outlive the heartbeat');
    assert.equal(editor.receipt.starts, 1);
    assert.equal(editor.receipt.completions, 1);
  }
  return proof;
}

/** Scenario windows stay separate. Only validated observations enter the
 * existing certificate creator; job success or checklist flags cannot certify. */
export function assembleHaScenarioEvidence(reports, candidate, binding) {
  assert.equal(reports.length, HA_PROOF_SCENARIOS.length, 'Exactly three HA scenario reports are required');
  const byName = new Map();
  const fixtures = new Set();
  const clusters = new Set();
  for (const item of reports) {
    assert.equal(item?.version, HA_SCENARIO_REPORT_VERSION, 'Unsupported HA scenario report version');
    assert.ok(
      HA_PROOF_SCENARIOS.includes(item.scenario) && !byName.has(item.scenario),
      'Missing or duplicate HA scenario',
    );
    assert.ok(
      isDeepStrictEqual(item.binding, binding),
      'HA report belongs to another source, run, attempt or configuration',
    );
    assert.ok(
      item.fixture?.clusterUid && item.fixture?.namespaceUid && item.fixture?.namespace && item.fixture?.release,
      'Missing HA fixture identity',
    );
    const key = `${item.fixture.clusterUid}/${item.fixture.namespaceUid}`;
    assert.ok(!fixtures.has(key), 'HA scenarios must have independent namespaces');
    fixtures.add(key);
    assert.ok(!clusters.has(item.fixture.clusterUid), 'HA scenarios must have independent clusters');
    clusters.add(item.fixture.clusterUid);
    byName.set(item.scenario, item);
  }
  assert.equal(
    binding.candidateManifestDigest,
    getStudioServerReleaseManifestDigest(candidate),
    'Candidate binding changed',
  );
  const upgrade = structuredClone(byName.get('upgrade').report);
  assert.ok(isDeepStrictEqual(upgrade.browserContract, binding.browserContract), 'Browser baseline changed');
  for (const scenario of HA_PROOF_SCENARIOS.slice(1))
    assertHaRecoveryScenario(byName.get(scenario).report, scenario, candidate.images);
  // The legacy certificate consumes only the two validated recovery receipts.
  // Do not add sample counts or concatenate windows to meet a threshold.
  upgrade.recovery = {
    samples: Math.min(...HA_PROOF_SCENARIOS.slice(1).map((s) => byName.get(s).report.samples)),
    failures: [],
    ...Object.fromEntries(HA_PROOF_SCENARIOS.slice(1).map((s) => [s, byName.get(s).report[s]])),
  };
  return createHaReleaseEvidence(upgrade, candidate, binding.mode);
}
