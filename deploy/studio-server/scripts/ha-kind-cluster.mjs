import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runManagedGateCommand as run } from './kubernetes-managed-release-gate.mjs';
import { haProofRunIdentity, HA_PROOF_SCENARIOS } from './lib/ha-scenario-evidence.mjs';

export const HA_KIND_CLUSTERS = {
  upgrade: 'rivet-managed-release',
  lostAcknowledgement: 'rivet-ha-lost-acknowledgement',
  leaseLoss: 'rivet-ha-lease-loss',
};
const rootDir = fileURLToPath(new URL('../../../', import.meta.url));

/** A dedicated kubeconfig and exact container IDs keep cancellation/failure
 * cleanup away from ambient local clusters. Partial unknown creation is held. */
export async function manageHaKindCluster(action, { receipt, kubeconfig, owner, command = run }) {
  assert.ok(receipt && kubeconfig && owner, 'Cluster receipt, kubeconfig and owner are required');
  assert.ok(HA_PROOF_SCENARIOS.includes(owner.scenario), 'Invalid cluster scenario');
  const cluster = HA_KIND_CLUSTERS[owner.scenario];
  const list = async () =>
    (
      await command('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=io.x-k8s.kind.cluster=${cluster}`], {
        capture: true,
      })
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort();
  if (action === 'create') {
    assert.equal((await list()).length, 0, 'A cluster with the proof name already exists; nothing was changed');
    await fs.mkdir(path.dirname(receipt), { recursive: true });
    const intent = { version: 1, cluster, owner, state: 'creating', kubeconfig: path.resolve(kubeconfig) };
    await fs.writeFile(receipt, JSON.stringify(intent), { flag: 'wx' });
    await fs.mkdir(path.dirname(intent.kubeconfig), { recursive: true });
    // Reserve our private path; Kind may update only the file we just created.
    await fs.writeFile(intent.kubeconfig, '', { flag: 'wx', mode: 0o600 });
    await command('kind', [
      'create',
      'cluster',
      '--name',
      cluster,
      '--kubeconfig',
      intent.kubeconfig,
      '--config',
      path.join(rootDir, 'deploy/studio-server/scripts/kind-managed-release-cluster.yaml'),
    ]);
    const ids = await list();
    assert.equal(ids.length, 4, 'Kind node inventory is incomplete; inspect the creation receipt');
    const nodes = JSON.parse((await command('docker', ['inspect', ...ids], { capture: true })).stdout);
    assert.ok(nodes.every((n) => ids.includes(n.Id) && n.Config.Labels['io.x-k8s.kind.cluster'] === cluster));
    await fs.writeFile(receipt, JSON.stringify({ ...intent, state: 'owned', ids }));
    return;
  }
  assert.equal(action, 'cleanup', 'Unknown Kind cluster action');
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(receipt, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert.deepEqual(saved.owner, owner, 'Cluster receipt belongs to another run or attempt');
  assert.equal(saved.version, 1);
  assert.equal(saved.cluster, cluster);
  if (saved.state === 'removed') return;
  assert.equal(saved.state, 'owned', 'Uncertain Kind creation; automatic cleanup refused');
  const current = await list();
  assert.ok(
    current.every((id) => saved.ids.includes(id)),
    'Kind node inventory changed; cleanup refused',
  );
  if (current.length) {
    const nodes = JSON.parse((await command('docker', ['inspect', ...current], { capture: true })).stdout);
    assert.ok(
      nodes.length === current.length &&
        nodes.every((n) => current.includes(n.Id) && n.Config.Labels['io.x-k8s.kind.cluster'] === cluster),
      'Kind node ownership changed',
    );
    // Removing immutable IDs cannot select a replacement container by name.
    await command('docker', ['rm', '-f', '--volumes', ...current]);
  }
  assert.equal((await list()).length, 0, 'Kind cleanup is incomplete');
  await fs.writeFile(receipt, JSON.stringify({ ...saved, state: 'removed' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await manageHaKindCluster(process.argv[2], {
    receipt: process.env.RIVET_HA_CLUSTER_RECEIPT,
    kubeconfig: process.env.KUBECONFIG,
    owner: { ...haProofRunIdentity(process.env), scenario: process.env.RIVET_HA_SCENARIO },
  });
}
