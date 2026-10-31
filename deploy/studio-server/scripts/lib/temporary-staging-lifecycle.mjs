import assert from 'node:assert/strict';
import {
  temporaryAdmission,
  temporaryBinding,
  temporaryCleanupReceipt,
  completedTemporaryCleanup,
} from './temporary-staging-contract.mjs';
import { temporaryFoundationSpecs, TemporaryCloudError } from './temporary-staging-gcp.mjs';
import { settleTemporaryProviderChildren, removeTemporaryNetworkRules } from './temporary-staging-network.mjs';

export async function provisionTemporaryEnvironment(store, cloud, runtime, { wait, guard, now = Date.now } = {}) {
  store.assertLocked();
  let { record } = await store.read();
  const plan = record.plan;
  assert.equal(record.phase, 'planned', 'Never replay infrastructure provisioning; inspect the existing operation');
  await runtime.offlinePreflight(plan); // Actual pinned image/tools, before any provider mutation.
  await guard(plan);
  await cloud.project();
  const accounts = await cloud.preflight();
  const baseline = await cloud.snapshot();
  for (const spec of temporaryFoundationSpecs(plan))
    assert.equal(await cloud.get(spec), null, 'A reserved resource already exists');
  record = await store.change((r) => {
    r.accounts = accounts;
    r.baseline = baseline;
    r.phase = 'provisioning';
  });
  for (const spec of temporaryFoundationSpecs(plan)) {
    temporaryAdmission(record, { now: now() });
    await guard(plan);
    await cloud.project();
    record = await store.change((r) => {
      if (spec.billable && !r.firstBillableIntentAt) {
        const activation = now();
        r.firstBillableIntentAt = new Date(activation).toISOString();
        r.expiresAt = new Date(activation + plan.allowance.maxSeconds * 1000).toISOString();
      }
      r.resources.push({
        key: spec.key,
        kind: spec.kind,
        billable: spec.billable,
        createIssued: true,
        createAt: new Date(now()).toISOString(),
      });
    });
    let operation;
    try {
      operation = await cloud.create(spec);
    } catch (error) {
      if (error instanceof TemporaryCloudError && [400, 401, 403, 409, 412, 429].includes(error.status))
        await store.change((r) => {
          r.resources.find((x) => x.key === spec.key).rejected = true;
        });
      throw error;
    }
    await store.change((r) => {
      r.resources.find((x) => x.key === spec.key).createOperation = operation;
    });
    await cloud.wait(spec, operation, { wait, checkpoint: () => guard(plan) });
    const actual = await cloud.get(spec),
      identity = cloud.identity(spec, actual);
    assert.ok(identity);
    if (operation.targetId)
      assert.equal(String(operation.targetId), identity.id, 'Create operation identity differs from observed resource');
    record = await store.change((r) => {
      Object.assign(
        r.resources.find((x) => x.key === spec.key),
        { identity, createObserved: true },
      );
      if (spec.billable && !r.firstBillableActivation) r.firstBillableActivation = new Date(now()).toISOString();
    });
  }
  temporaryAdmission(record, { now: now(), tests: true });
  await runtime.bootstrap(store, cloud, { wait, guard });
  await guard(plan);
  record = await store.change((r) => {
    r.phase = 'environment-ready';
  });
  return temporaryBinding(record, record.identities);
}

/** Inspection never retries a modifying request. A previously unknown create
 * may only be associated with this exact immutable input/nonce, not its name. */
export async function inspectTemporaryEnvironment(store, cloud) {
  store.assertLocked();
  await cloud.project();
  const { record } = await store.read();
  for (const item of record.resources) {
    if (!item.createIssued || item.rejected || !temporaryFoundationSpecs(record.plan).some((s) => s.key === item.key))
      continue;
    const spec = temporaryFoundationSpecs(record.plan).find((s) => s.key === item.key),
      actual = await cloud.get(spec);
    if (!actual) {
      assert.ok(
        item.identity && item.deleteIssued,
        'A creation outcome remains unknown; absence is not a rejected write',
      );
      await store.change((r) => {
        r.resources.find((x) => x.key === item.key).absent = true;
      });
      continue;
    }
    const identity = cloud.identity(spec, actual);
    if (item.identity) assert.equal(identity.id, item.identity.id, 'Resource incarnation changed');
    else {
      // Fixed unique description/labels plus a recorded prior absence, complete
      // operation ownership and a fresh immutable ID establish observed creation.
      assert.equal(record.phase === 'planned', false);
      await store.change((r) => {
        Object.assign(
          r.resources.find((x) => x.key === item.key),
          { identity, createObserved: true },
        );
      });
    }
  }
  return (await store.read()).record;
}

