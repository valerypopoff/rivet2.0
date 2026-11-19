import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getHaConfigurationDigest } from './ha-kubernetes-rollout.mjs';
import { readHelmChartIdentity } from './studio-server-release-manifest.mjs';

const sha256 = /^sha256:[a-f0-9]{64}$/;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const helmDescriptionPrefix = 'Rivet online editor adoption';
const operationIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function onlineEditorHelmDescription(operationId, receipt, policyDigest) {
  assert.match(operationId, operationIdPattern);
  return `${helmDescriptionPrefix} ${operationId} ${digest(JSON.stringify([receipt.digest, policyDigest]))}`;
}

export function assertOnlineEditorHelmSettlement(history, receipt, policyDigest, expectedOperationId) {
  const entry = history[0];
  const operationId = entry?.description?.split(' ').at(-2);
  if (
    history.length !== 1 ||
    entry?.status !== 'deployed' ||
    Number(entry.revision) !== receipt.installedRevision + 1 ||
    !operationIdPattern.test(operationId ?? '') ||
    entry.description !== onlineEditorHelmDescription(operationId, receipt, policyDigest) ||
    (expectedOperationId && operationId !== expectedOperationId)
  )
    throw Error(
      'Online editor Helm settlement is unconfirmed. Inspect release history and preserve the serving layout.',
    );
  return operationId;
}

export const onlineAdoptionEvents = [
  ['source-withdraw', 'source-withdrawn', 'editor-source-withdrawal'],
  ['source-replace', 'final-routed', 'editor-housekeeping-transfer'],
  ['standby-withdraw', 'standby-withdrawn', 'editor-standby-withdrawal'],
];

export function assertOnlineAdoptionObservations(observations, installedManifestDigest, window) {
  assert.equal(observations?.installedManifestDigest, installedManifestDigest);
  assert.deepEqual(observations.traffic.failures, []);
  const browser = observations.browser;
  assert.ok(browser.passed && browser.unsavedEdit && browser.savedByCandidate && browser.newRun);
  assert.equal(browser.reloads, 0);
  assert.equal(browser.iframeReloads, 0);
  const requests = observations.protectedRequests;
  assert.equal(requests.length, 9);
  assert.equal(new Set(requests.map((request) => request.recordingId)).size, requests.length);
  assert.ok(
    requests.some((request) => request.transport === 'pooled-http1' && request.reusedConnection === true),
    'Online adoption did not observe HTTP/1 connection reuse',
  );
  const earliest = window ? Date.parse(window.startedAt) : -Infinity;
  const latest = window ? Date.parse(window.finishedAt) : Infinity;
  for (const [, , name] of onlineAdoptionEvents) {
    const sample = observations.observed?.[name];
    for (const route of ['editor', 'workflow', 'webApp'])
      assert.ok(
        Number.isSafeInteger(sample?.before?.[route]) &&
          sample.before[route] > 0 &&
          Number.isSafeInteger(sample.after?.[route]) &&
          sample.after[route] > sample.before[route],
        `Routed ${route} samples did not cover ${name}`,
      );
    assert.equal(sample.freshLogin, true, `Fresh authentication was unverified at ${name}`);
    const started = Date.parse(sample.startedAt);
    const event = Date.parse(sample.at);
    assert.ok(earliest <= started && started < event && event < latest, `Invalid handoff window for ${name}`);
    const covered = requests.filter(
      (request) =>
        request.stage === name &&
        request.outcome === 'passed' &&
        request.fullBody === true &&
        typeof request.recordingId === 'string' &&
        request.recordingId &&
        request.durationMs === 295_000 &&
        request.elapsedMs >= 295_000 &&
        request.elapsedMs <= 300_000 &&
        Date.parse(request.acceptedAt) >= earliest &&
        Date.parse(request.acceptedAt) <= started &&
        Date.parse(request.finishedAt) > event &&
        Date.parse(request.finishedAt) <= latest,
    );
    assert.deepEqual(
      covered.map((request) => request.transport).sort(),
      ['fresh-http1', 'http2', 'pooled-http1'],
      `Protected requests did not cross ${name}`,
    );
  }
}

export async function readOnlineAdoptionReceipt(file, { root, installedManifestDigest, schema }) {
  const bytes = await readFile(file);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.formatVersion, 1);
  assert.equal(receipt.kind, 'rivet-online-editor-adoption');
  assert.equal(receipt.installedManifestDigest, installedManifestDigest);
  assert.equal(receipt.schema, schema);
  assert.deepEqual(receipt.chart, readHelmChartIdentity(root));
  assert.match(receipt.operatorSource, /^[a-f0-9]{40}$/);
  for (const key of ['installedSettingsDigest', 'valuesDigest', 'configurationDigest', 'sourceResourcesDigest'])
    assert.match(receipt[key], sha256, `Missing online adoption ${key}`);
  assert.ok(Number.isSafeInteger(receipt.installedRevision) && receipt.installedRevision > 0);
  const proof = receipt.qualification;
  assert.equal(proof?.outcome, 'passed', 'Online adoption requires observed first-adoption qualification');
  assert.equal(proof.scope, 'isolated-provider');
  assert.equal(proof.failedRequests, 0);
  assert.equal(proof.installedManifestDigest, installedManifestDigest);
  assert.equal(proof.chartDigest, receipt.chart.contentDigest);
  assert.equal(proof.operatorSource, receipt.operatorSource);
  assert.equal(proof.evidenceDigest, digest(JSON.stringify(proof.observations)));
  assertOnlineAdoptionObservations(proof.observations, installedManifestDigest);
  assert.equal(proof.cleanupVerified, true);
  return { ...receipt, digest: digest(bytes) };
}

export function assertOnlineAdoptionRender(receipt, source, desired, valuesDigest) {
  assert.equal(receipt.valuesDigest, valuesDigest, 'Online adoption values changed after review');
  assert.equal(
    receipt.sourceResourcesDigest,
    getHaConfigurationDigest(source),
    'Installed Helm revision changed after review',
  );
  assert.equal(
    receipt.configurationDigest,
    getHaConfigurationDigest(desired),
    'Online adoption render changed after review',
  );
}
