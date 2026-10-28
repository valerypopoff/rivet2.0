import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';
import { reusableStagingSettings, ReusableStagingState, stagingOwner } from './lib/reusable-staging-state.mjs';
import {
  stopExpiredStagingWriter,
  settleStaging,
  cleanupStaging,
  verifyStagingCleanup,
} from './lib/reusable-staging-cleanup.mjs';
import { stagingCloudReader } from './lib/reusable-staging-cloud.mjs';

export async function stagingJanitorPass({ api, cloud, settings, owner, wait, now = Date.now }) {
  await cloud.project();
  const cluster = await api.json('GET', '/api/v1/namespaces/kube-system');
  assert.equal(cluster?.metadata.uid, settings.clusterUid);
  const pod = await api.json('GET', `/api/v1/namespaces/${settings.controlNamespace}/pods/${owner.name}`);
  assert.equal(pod?.metadata.uid, owner.uid);
  assert.ok(!pod.metadata.deletionTimestamp);
  const root = `/api/v1/namespaces/${settings.controlNamespace}/configmaps`;
  const healthPath = `${root}/rivet-qualification-janitor-health`;
  const previous = await api.json('GET', healthPath);
  assert.ok(previous);
  const before = JSON.parse(previous.data?.health ?? '{}');
  if (before.podUid && before.podUid !== owner.uid) {
    const old = await api.json('GET', `/api/v1/namespaces/${settings.controlNamespace}/pods/${before.podName}`);
    assert.ok(!old || old.metadata.uid !== before.podUid, 'A live/paused previous janitor blocks takeover');
  }
  await api.json('PUT', healthPath, {
    ...previous,
    data: {
      health: JSON.stringify({
        clusterUid: settings.clusterUid,
        driverDigest: settings.approvedDriverDigest,
        podName: owner.name,
        podUid: owner.uid,
        observedAt: now(),
      }),
    },
  });
  const records = await api.json('GET', `${root}?labelSelector=${encodeURIComponent(stagingOwner)}`);
  const outcomes = [];
  for (const object of records.items) {
    let operation;
    try {
      const record = JSON.parse(object.data.record);
      operation = record.operation;
      const { inputHash, ...input } = operation;
      assert.equal(qualificationHash(input), inputHash, 'Operation input changed');
      assert.equal(
        operation.driverBundleSha256,
        settings.approvedDriverDigest,
        'Janitor has not approved this driver version',
      );
      if (record.cleanupVerified || Date.parse(operation.expiresAt) > now()) continue;
      assert.ok(Number.isFinite(Date.parse(operation.expiresAt)));
      const state = new ReusableStagingState(api, settings, operation);
      await state.read();
      await stopExpiredStagingWriter(state, wait);
      const current = (await state.read()).record;
      if (!current.namespaceDeleteIssued) {
        await settleStaging(state, cloud, owner, wait);
        await cleanupStaging(state, owner);
      } else await state.claimCleanup(owner, { expired: true });
      const verified = await verifyStagingCleanup(state, cloud);
      outcomes.push({
        operationId: operation.operationId,
        status: verified ? 'cleaned' : 'awaiting-controller-cleanup',
      });
    } catch {
      outcomes.push({
        operationId: operation?.operationId ?? object.metadata.name,
        status: 'blocked-inspect-private-registry',
      });
    }
  }
  return outcomes;
}

async function main() {
  const settings = reusableStagingSettings(
    JSON.parse(await fs.readFile(process.env.RIVET_QUALIFICATION_SETTINGS_FILE, 'utf8')),
  );
  const owner = { namespace: settings.controlNamespace, name: process.env.POD_NAME, uid: process.env.POD_UID };
  assert.ok(owner.name && owner.uid);
  const WebSocketClass = createRequire('/app/packages/studio-server-api/package.json')('ws');
  const api = createKubernetesTransport({ origin: settings.clusterServer, WebSocketClass });
  const cloud = stagingCloudReader(settings);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      stopping = true;
    });
  const wait = async (label, check) => {
    const until = Date.now() + 180000;
    while (!(await check())) {
      assert.ok(!stopping && Date.now() < until, `Janitor blocked: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  let previous = '';
  while (!stopping) {
    const results = await stagingJanitorPass({ api, cloud, settings, owner, wait });
    const current = JSON.stringify(results);
    if (current !== previous) {
      console.log(current);
      previous = current;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
