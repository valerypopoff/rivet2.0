import assert from 'node:assert/strict';
import test from 'node:test';
import { sizingInput, sizingRequests, applySizingRequests } from './lib/resource-sizing.mjs';
import { observeSizing, runProviderSizing, uploadSizingProject } from './qualification/provider-sizing.mjs';
import { parse } from 'yaml';

const requests = { web: { cpu: '50m', memory: '128Mi' }, proxy: { cpu: '100m', memory: '128Mi' } };
const values = () => ({
  resources: Object.fromEntries(
    ['web', 'proxy', 'backend'].map((role) => [
      role,
      { requests: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi' }, limits: { memory: '1Gi' } },
    ]),
  ),
});

test('the representative upload is a real valid large project and an uncertain POST is never repeated', async () => {
  let calls = 0;
  const gate = {
    config: { baseUrl: 'https://fixture.invalid' },
    requestWorkflow: async (_base, route, options) => {
      calls++;
      assert.equal(route, '/api/workflows/projects/upload');
      const body = JSON.parse(options.body),
        project = parse(body.contents);
      assert.ok(Buffer.byteLength(body.contents) >= 8 * 1024 * 1024);
      return { project: { id: project.data.metadata.id } };
    },
  };
  const result = await uploadSizingProject(gate);
  assert.ok(result.bytes >= 8 * 1024 * 1024);
  assert.equal(calls, 1);
  gate.requestWorkflow = async () => {
    calls++;
    throw Error('response lost');
  };
  await assert.rejects(uploadSizingProject(gate), /response lost/);
  assert.equal(calls, 2);
});

test('sizing accepts intentional increases or decreases, requires disabled deployment and preserves other Helm values', () => {
  assert.equal(sizingInput({}), undefined);
  assert.deepEqual(
    sizingInput({
      RIVET_QUALIFICATION_SIZING_REQUESTS: JSON.stringify(requests),
      RIVET_QUALIFICATION_DEPLOY_PRODUCTION: 'false',
    }),
    requests,
  );
  assert.throws(() => sizingInput({ RIVET_QUALIFICATION_SIZING_REQUESTS: JSON.stringify(requests) }));
  for (const invalid of [
    null,
    [],
    {},
    { ...requests, backend: requests.web },
    { ...requests, web: { ...requests.web, limits: {} } },
    ...['0', '-1', 'NaN', 'Infinity', '1e999', ''].map((cpu) => ({ ...requests, web: { ...requests.web, cpu } })),
  ])
    assert.throws(() => sizingRequests(invalid));
  const increased = { ...requests, proxy: { cpu: '1', memory: '2Gi' } };
  assert.deepEqual(sizingRequests(increased), increased);
  assert.deepEqual(applySizingRequests(values(), increased).resources.proxy.requests, {
    ...increased.proxy,
    'ephemeral-storage': '1Gi',
  });
  const before = values(),
    frozen = structuredClone(before);
  const after = applySizingRequests(before, requests);
  assert.deepEqual(before, frozen);
  assert.deepEqual(after.resources.backend, before.resources.backend);
  for (const role of ['web', 'proxy']) {
    assert.deepEqual(after.resources[role].limits, before.resources[role].limits);
    assert.equal(after.resources[role].requests['ephemeral-storage'], '1Gi');
    assert.equal(after.resources[role].requests.cpu, requests[role].cpu);
  }
});

function fixture() {
  const pods = ['web', 'proxy', 'proxy'].map((role, i) => ({
    metadata: { name: `${role}-${i}`, uid: `${role}-${i}`, labels: { 'app.kubernetes.io/component': role } },
    spec: { containers: [{ name: role, resources: { requests: requests[role] } }] },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: role, ready: true, restartCount: 0 }],
    },
  }));
  const hpa = {
    metadata: { uid: 'hpa' },
    status: {
      desiredReplicas: 2,
      currentReplicas: 2,
      conditions: ['AbleToScale', 'ScalingActive'].map((type) => ({ type, status: 'True' })),
    },
    spec: {
      minReplicas: 2,
      maxReplicas: 4,
      metrics: [{ resource: { target: { type: 'Utilization', averageUtilization: 75 } } }],
    },
  };
  const metrics = {
    items: pods.map((p) => ({
      metadata: { name: p.metadata.name },
      timestamp: new Date().toISOString(),
      containers: [{ name: p.spec.containers[0].name, usage: { cpu: '1m', memory: '10Mi' } }],
    })),
  };
  const gate = {
    config: { release: 'fixture', namespace: 'fixture' },
    operation: { candidate: { images: {} }, sizingRequests: requests },
    values: () => ({ resources: Object.fromEntries(['web', 'proxy'].map((r) => [r, { requests: requests[r] }])) }),
    pods: async () => pods,
    kube: async (args) => ({ stdout: JSON.stringify(args.includes('hpa') ? hpa : metrics) }),
  };
  return { gate, pods, hpa, metrics };
}

