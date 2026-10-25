import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { maintenanceValidationValues } from './lib/managed-release-cutover.mjs';
import { createMaintenanceValidationValues, getMaintenanceValidationTargets } from './lib/maintenance-validation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function render({ overlays = [], sameLayout = false, haRequested = false, overrides = [] } = {}) {
  const values = createMaintenanceValidationValues(maintenanceValidationValues, { sameLayout, haRequested });
  return parseAllDocuments(
    execFileSync(
      resolveHelmBinOrThrow(root),
      [
        'template',
        'rivet',
        'deploy/studio-server/helm',
        '-f',
        'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
        ...overlays.flatMap((name) => ['-f', `deploy/studio-server/helm/overlays/${name}.yaml`]),
        '-f',
        '-',
        '--set',
        'objectStorage.bucket=fixture',
        '--set',
        'postgres.maxConnections=500',
        ...overrides.flatMap((value) => ['--set', value]),
      ],
      { cwd: root, input: JSON.stringify(values), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ),
  )
    .map((document) => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON();
    })
    .filter(Boolean);
}
function podsFor(resources) {
  return resources
    .filter((resource) => ['Deployment', 'StatefulSet'].includes(resource.kind))
    .flatMap((owner) =>
      Array.from({ length: owner.spec.replicas ?? 1 }, (_, index) => ({
        metadata: {
          name: `${owner.metadata.name}-${index}`,
          labels: structuredClone(owner.spec.template.metadata.labels),
        },
        spec: structuredClone(owner.spec.template.spec),
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      })),
    );
}
const ha = ['gke-ha', 'gke-runtime-ha', 'gke-compact-edge', 'gke-runtime-autoscaling'];

test('maintenance values preserve same-layout HA but keep fenced legacy adoption compatible with compact candidates', () => {
  const original = structuredClone(maintenanceValidationValues);
  const same = createMaintenanceValidationValues(maintenanceValidationValues, { sameLayout: true, haRequested: true });
  assert.equal(same.ha, undefined);
  assert.equal(same.availability, undefined);
  assert.equal(same.workflowSchema.maintenanceValidation, true);
  assert.deepEqual(same.replicaCount, { proxy: 0, web: 0, evaluation: 0 });
  assert.ok(Object.values(same.autoscaling).every((value) => value.enabled === false));
  const adopting = createMaintenanceValidationValues(maintenanceValidationValues, {
    sameLayout: false,
    haRequested: true,
  });
  assert.equal(adopting.ha.enabled, false);
  assert.equal(adopting.ha.controlPlane.mode, 'replicated');
  assert.equal(adopting.replicaCount.backend, 1);
  assert.equal(adopting.availability.gkeGatewayProfile, 'regional');
  assert.deepEqual(maintenanceValidationValues, original);
  assert.throws(() => createMaintenanceValidationValues(original, { sameLayout: true, haRequested: false }), /layout/);
  // A compact target must render in both existing-HA and initial-adoption modes.
  assert.ok(render({ overlays: ha, haRequested: true }).length);
  assert.throws(() => render({ overrides: ['autoscaling.web.enabled=true'] }), /maintenance validation requires/);
});

test('same-layout compact HA validates every API pod using its real container and custom API port', () => {
  const resources = render({
    overlays: ha,
    sameLayout: true,
    haRequested: true,
    overrides: ['service.api.targetPort=8181', 'service.execution.targetPort=8282'],
  });
  const targets = getMaintenanceValidationTargets(resources, podsFor(resources));
  assert.deepEqual(
    targets.map(({ container, port }) => ({ container, port })),
    [
      { container: 'backend', port: 8181 },
      { container: 'api', port: 8282 },
      { container: 'api', port: 8282 },
    ],
  );
  assert.equal(new Set(targets.map((target) => target.podName)).size, 3);
});

test('replicated HA validates dedicated maintenance and all editor/execution owners', () => {
  const resources = render({ overlays: ['gke-ha'], sameLayout: true, haRequested: true });
  const targets = getMaintenanceValidationTargets(resources, podsFor(resources));
  assert.equal(targets.filter((target) => target.container === 'backend').length, 3);
  assert.equal(targets.filter((target) => target.container === 'api').length, 2);
});

test('single-machine validation probes backend and execution in the same pod, while legacy uses api', () => {
  const resources = render({ overlays: ['single-machine'] });
  const targets = getMaintenanceValidationTargets(resources, podsFor(resources));
  assert.deepEqual(
    targets.map(({ container, port }) => ({ container, port })),
    [
      { container: 'backend', port: 8081 },
      { container: 'execution', port: 8082 },
    ],
  );
  assert.equal(new Set(targets.map((target) => target.podName)).size, 1);
  const legacy = render({
    overrides: ['compatibility.legacyStartupSettingsFiles=true', 'workflowSchema.migrationJob.enabled=false'],
  });
  const legacyTargets = getMaintenanceValidationTargets(legacy, podsFor(legacy));
  assert.equal(legacyTargets.length, 3);
  assert.ok(legacyTargets.every((target) => target.container === 'api'));
});

test('validation refuses stale, unfenced, mismatched, missing, extra or unready pods', () => {
  const resources = render();
  for (const change of [
    (pods) => {
      pods[0].spec.containers[0].image = 'old-image';
    },
    (pods) => {
      pods[0].spec.containers[0].env.find((entry) => entry.name === 'RIVET_RELEASE_MAINTENANCE').value = 'false';
    },
    (pods) => {
      pods[0].spec.containers[0].env.find((entry) => entry.name === 'PORT').value = '1234';
    },
    (pods) => {
      pods[0].spec.containers[0].ports[0].containerPort = 1234;
    },
    (pods) => {
      pods[0].metadata.deletionTimestamp = 'now';
    },
    (pods) => {
      pods[0].status.conditions[0].status = 'False';
    },
    (pods) => {
      pods[0].status.phase = 'Pending';
    },
    (pods) => {
      pods.pop();
    },
    (pods) => {
      pods.push(structuredClone(pods[0]));
    },
  ]) {
    const pods = podsFor(resources);
    change(pods);
    assert.throws(() => getMaintenanceValidationTargets(resources, pods), /Maintenance validation/);
  }
});

test('validation refuses ambiguous or unfenced rendered API definitions rather than skipping them', () => {
  const original = render();
  for (const change of [
    (container) => {
      container.env = container.env.filter((entry) => entry.name !== 'RIVET_RELEASE_MAINTENANCE');
    },
    (container) => {
      container.env.push({ name: 'RIVET_RELEASE_MAINTENANCE', value: 'true' });
    },
    (container) => {
      container.env.find((entry) => entry.name === 'PORT').valueFrom = { secretKeyRef: { name: 'unknown' } };
    },
    (container) => {
      container.ports.push({ name: 'http', containerPort: 80 });
    },
    (container) => {
      container.ports.find((port) => port.name === 'api-http').containerPort = 0;
    },
  ]) {
    const resources = structuredClone(original);
    const container = resources.find((owner) => owner.kind === 'StatefulSet').spec.template.spec.containers[0];
    change(container);
    assert.throws(() => getMaintenanceValidationTargets(resources, podsFor(resources)), /Maintenance validation/);
  }
  assert.throws(() => getMaintenanceValidationTargets([], []), /no fenced API targets/);
});
