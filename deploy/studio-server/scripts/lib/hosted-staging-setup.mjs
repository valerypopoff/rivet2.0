import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stagingOwner } from './reusable-staging-state.mjs';
import { observeStagingJanitor } from './staging-janitor-health.mjs';

export function setupKubernetes(settings, kubeconfig, run) {
  return (resource, name, namespace = settings.controlNamespace, selector) => {
    const output = run('kubectl', [
      '--kubeconfig',
      kubeconfig,
      '--context',
      settings.context,
      ...(namespace ? ['--namespace', namespace] : []),
      'get',
      resource,
      ...(name ? [name] : []),
      ...(selector ? ['-l', selector] : []),
      '--ignore-not-found',
      '-o',
      'json',
      '--request-timeout=15s',
    ]);
    return output ? JSON.parse(output) : null;
  };
}

export function assertClosedSetupInventory(list) {
  assert.ok(Array.isArray(list?.items) && !list.metadata?.continue, 'Staging registry inventory is incomplete');
  for (const item of list.items) {
    const record = JSON.parse(item.data?.record ?? '{}');
    assert.ok(
      record.cleanupVerified === true && record.phase === 'cleaned' && record.closed === true,
      'An existing staging operation needs cleanup; keep its current janitor',
    );
  }
}

export async function saveStagingSetup(directory, receipt, cloud) {
  const file = path.join(directory, 'staging-setup.json'),
    temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
  if (cloud) await cloud.put(`setup/${receipt.operationId}/receipt.json`, Buffer.from(JSON.stringify(receipt)));
}

export function assertSetupJanitorUpdate(deployment, receipt) {
  assert.equal(deployment?.metadata?.uid, receipt.deploymentUid, 'Cleanup worker Deployment changed');
  const spec = deployment.spec.template.spec;
  const janitor = spec.containers?.find((container) => container.name === 'janitor');
  assert.equal(janitor?.image, receipt.janitorImage, 'Cleanup worker image changed');
  const mount = janitor.volumeMounts?.find((volume) => volume.mountPath === '/qualification');
  assert.equal(
    spec.volumes?.find((volume) => volume.name === mount?.name)?.configMap?.name,
    receipt.codeName,
    'Cleanup worker code changed',
  );
}

/** Only pre-operation setup may be closed here. Never delete a test workload or
 * release a lock after an uncertain apply, changed owner or admitted actor. */
export async function closeStagingSetup({ directory, environment, run, cloudEvidence }) {
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(path.join(directory, 'staging-setup.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'not-started' };
    throw error;
  }
  assert.equal(receipt.protocol, 1);
  assert.equal(receipt.operationId, `rivet-q-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`);
  assert.equal(receipt.sourceSha, environment.GITHUB_SHA);
  if (receipt.closed === true) return { state: 'closed' };
  assert.equal(receipt.writerClosed, true, 'Setup writer closure is unconfirmed; retain the lock');
  assert.match(receipt.generation ?? '', /^[1-9][0-9]*$/, 'Lock acquisition is uncertain; retain the lock');
  assert.ok(
    !receipt.updateIssued || receipt.updateAcknowledged,
    'Shared update acknowledgement is uncertain; retain the lock',
  );
  const { settings } = receipt;
  const read = setupKubernetes(settings, path.join(directory, 'kubeconfig'), run);
  assert.equal(read('namespace', 'kube-system', null)?.metadata.uid, settings.clusterUid, 'Staging cluster changed');
  const cloud = cloudEvidence({ bucket: receipt.bucket, prefix: 'qualification' });
  const owner = Buffer.from(JSON.stringify({ operationId: receipt.operationId, sourceSha: receipt.sourceSha }));
  await cloud.assertOwner(receipt.generation, owner);
  assertClosedSetupInventory(read('configmaps', undefined, settings.controlNamespace, stagingOwner));
  assert.equal(read('configmaps', receipt.operationId), null, 'An operation was admitted; use its normal cleanup');
  assert.equal(
    read('jobs', receipt.operationId, settings.runnerNamespace),
    null,
    'An actor Job exists; use normal cleanup',
  );
  const pods = read('pods', undefined, settings.runnerNamespace, `job-name=${receipt.operationId}`);
  assert.ok(
    Array.isArray(pods?.items) && !pods.metadata?.continue && pods.items.length === 0,
    'Actor absence is unconfirmed',
  );
  const deployment = read('deployments', 'rivet-qualification-janitor');
  if (receipt.updateIssued) assertSetupJanitorUpdate(deployment, receipt);
  else assert.equal(deployment?.metadata?.uid, receipt.deploymentUid, 'Cleanup worker Deployment changed');
  assert.deepEqual(
    deployment.spec,
    receipt.updateIssued ? receipt.appliedSpec : receipt.baselineSpec,
    'Cleanup worker specification changed',
  );
  assert.ok(
    deployment.status?.observedGeneration >= deployment.metadata.generation &&
      !deployment.metadata.deletionTimestamp &&
      deployment.status.availableReplicas === 1 &&
      deployment.status.updatedReplicas === 1,
    'Cleanup worker is not ready',
  );
  const driver = receipt.updateIssued ? receipt.driverDigest : receipt.baselineDriverDigest;
  assert.ok(await observeStagingJanitor(read, settings, driver), 'Independent cleanup worker health is unconfirmed');
  await cloud.put(
    `setup/${receipt.operationId}/closure.json`,
    Buffer.from(
      JSON.stringify({
        operationId: receipt.operationId,
        sourceSha: receipt.sourceSha,
        generation: receipt.generation,
        actorAbsent: true,
        operationAbsent: true,
        janitorHealthy: true,
        observedAt: new Date().toISOString(),
      }),
    ),
  );
  await cloud.assertOwner(receipt.generation, owner);
  await cloud.release(receipt.generation);
  await cloud.assertReleased();
  receipt.closed = true;
  await saveStagingSetup(directory, receipt);
  return { state: 'closed' };
}