test('sizing reports admission changes without vetoing reservations and still detects health failures', async () => {
  const { gate, pods, metrics } = fixture();
  assert.equal((await observeSizing(gate)).proxyCount, 2);
  pods[0].spec.containers[0].resources.requests = { cpu: '250m', memory: '512Mi' };
  let sample = await observeSizing(gate);
  assert.deepEqual(sample.observations[0].resources.requested.requests, requests.web);
  assert.deepEqual(sample.observations[0].resources.admitted.requests, { cpu: '250m', memory: '512Mi' });
  pods[0].spec.containers[0].resources.limits = { cpu: '50m' };
  sample = await observeSizing(gate);
  assert.deepEqual(sample.observations[0].resources.admitted.limits, { cpu: '50m' });
  assert.equal(sample.observations[0].resources.requested.limits, undefined);
  delete pods[0].spec.containers[0].resources.limits;
  pods[0].status.containerStatuses[0].restartCount = 1;
  await assert.rejects(observeSizing(gate), /restarted/);
  pods[0].status.containerStatuses[0].restartCount = 0;
  metrics.items[0].timestamp = '2000-01-01T00:00:00Z';
  assert.equal(await observeSizing(gate), false);
});

test('sizing allows healthy HPA growth and requires an active scaler before reporting observations', async () => {
  const { gate, pods, metrics, hpa } = fixture();
  const extra = structuredClone(pods[1]);
  extra.metadata.name = 'proxy-new';
  extra.metadata.uid = 'proxy-new';
  pods.push(extra);
  const metric = structuredClone(metrics.items[1]);
  metric.metadata.name = 'proxy-new';
  metrics.items.push(metric);
  hpa.status.desiredReplicas = 3;
  hpa.status.currentReplicas = 3;
  assert.equal((await observeSizing(gate)).proxyCount, 3);
  hpa.status.conditions = [];
  assert.equal(await observeSizing(gate), false);
  extra.status.conditions[0].status = 'False';
  extra.status.containerStatuses[0].lastState = { terminated: { reason: 'OOMKilled' } };
  await assert.rejects(observeSizing(gate), /OOMKilled/);
});

test('sizing always settles every traffic stream, including browser/upload and late request failures', async () => {
  for (const fail of ['browser', 'upload', 'late', undefined]) {
    let stopped = 0,
      observed = 0,
      clock = Date.now();
    const stream = () => ({
      report: { samples: 1, failures: [] },
      async stop() {
        stopped++;
        if (fail === 'late') this.report.failures.push('last request failed');
      },
    });
    const { gate } = fixture();
    Object.assign(gate, {
      config: { ...gate.config, baseUrl: 'https://fixture.invalid' },
      verifyPublishedBrowser: async (_base, sizing) => {
        assert.equal(sizing, true);
        if (fail === 'browser') throw Error('browser');
      },
      frontendAvailability: async () => {},
      artifact: async () => {},
    });
    const run = () =>
      runProviderSizing(gate, {
        now: () => clock,
        durationMs: 1,
        pause: async (ms) => {
          clock += ms;
        },
        wait: async (_label, check) => {
          await check();
          return true;
        },
        observe: async () => ({ sample: ++observed }),
        upload: async () => {
          if (fail === 'upload') throw Error('upload');
          return { bytes: 8 * 1024 * 1024 };
        },
        startWorkflow: stream,
        startWeb: stream,
      });
    if (fail) await assert.rejects(run());
    else {
      const result = await run();
      assert.equal(result.purpose, 'resource-sizing');
      assert.equal(result.workflow.samples, 4);
    }
    assert.equal(stopped, 5);
  }
});
