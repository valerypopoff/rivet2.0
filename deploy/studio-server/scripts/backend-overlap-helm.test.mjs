import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const namespaceUid = 'f70a25bb-0c5f-44e4-9da4-3b347f87331d';
function render(overrides = []) {
  return spawnSync(
    resolveHelmBinOrThrow(process.cwd()),
    [
      'template',
      'rivet',
      'deploy/studio-server/helm',
      '-n',
      'fixture',
      '-f',
      'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-ha.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-runtime-ha.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-compact-edge.yaml',
      '--set',
      `objectStorage.bucket=fixture,postgres.maxConnections=250,ha.controlPlane.mode=singleton-overlap,ha.namespaceUid=${namespaceUid}`,
      ...overrides.flatMap((value) => ['--set', value]),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}
test('overlap renders one backend, existing RWO storage and backend-only same-node placement', () => {
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  const resources = parseAllDocuments(result.stdout)
    .map((d) => d.toJS())
    .filter(Boolean);
  const backend = resources.find(
    (r) => r.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'backend',
  );
  assert.equal(backend.spec.replicas, 1);
  assert.equal(backend.spec.updateStrategy.type, 'OnDelete');
  const spec = backend.spec.template.spec;
  assert.equal(
    spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey,
    'kubernetes.io/hostname',
  );
  assert.equal(spec.affinity.podAntiAffinity, undefined);
  assert.ok(!spec.topologySpreadConstraints?.length);
  assert.equal(spec.containers.find((c) => c.name === 'backend').resources.requests.memory, '1536Mi');
  const claim = resources.find((r) => r.kind === 'PersistentVolumeClaim');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(
    spec.volumes.find((v) => v.name === 'legacy-restore').persistentVolumeClaim.claimName,
    claim.metadata.name,
  );
  const execution = resources.find(
    (r) => r.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'execution',
  );
  assert.ok(execution.spec.template.spec.affinity.podAntiAffinity);
  assert.equal(
    resources.some((r) => r.metadata.labels?.['app.kubernetes.io/component'] === 'maintenance'),
    false,
  );
  const surge = render(['replicaCount.backend=2', `ha.rolloutResourceVersions.${backend.metadata.name}=123`]);
  assert.equal(surge.status, 0, surge.stderr);
});
test('unowned surge, namespace, shared cache and insufficient connection budget fail closed', () => {
  for (const override of [
    'replicaCount.backend=2',
    'ha.enabled=false',
    'ha.namespaceUid=',
    'runtimeLibraries.cache.enabled=true',
    'postgres.maxConnections=20',
  ]) {
    const result = render([override]);
    assert.notEqual(result.status, 0, `${override} unexpectedly rendered`);
  }
});
