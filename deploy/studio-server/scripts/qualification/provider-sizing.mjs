import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { role, ready, until, root } from './provider-gate.mjs';
import { resourceQuantity } from '../lib/pod-resource-requests.mjs';
import { rootStructuralMutation } from '../lib/structural-fixture-admission.mjs';
import { startHaWorkflowTraffic, startHaWebAppTraffic } from '../lib/ha-workflow-traffic.mjs';
import { waitForOrdinaryRuntime } from '../lib/runtime-upgrade-qualification.mjs';

export async function observeSizing(gate, now = Date.now) {
  const all = (await gate.pods()).filter((p) => ['web', 'proxy'].includes(role(p)));
  for (const pod of all) {
    const status = pod.status?.containerStatuses?.find((c) => c.name === role(pod));
    assert.ok(!status || status.restartCount === 0, 'Sizing container restarted');
    assert.notEqual(status?.lastState?.terminated?.reason, 'OOMKilled');
    assert.notEqual(status?.state?.terminated?.reason, 'OOMKilled');
  }
  const pods = all.filter(ready);
  assert.equal(pods.filter((p) => role(p) === 'web').length, 1, 'Sizing requires one ready web frontend');
  const proxyCount = pods.filter((p) => role(p) === 'proxy').length;
  assert.ok(proxyCount >= 2 && proxyCount <= 4, 'Sizing must retain the approved ready proxy floor/ceiling');
  const hpa = JSON.parse((await gate.kube(['get', 'hpa', `${gate.config.release}-proxy`, '-o', 'json'])).stdout);
  assert.equal(hpa.spec.minReplicas, 2);
  assert.equal(hpa.spec.maxReplicas, 4);
  assert.equal(hpa.spec.metrics.length, 1);
  assert.deepEqual(hpa.spec.metrics[0].resource.target, { type: 'Utilization', averageUtilization: 75 });
  const metrics = JSON.parse(
    (
      await gate.kube([
        'get',
        '--raw',
        `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(gate.config.namespace)}/pods`,
      ])
    ).stdout,
  );
  const values = gate.values(gate.operation.candidate.images);
  const observations = [];
  let missing = !['AbleToScale', 'ScalingActive'].every((type) =>
    hpa.status?.conditions?.some((c) => c.type === type && c.status === 'True'),
  );
  for (const pod of pods) {
    const name = role(pod),
      container = pod.spec.containers.find((c) => c.name === name);
    const status = pod.status.containerStatuses?.find((c) => c.name === name);
    assert.ok(status?.ready && status.restartCount === 0, 'Sizing container restarted or is unhealthy');
    assert.notEqual(status.lastState?.terminated?.reason, 'OOMKilled');
    const metric = metrics.items.find((m) => m.metadata.name === pod.metadata.name);
    const age = now() - Date.parse(metric?.timestamp);
    const usage = metric?.containers?.find((c) => c.name === name)?.usage;
    if (!usage || !Number.isFinite(age) || age < -5000 || age > 90000) {
      missing = true;
      continue;
    }
    const cpu = resourceQuantity(usage.cpu, 'cpu'),
      memory = resourceQuantity(usage.memory, 'memory');
    assert.ok(Number.isFinite(cpu) && cpu >= 0 && Number.isFinite(memory) && memory >= 0);
    observations.push({
      role: name,
      podUid: pod.metadata.uid,
      cpu,
      memory,
      resources: {
        requested: structuredClone(values.resources[name]),
        admitted: structuredClone(container.resources),
      },
    });
  }
  if (missing) return false; // Read-only wait for metrics; never invent zero usage.
  return {
    observedAt: new Date(now()).toISOString(),
    proxyCount,
    observations,
    hpa: { uid: hpa.metadata.uid, desired: hpa.status?.desiredReplicas, current: hpa.status?.currentReplicas },
  };
}

export async function uploadSizingProject(gate) {
  const project = parse(
    await fs.readFile(
      path.join(root, 'deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project'),
      'utf8',
    ),
  );
  project.data.metadata.id = randomUUID();
  // Valid YAML with an 8 MiB comment exercises normal allowed request buffering
  // without adding expensive workflow work or a new external dependency.
  const contents = stringify(project) + '\n#' + 's'.repeat(8 * 1024 * 1024) + '\n';
  const uploaded = await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/projects/upload', {
    method: 'POST',
    timeoutMs: 60000,
    headers: { 'X-Rivet-Namespace-Intent': '1' },
    body: JSON.stringify({
      folderRelativePath: '',
      mutation: rootStructuralMutation(),
      fileName: `sizing-${project.data.metadata.id}.rivet-project`,
      contents,
    }),
  });
  assert.equal(uploaded.project.id, project.data.metadata.id);
  return { bytes: Buffer.byteLength(contents) };
}

export async function runProviderSizing(
  gate,
  {
    wait = until,
    now = Date.now,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    durationMs = 60000,
    upload = uploadSizingProject,
    observe = observeSizing,
    startWorkflow = startHaWorkflowTraffic,
    startWeb = startHaWebAppTraffic,
  } = {},
) {
  const startedAt = new Date(now()).toISOString();
  const sample = () => wait('fresh sizing measurements', () => observe(gate, now), 90000);
  const observations = [await sample()];
  const workflow = Array.from({ length: 4 }, () => startWorkflow(gate, gate.config.baseUrl, () => 'sizing'));
  const web = startWeb(gate, gate.config.baseUrl, () => 'sizing');
  let uploaded;
  try {
    await gate.verifyPublishedBrowser(gate.config.baseUrl, true);
    uploaded = await upload(gate);
    const end = now() + durationMs;
    do {
      await pause(5000);
      for (const stream of [...workflow, web]) assert.deepEqual(stream.report.failures, []);
      observations.push(await sample());
    } while (now() < end);
    await waitForOrdinaryRuntime(gate, gate.operation.candidate.images, wait);
    await gate.frontendAvailability();
    observations.push(await sample());
  } finally {
    const stopped = await Promise.allSettled([...workflow, web].map((stream) => stream.stop()));
    assert.ok(
      stopped.every((r) => r.status === 'fulfilled'),
      'Sizing traffic did not settle',
    );
  }
  const combine = (streams) => ({
    samples: streams.reduce((n, s) => n + s.report.samples, 0),
    failures: streams.flatMap((s) => s.report.failures),
  });
  const report = {
    purpose: 'resource-sizing',
    outcome: 'passed',
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    requests: gate.operation.sizingRequests,
    upload: uploaded,
    observations,
    workflow: combine(workflow),
    web: combine([web]),
    checks: Object.fromEntries(
      ['admission', 'browser', 'upload', 'traffic', 'health', 'metrics', 'hpa'].map((c) => [c, true]),
    ),
  };
  for (const stream of [report.workflow, report.web]) {
    assert.ok(stream.samples > 0);
    assert.deepEqual(stream.failures, []); // Includes the last in-flight request.
  }
  await gate.artifact('resource-sizing.json', JSON.stringify(report));
  return report;
}
