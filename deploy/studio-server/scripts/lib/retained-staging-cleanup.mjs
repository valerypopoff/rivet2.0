import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
        const containerName = pod.metadata.labels['app.kubernetes.io/component'] === 'backend' ? 'backend' : 'api';
        const container = pod.spec.containers.find((item) => item.name === containerName);
        assert.ok(container, 'Retained work container is missing');
        const profile = container.env?.find((item) => item.name === 'RIVET_API_PROFILE');
        // A split control backend never initializes published-execution admission
        // or its gauge. Combined backends and every execution worker still must
        // report an explicit zero; a missing metric is not evidence of no work.
        if (containerName === 'backend' && profile?.value === 'control' && !profile.valueFrom) continue;
        const metrics = await state.api.exec(
          `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod.metadata.name)}/exec`,
          executionSampleCommand(8080),
          { container: containerName },
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

async function cleanupFixtureProjects(state, gate, folder) {
  assert.ok(Array.isArray(folder.projects) && Array.isArray(folder.folders));
  assert.equal(folder.folders.length, 0, 'Unexpected nested fixture folder');
  const owned = folder.projects;
  let { record } = await state.read();
  if (!record.fixtureProjects) {
    const projects = owned.map(({ id, relativePath, revisionId }) => {
      assert.ok(id && revisionId && path.posix.dirname(relativePath) === folder.relativePath);
      return { id, relativePath, revisionId };
    });
    await state.change((current) => {
      current.fixtureProjects = projects;
    });
    record = (await state.read()).record;
  }
  const projects = record.fixtureProjects;
  assert.ok(
    owned.every((item) => projects.some((p) => p.id === item.id && p.relativePath === item.relativePath)),
    'Fixture project inventory changed during cleanup',
  );
  const write = async (key, route, body) => {
    await state.change((current) => {
      current.fixtureProjectWrites ??= {};
      assert.ok(
        !Object.hasOwn(current.fixtureProjectWrites, key),
        'Fixture write acknowledgement is unknown; observe without replay',
      );
      current.fixtureProjectWrites[key] = { route, body };
    });
    await gate.requestWorkflow(gate.config.baseUrl, route, {
      method: 'POST',
      headers: { 'X-Rivet-Namespace-Intent': '1' },
      body: JSON.stringify(body),
    });
  };
  for (const project of projects) {
    if (!owned.some((item) => item.id === project.id && item.relativePath === project.relativePath)) {
      assert.ok(
        record.fixtureProjectWrites?.[`${project.id}:delete`],
        'Fixture project disappeared without deletion intent',
      );
      continue;
    }
    const snapshot = async () => {
      const value = await gate.requestWorkflow(
        gate.config.baseUrl,
        `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(project.relativePath)}`,
      );
      assert.equal(value.projectId, project.id, 'Fixture project was replaced');
      assert.equal(value.draftRevisionId, project.revisionId, 'Fixture project changed during cleanup');
      assert.ok(
        typeof value.publicationVersion === 'string' && value.publicationVersion && Array.isArray(value.webApps),
      );
      return value;
    };
    const preconditions = (value) => ({
      expectedProjectId: value.projectId,
      expectedDraftRevisionId: value.draftRevisionId,
      expectedPublicationVersion: value.publicationVersion,
    });
    let current = await snapshot();
    for (const app of current.webApps.filter((item) => item.status !== 'unpublished')) {
      assert.ok(app.uiGraphId);
      await write(`${project.id}:web:${app.uiGraphId}`, '/api/workflows/projects/web-apps/unpublish', {
        relativePath: project.relativePath,
        uiGraphId: app.uiGraphId,
        preconditions: preconditions(current),
      });
      current = await snapshot(); // Every publication mutation advances its version.
    }
    assert.ok(['published', 'unpublished_changes', 'unpublished'].includes(current.project?.settings?.status));
    if (current.project.settings.status !== 'unpublished') {
      await write(`${project.id}:endpoint`, '/api/workflows/projects/unpublish', {
        relativePath: project.relativePath,
        preconditions: preconditions(current),
      });
      current = await snapshot();
    }
    assert.equal(current.project.settings.status, 'unpublished');
    assert.ok(current.webApps.every((item) => item.status === 'unpublished'));
    await write(`${project.id}:delete`, '/api/workflows/namespace/mutate', {
      operationId: randomUUID(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      command: { kind: 'delete', itemType: 'project', relativePath: project.relativePath },
      expectedSource: { id: project.id, revisionId: project.revisionId },
    });
  }
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
      await cleanupFixtureProjects(state, gate, folder);
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
