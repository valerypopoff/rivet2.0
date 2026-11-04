import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executionSampleCommand } from './execution-autoscaler-kubernetes.mjs';
import { settleStagingProcesses } from './reusable-staging-cleanup.mjs';
import { qualificationHash } from './runtime-qualification-execution.mjs';

export async function settleRetainedStaging(state, owner, wait) {
  await state.claimCleanup(owner);
  if (!(await state.application.reconcileAcquisition())) {
    await state.change((record) => {
      record.phase = 'settled';
      record.acceptedWorkSettled = true;
      record.retainedCleanup = {
        phase: 'not-acquired',
        operationId: state.operation.operationId,
        healthy: false,
        dataCleaned: true,
      };
    });
    return [];
  }
  await settleStagingProcesses(state, wait);
  const { record } = await state.read(),
    ns = encodeURIComponent(record.namespace);
  if (record.fixtureFolder && !['idle', 'quarantined'].includes(record.retainedCleanup?.phase))
    await wait('retained staging accepted work completion', async () => {
      const list = async () =>
        state.api.json(
          'GET',
          `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${record.release}`)}`,
        );
      const pods = (await list()).items.filter((pod) =>
        ['backend', 'execution'].includes(pod.metadata.labels?.['app.kubernetes.io/component']),
      );
      if (!pods.length) return false;
      const controllers = (
        await Promise.all(
          ['statefulsets', 'deployments'].map((kind) =>
            state.api.json(
              'GET',
              `/apis/apps/v1/namespaces/${ns}/${kind}?labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${record.release}`)}`,
            ),
          ),
        )
      ).flatMap((item) => item.items);
      for (const pod of pods) {
        assert.ok(
          pod.metadata.ownerReferences?.some(
            (ref) =>
              ref.controller &&
              controllers.some(
                (controller) => controller.metadata.uid === ref.uid && controller.metadata.name === ref.name,
              ),
          ),
          'Retained work owner is foreign',
        );
        if (pod.metadata.deletionTimestamp || pod.status.phase !== 'Running') return false;
        const metrics = await state.api.exec(
          `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod.metadata.name)}/exec`,
          executionSampleCommand(8080),
          { container: pod.metadata.labels['app.kubernetes.io/component'] === 'backend' ? 'backend' : 'api' },
        );
        const samples = metrics
          .split('\n')
          .filter((line) => /^rivet_published_execution_active_runs(?:\{| )/.test(line));
        assert.equal(samples.length, 1, 'Accepted work inventory is unconfirmed');
        const active = Number(samples[0].trim().split(/\s+/).at(-1));
        assert.ok(Number.isFinite(active) && active >= 0);
        if (active > 0) return false;
      }
      const after = (await list()).items.filter((pod) =>
        ['backend', 'execution'].includes(pod.metadata.labels?.['app.kubernetes.io/component']),
      );
      return (
        JSON.stringify(pods.map((pod) => pod.metadata.uid).sort()) ===
        JSON.stringify(after.map((pod) => pod.metadata.uid).sort())
      );
    });
  await state.change((current) => {
    current.phase = 'settled';
    current.inventory = [];
    current.acceptedWorkSettled = true;
  });
  return [];
}

export async function cleanupRetainedStaging(state, gate, owner, { qualificationPassed = false } = {}) {
  assert.equal(typeof qualificationPassed, 'boolean');
  const { record } = await state.read();
  assert.ok(
    record.closed && record.cleanupOwner.uid === owner.uid && record.phase === 'settled' && record.acceptedWorkSettled,
  );
  if (['not-acquired', 'idle', 'quarantined'].includes(record.retainedCleanup?.phase)) return record.retainedCleanup;
  let healthy = false,
    dataCleaned = false;
  if (qualificationPassed && record.testPhases?.upgrade?.state === 'acknowledged' && record.fixtureFolder && gate) {
    gate.cleanupOwner = owner;
    await gate.retainedSecrets();
    await gate.loadWorkflowKey();
    const tree = await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/tree');
    assert.ok(Array.isArray(tree.folders));
    const folder = tree.folders.find((item) => item.relativePath === record.fixtureFolder.relativePath);
    if (folder) {
      assert.equal(folder.namespaceId, record.fixtureFolder.namespaceId, 'Fixture folder was replaced');
      assert.ok(!record.fixtureFolderDelete, 'Fixture deletion acknowledgement is unknown; observe without replay');
      const request = {
        operationId: randomUUID(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        command: { kind: 'delete', itemType: 'folder', relativePath: folder.relativePath },
        expectedSource: { id: folder.namespaceId },
      };
      await state.change((current) => {
        current.fixtureFolderDelete = request;
      });
      await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/namespace/mutate', {
        method: 'POST',
        headers: { 'X-Rivet-Namespace-Intent': '1' },
        body: JSON.stringify(request),
      });
    } else assert.ok(record.fixtureFolderDelete, 'Fixture data disappeared without its deletion intent');
    const remaining = await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/tree');
    assert.ok(!remaining.folders.some((item) => item.relativePath === record.fixtureFolder.relativePath));
    dataCleaned = true; // Guarded logical deletion; normal housekeeping owns blob GC.
    await gate.verifyProtectedProxyAvailability();
    await gate.verifyRetainedInstallation(state.operation.candidate);
    await gate.readyPublic();
    healthy = true;
  }
  const receipt = await state.application.finish({
    healthy,
    dataCleaned,
    manifestDigest: healthy ? state.operation.candidateManifestDigest : state.operation.predecessorManifestDigest,
  });
  await state.change((current) => {
    current.retainedCleanup = receipt;
  });
  return receipt;
}

export async function verifyRetainedStagingCleanup(state) {
  const { record } = await state.read(),
    current = await state.application.read();
  if (record.retainedCleanup?.phase === 'not-acquired') {
    assert.equal(await state.application.reconcileAcquisition(), false);
    assert.ok(record.closed && record.acceptedWorkSettled);
    const result = {
      inventoryComplete: true,
      inventoryHash: qualificationHash([]),
      resources: [],
      uncertainWrites: 0,
      retainedApplication: record.retainedCleanup,
    };
    await state.change((value) => {
      value.phase = 'cleaned';
      value.cleanupVerified = true;
    });
    return result;
  }
  const receipt =
    record.retainedCleanup ??
    (current?.record.lastOperationId === state.operation.operationId ? current.record.lastReceipt : null);
  assert.ok(receipt && record.closed && record.acceptedWorkSettled);
  assert.equal(current.object.metadata.uid, record.retainedApplication.uid);
  assert.equal(current.record.lastOperationId, state.operation.operationId);
  assert.ok(['idle', 'quarantined'].includes(current.record.phase) && !current.record.owner);
  const namespace = await state.namespace();
  assert.equal(namespace?.metadata.uid ?? null, record.namespaceUid, 'Retained application namespace changed');
  const result = {
    inventoryComplete: true,
    inventoryHash: qualificationHash([]),
    resources: [],
    uncertainWrites: 0,
    retainedApplication: {
      ...receipt,
      namespaceUid: record.namespaceUid,
      phase: current.record.phase,
      dataDeletion: receipt.dataCleaned ? 'logical' : 'quarantined',
    },
  };
  await state.change((value) => {
    value.phase = 'cleaned';
    value.cleanupVerified = true;
    value.retainedCleanup = result.retainedApplication;
  });
  return result;
}
