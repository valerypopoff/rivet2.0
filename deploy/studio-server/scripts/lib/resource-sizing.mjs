import assert from 'node:assert/strict';
import { resourceQuantity } from './pod-resource-requests.mjs';

// This input can reserve CPU/RAM for the two edge workloads only. It cannot
// select images, limits, replicas, credentials, routing or other Helm values.
export function sizingRequests(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Sizing requests must be an object');
  assert.deepEqual(Object.keys(value).sort(), ['proxy', 'web'], 'Sizing supports web and proxy only');
  const result = {};
  for (const role of ['web', 'proxy']) {
    const requests = value[role];
    assert.ok(requests && typeof requests === 'object' && !Array.isArray(requests));
    assert.deepEqual(Object.keys(requests).sort(), ['cpu', 'memory'], 'Sizing changes CPU/memory requests only');
    result[role] = {};
    for (const resource of ['cpu', 'memory']) {
      const quantity = requests[resource];
      assert.ok(typeof quantity === 'string' && quantity.length <= 32, 'Sizing quantities must be strings');
      const amount = resourceQuantity(quantity, resource);
      assert.ok(Number.isFinite(amount) && amount > 0, 'Sizing quantities must be positive and finite');
      result[role][resource] = quantity;
    }
  }
  return result;
}

export function sizingInput(env) {
  const raw = env.RIVET_QUALIFICATION_SIZING_REQUESTS ?? '';
  if (!raw) return undefined;
  assert.ok(raw.length <= 1024, 'Sizing input is too large');
  assert.equal(env.RIVET_QUALIFICATION_DEPLOY_PRODUCTION, 'false', 'Sizing requires production deployment disabled');
  return sizingRequests(JSON.parse(raw));
}

export function applySizingRequests(values, requests) {
  const result = structuredClone(values);
  for (const [role, overrides] of Object.entries(sizingRequests(requests)))
    result.resources[role].requests = { ...result.resources[role].requests, ...overrides };
  return result;
}

export function assertSizingReport(report, requests) {
  assert.equal(report.purpose, 'resource-sizing');
  assert.deepEqual(report.requests, requests);
  assert.ok(
    Date.parse(report.finishedAt) - Date.parse(report.startedAt) >= 60000,
    'Sizing needs at least one minute of observations',
  );
  for (const check of ['admission', 'browser', 'upload', 'traffic', 'health', 'metrics', 'hpa'])
    assert.equal(report.checks?.[check], true, `Missing sizing check: ${check}`);
  for (const stream of [report.workflow, report.web]) {
    assert.ok(Number.isSafeInteger(stream?.samples) && stream.samples > 0, 'Sizing needs completed public traffic');
    assert.deepEqual(stream.failures, []);
  }
  assert.ok(report.observations?.length >= 2, 'Sizing needs observations across the test window');
  assert.ok(
    Number.isSafeInteger(report.upload?.bytes) && report.upload.bytes >= 8 * 1024 * 1024,
    'Sizing needs the representative upload',
  );
  const hpaUid = report.observations[0].hpa?.uid;
  assert.ok(typeof hpaUid === 'string' && hpaUid);
  for (const sample of report.observations) {
    assert.equal(sample.hpa?.uid, hpaUid, 'Sizing HPA identity changed');
    assert.ok(Number.isSafeInteger(sample.proxyCount) && sample.proxyCount >= 2 && sample.proxyCount <= 4);
    assert.equal(sample.observations.filter((p) => p.role === 'web').length, 1);
    assert.equal(sample.observations.filter((p) => p.role === 'proxy').length, sample.proxyCount);
    assert.equal(sample.observations.length, sample.proxyCount + 1);
    assert.equal(new Set(sample.observations.map((p) => p.podUid)).size, sample.observations.length);
    for (const pod of sample.observations) {
      assert.ok(typeof pod.podUid === 'string' && pod.podUid);
      assert.ok([pod.cpu, pod.memory].every((v) => Number.isFinite(v) && v >= 0));
    }
  }
}