export async function cleanupTemporaryEnvironment(store, cloud, runtime, { wait, now = Date.now } = {}) {
  store.assertLocked();
  const before = (await store.read()).record;
  if (before.complete) return completedTemporaryCleanup(before);
  // Local issuance must settle even when the provider/cluster API is unavailable.
  await runtime.settleCertificate?.(store, { wait });
  await cloud.project();
  if (!before.resources.length && before.phase === 'planned') {
    const receipt = temporaryCleanupReceipt(before, new Date(now()).toISOString());
    await store.change((r) => {
      r.closed = true;
      r.complete = true;
      r.cleanupVerified = true;
      r.phase = 'cleaned-unactivated';
      r.finishedAt = receipt.verifiedAt;
      r.cleanupReceipt = receipt;
    });
    return structuredClone(receipt);
  }
  await store.change((r) => {
    r.closed = true;
    if (!r.writersStopped) r.phase = 'settling';
  });
  let record = await inspectTemporaryEnvironment(store, cloud);
  // Bootstrap may have failed before actor/fixture creation. The concrete
  // runtime also inventories partially acknowledged Kubernetes writes.
  if (!record.writersStopped) {
    const evidenceExported = await runtime.settleAndExport(store, cloud, { wait });
    record = await store.change((r) => {
      r.writersStopped = true;
      r.acceptedWorkSettled = true;
      r.evidenceExported = evidenceExported === true;
      r.phase = 'removing-edge';
    });
  } else assert.equal(record.acceptedWorkSettled, true);
  await runtime.removeEdgeAndBootstrap(store, cloud, { wait });
  for (const spec of temporaryFoundationSpecs(record.plan).reverse()) {
    if (spec.key !== 'cluster') await settleTemporaryProviderChildren(store, cloud, wait);
    const item = (await store.read()).record.resources.find((r) => r.key === spec.key);
    if (!item || item.rejected || item.absent) continue;
    assert.ok(item.identity, 'Uncertain creation blocks deletion');
    if (spec.key === 'network') await removeTemporaryNetworkRules(store, cloud, wait);
    const actual = await cloud.get(spec);
    if (!actual) {
      assert.ok(item.deleteIssued, 'Recorded resource disappeared without removal intent');
    } else {
      assert.equal(cloud.identity(spec, actual).id, item.identity.id, 'Resource was replaced; do not delete');
      if (!item.deleteIssued) {
        await store.change((r) => {
          r.resources.find((x) => x.key === spec.key).deleteIssued = true;
        });
        const op = await cloud.remove(spec);
        await store.change((r) => {
          r.resources.find((x) => x.key === spec.key).deleteOperation = op;
        });
        if (op.targetId) assert.equal(String(op.targetId), item.identity.id, 'Delete operation identity changed');
        await cloud.wait(spec, op, { wait });
      } else if (item.deleteOperation) await cloud.wait(spec, item.deleteOperation, { wait });
      else throw Error('Unacknowledged deletion remains pending; inspect instead of redispatching');
      await wait('exact resource absence', async () => {
        const value = await cloud.get(spec);
        if (!value) return true;
        assert.equal(cloud.identity(spec, value).id, item.identity.id, 'Resource replaced during deletion');
        return false;
      });
    }
    await store.change((r) => {
      r.resources.find((x) => x.key === spec.key).absent = true;
    });
  }
  await runtime.removePermissions(store, cloud);
  const current = await cloud.snapshot();
  record = (await store.read()).record;
  assert.ok(!record.certificateWorker || record.certificateWorker.removed, 'Certificate worker cleanup is unverified');
  assert.ok(Array.isArray(record.baseline), 'Missing original cloud inventory blocks cleanup certification');
  const previous = new Set(record.baseline.map((x) => `${x.kind}:${x.id}`));
  const remaining = current.filter((x) => !previous.has(`${x.kind}:${x.id}`));
  const receipt = remaining.length === 0 ? temporaryCleanupReceipt(record, new Date(now()).toISOString()) : null;
  await store.change((r) => {
    r.residualResources = remaining;
    r.phase = remaining.length ? 'cleanup-blocked' : 'cleaned';
    r.complete = remaining.length === 0;
    r.cleanupVerified = remaining.length === 0;
    if (r.complete) {
      r.finishedAt = receipt.verifiedAt;
      r.cleanupReceipt = receipt;
    }
  });
  assert.equal(remaining.length, 0, 'New provider resources remain; inspect exact residual identities');
  return structuredClone(receipt);
}

export async function runTemporaryQualification(store, cloud, runtime, options) {
  store.assertLocked();
  let result, failure, cleanup;
  try {
    const { record } = await store.read();
    temporaryAdmission(record, { now: options.now?.() ?? Date.now(), tests: true });
    assert.equal(record.phase, 'environment-ready');
    await store.change((r) => {
      r.phase = 'qualifying';
      r.qualificationIssued = true;
    });
    result = await runtime.qualify(store, cloud, options);
    await store.change((r) => {
      r.fixtureResult = result;
      r.testsPassed = true;
    });
  } catch (e) {
    failure = e;
  } finally {
    try {
      cleanup = await cleanupTemporaryEnvironment(store, cloud, runtime, options);
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure)
    throw Error('Temporary qualification failed; inspect the private journal and residual inventory', {
      cause: failure,
    });
  assert.equal(cleanup.cleanupVerified, true);
  assert.equal((await store.read()).record.evidenceExported, true, 'Terminal qualification evidence is unavailable');
  const declarations = Object.fromEntries(
    ['control', 'autoscaling'].map((key) => [key, { ...result[key], protocol: 2, temporaryEnvironment: cleanup }]),
  );
  return {
    ...result,
    ...declarations,
    environmentCleanup: cleanup,
    status: cloud.simulation ? 'local-functional-only' : 'qualified',
  };
}
