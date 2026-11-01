import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createKubernetesTransport, KubernetesExecOutcomeUnknown } from './execution-autoscaler-kubernetes.mjs';
import { deploymentGoogleToken } from './private-cloud-evidence.mjs';
import { qualificationTimeouts, verifyQualificationDriver } from './runtime-qualification-driver.mjs';
import { verifyTemporaryActorExport } from './temporary-staging-actor.mjs';
import { assertStagingRecord, stagingRecordPath } from './reusable-staging-state.mjs';
import { describeProviderPhaseReceipt } from './provider-phase-receipt.mjs';
import { observeProviderProgress } from './provider-progress.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ready = (pod) =>
  !pod.metadata.deletionTimestamp && pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
export async function waitForStagingActor(label, check, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Error(`Timed out waiting for ${label}`);
}

/** The coordinator uses refreshable, main-workflow-only Google credentials.
 * Its source/configuration stay outside the actor. The actor receives only its
 * in-cluster service-account paths, reviewed bundle and sanitized operation. */
export function coordinatorKubernetes(
  settings,
  { kubeconfig = process.env.KUBECONFIG, token = deploymentGoogleToken, WebSocketClass } = {},
) {
  const config = JSON.parse(
    execFileSync(
      process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
      ['--kubeconfig', kubeconfig, '--context', settings.context, 'config', 'view', '--minify', '--raw', '-o', 'json'],
      { encoding: 'utf8', stdio: 'pipe', windowsHide: true },
    ),
  );
  assert.equal(new URL(config.clusters[0].cluster.server).origin, new URL(settings.clusterServer).origin);
  const ca = config.clusters[0].cluster['certificate-authority-data'];
  WebSocketClass ??= createRequire(new URL('../../../../packages/studio-server-api/package.json', import.meta.url))(
    'ws',
  );
  const make = (timeoutMs) => {
    const client = createKubernetesTransport({
      origin: settings.clusterServer,
      token,
      ca: () => (ca ? Buffer.from(ca, 'base64') : undefined),
      WebSocketClass,
      timeoutMs,
    });
    client.withTimeout = make;
    return client;
  };
  return make(30000);
}

export function stagingActorRole(name) {
  const crud = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name },
    rules: [
      {
        apiGroups: [''],
        resources: [
          'namespaces',
          'pods',
          'pods/exec',
          'pods/log',
          'services',
          'endpoints',
          'secrets',
          'configmaps',
          'persistentvolumeclaims',
          'persistentvolumes',
          'events',
          'serviceaccounts',
        ],
        verbs: crud,
      },
      { apiGroups: [''], resources: ['pods/eviction'], verbs: ['create'] },
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list'] },
      {
        apiGroups: ['apps'],
        resources: ['statefulsets', 'statefulsets/scale', 'deployments', 'deployments/scale', 'replicasets'],
        verbs: crud,
      },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: crud },
      { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'], verbs: crud },
      { apiGroups: ['gateway.networking.k8s.io'], resources: ['gateways', 'httproutes'], verbs: crud },
      { apiGroups: ['networking.gke.io'], resources: ['healthcheckpolicies', 'gcpbackendpolicies'], verbs: crud },
      { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: crud },
      { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: crud },
      {
        apiGroups: ['storage.k8s.io'],
        resources: ['storageclasses', 'volumeattachments'],
        verbs: ['get', 'list', 'watch'],
      },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['metrics.k8s.io'], resources: ['nodes', 'pods'], verbs: ['get', 'list'] },
    ],
  };
}

export function stagingActorJob(operation, settings) {
  assert.match(operation.operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
  assert.match(settings.actorImage, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  const directory = `/qualification/private/${operation.operationId}`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: operation.operationId, namespace: settings.runnerNamespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds:
        Math.ceil((Date.parse(operation.expiresAt) - Date.parse(operation.startedAt)) / 1000) + 3600,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: { 'rivet.dev/qualification-runner': 'true' },
          // This non-retrying Job must survive voluntary Autopilot scale-down.
          // Its existing active deadline still bounds test plus cleanup time.
          annotations: { 'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false' },
        },
        spec: {
          serviceAccountName: 'rivet-qualification-actor',
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 120,
          securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
          containers: [
            {
              name: 'actor',
              image: settings.actorImage,
              command: ['node', '-e', 'setInterval(()=>{},1000)'],
              workingDir: '/app',
              env: [
                { name: 'RIVET_QUALIFICATION_SOURCE_ROOT', value: '/app' },
                { name: 'KUBECONFIG', value: `${directory}/kubeconfig.json` },
                ...['NAME', 'UID'].map((key) => ({
                  name: `POD_${key}`,
                  valueFrom: { fieldRef: { fieldPath: `metadata.${key.toLowerCase()}` } },
                })),
              ],
              resources: {
                requests: { cpu: '1', memory: '2Gi', 'ephemeral-storage': '2Gi' },
                limits: { memory: '4Gi', 'ephemeral-storage': '4Gi' },
              },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              volumeMounts: [
                { name: 'private', mountPath: '/qualification/private' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'private', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

export async function prepareStagingActor(
  operation,
  {
    api,
    settings,
    bundle,
    digest,
    privateDirectory,
    wait = waitForStagingActor,
    persist = async () => {},
    actorWatchIntervalMs = 5000,
    progressIntervalMs = 30000,
    stallAfterMs = 120000,
    onProgress = (status) => console.log(`[qualification] ${JSON.stringify(status)}`),
  },
) {
  assert.ok(Number.isSafeInteger(actorWatchIntervalMs) && actorWatchIntervalMs > 0 && actorWatchIntervalMs <= 30000);
  assert.ok([progressIntervalMs, stallAfterMs].every((ms) => Number.isSafeInteger(ms) && ms > 0));
  const timeoutFor = qualificationTimeouts();
  await verifyQualificationDriver(bundle, digest);
  const system = await api.json('GET', '/api/v1/namespaces/kube-system');
  assert.equal(system.metadata.uid, settings.clusterUid);
  const collection = `/apis/batch/v1/namespaces/${settings.runnerNamespace}/jobs`;
  assert.equal(
    await api.json('GET', `${collection}/${operation.operationId}`),
    null,
    'An actor attempt is never replayed',
  );
  await fs.writeFile(
    path.join(privateDirectory, 'actor-create-intent.json'),
    JSON.stringify(stagingActorJob(operation, settings)),
    { flag: 'wx', mode: 0o600 },
  );
  await persist();
  const job = await api.json('POST', collection, stagingActorJob(operation, settings));
  await fs.writeFile(path.join(privateDirectory, 'actor-job.json'), JSON.stringify(job.metadata), {
    flag: 'wx',
    mode: 0o600,
  });
  await persist();
  const pod = await wait('exact staging actor Ready', async () => {
    const pods = await api.json(
      'GET',
      `/api/v1/namespaces/${settings.runnerNamespace}/pods?labelSelector=${encodeURIComponent(`job-name=${operation.operationId}`)}`,
    );
    assert.ok(pods.items.length <= 1, 'The actor Job must not retry');
    const p = pods.items[0];
    if (!p) return false;
    assert.ok(p.metadata.ownerReferences?.some((r) => r.uid === job.metadata.uid));
    assert.ok(!['Failed', 'Succeeded'].includes(p.status?.phase), 'Actor ended before qualification');
    return ready(p) && p;
  });
  const actorPath = `/api/v1/namespaces/${settings.runnerNamespace}/pods/${pod.metadata.name}`;
  await fs.writeFile(
    path.join(privateDirectory, 'actor-identity.json'),
    JSON.stringify({ job: job.metadata, pod: pod.metadata }),
    { flag: 'wx', mode: 0o600 },
  );
  await persist();
  async function rpc(command, payload, timeoutMs = 600000, observeCompletion, finishDiagnostics) {
    const deadline = performance.now() + timeoutMs;
    const identityApi = api.withTimeout ? api.withTimeout(Math.min(30000, timeoutMs)) : api;
    assert.equal((await identityApi.json('GET', actorPath))?.metadata.uid, pod.metadata.uid, 'Actor was replaced');
    if (performance.now() >= deadline) throw Error('Provider exec deadline exceeded before dispatch');
    const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
    const stderr = [];
    const signal = new AbortController();
    let size = 0,
      finished = false,
      checking,
      actorLoss,
      failure;
    const completion = observeCompletion && Promise.withResolvers();
    const timer =
      completion &&
      setTimeout(() => {
        completion.reject(
          new KubernetesExecOutcomeUnknown('Provider receipt deadline exceeded; command outcome is unknown.'),
        );
        signal.abort();
      }, remaining());
    const monitor = setInterval(() => {
      if (checking || finished) return;
      checking = api
        .json('GET', actorPath)
        .then(async (current) => {
          if (!finished && (current?.metadata.uid !== pod.metadata.uid || !ready(current))) {
            actorLoss = 'Exact actor disappeared, was replaced or stopped being ready';
            completion?.reject(
              new KubernetesExecOutcomeUnknown(`Actor observation aborted: ${actorLoss}; command outcome is unknown.`),
            );
            signal.abort();
            return;
          }
          if (!finished && observeCompletion) {
            const outcome = await observeCompletion(deadline);
            if (!finished && outcome?.state === 'succeeded') {
              completion.resolve(outcome.result);
              // Abort only the transport. No process signal or phase replay.
              signal.abort();
            }
          }
        })
        .catch((error) => {
          if (!finished) {
            actorLoss = 'Actor liveness or phase receipt could not be confirmed';
            completion?.reject(error);
            signal.abort();
          }
        })
        .finally(() => {
          checking = undefined;
        });
    }, actorWatchIntervalMs);
    monitor.unref();
    try {
      const client = api.withTimeout ? api.withTimeout(remaining()) : api;
      const executing = client
        .exec(`${actorPath}/exec`, command, {
          container: 'actor',
          stdin: Buffer.from(JSON.stringify(payload)),
          signal: signal.signal,
          maxOutputBytes: 32 * 1024 * 1024,
          onStderr: (part) => {
            if ((size += part.length) <= 1024 * 1024) stderr.push(part);
          },
        })
        .then(JSON.parse)
        .catch(async (error) => {
          if (!observeCompletion || signal.signal.aborted) throw error;
          const current = await api.json('GET', actorPath);
          assert.ok(current?.metadata.uid === pod.metadata.uid && ready(current), 'Original actor is no longer ready');
          const outcome = await observeCompletion(deadline);
          if (outcome?.state === 'succeeded') return outcome.result;
          // A disconnected exec is not evidence that its registered worker
          // stopped. Observe its durable outcome within the original deadline.
          if (outcome?.state === 'pending' && error instanceof KubernetesExecOutcomeUnknown) return completion.promise;
          throw error;
        });
      const result = await (completion ? Promise.race([executing, completion.promise]) : executing);
      if (observeCompletion) onProgress({ phase: command.at(-1), state: 'command-completed' });
      return result;
    } catch (error) {
      failure = error;
      if (observeCompletion)
        onProgress({ phase: command.at(-1), state: 'failed', diagnostic: 'private-state-snapshot' });
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      clearInterval(monitor);
      try {
        await checking;
        await finishDiagnostics?.();
        if (actorLoss)
          await fs.writeFile(
            path.join(privateDirectory, `actor-loss-${Date.now()}-${randomUUID()}.json`),
            JSON.stringify({ expectedPodUid: pod.metadata.uid, reason: actorLoss, outcome: 'unknown-no-replay' }),
            { flag: 'wx', mode: 0o600 },
          );
        await fs.writeFile(
          path.join(privateDirectory, `actor-${Date.now()}-${randomUUID()}.log`),
          Buffer.concat(stderr),
          { flag: 'wx', mode: 0o600 },
        );
        await persist();
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], 'Remote command and private evidence handling failed');
        throw error;
      }
    }
  }
  const actorFile = '/app/deploy/studio-server/scripts/qualification/temporary-actor.mjs';
  const version = await api.json('GET', '/version');
  const preflight = await rpc(['node', actorFile, 'preflight'], {
    sourceRoot: '/app',
    sourceSha: operation.candidate.source.sha,
    kubernetesVersion: version.gitVersion,
  });
  assert.equal(preflight.sourceSha, operation.candidate.source.sha);
  assert.equal(preflight.offlineFixturePassed, true);
  const files = {};
  for (const name of await fs.readdir(bundle)) {
    const bytes = await fs.readFile(path.join(bundle, name));
    files[name] = { bytes: bytes.toString('base64'), hash: hash(bytes) };
  }
  const kubeconfig = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'staging',
        cluster: {
          server: settings.inClusterServer,
          'certificate-authority': '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        },
      },
    ],
    users: [{ name: 'actor', user: { tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token' } }],
    contexts: [{ name: settings.context, context: { cluster: 'staging', user: 'actor' } }],
    'current-context': settings.context,
  };
  const bytes = Buffer.from(JSON.stringify(kubeconfig));
  files['kubeconfig.json'] = { bytes: bytes.toString('base64'), hash: hash(bytes) };
  const installed = await rpc(['node', actorFile, 'install'], { operationId: operation.operationId, files });
  assert.equal(installed.installed, true);
  assert.deepEqual(
    installed.files,
    Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value.hash])),
  );
  const issued = new Set();
  let registryUid;
  async function snapshot(phase, { status, record, worker }) {
    const client = api.withTimeout ? api.withTimeout(10000) : api;
    const diagnostic = {
      protocol: 1,
      phase,
      observedAt: new Date().toISOString(),
      status,
      actorUid: pod.metadata.uid,
      registryUid,
      registry: record && { phase: record.phase, closed: record.closed, testPhase: record.testPhases?.[phase] },
      worker,
      namespaceUid: record?.namespaceUid,
    };
    // Re-read both sides when capturing a failure; the last successful monitor
    // observation alone may predate a lost actor or replaced operation record.
    const reads = await Promise.allSettled([
      client.json('GET', actorPath),
      registryUid ? client.json('GET', stagingRecordPath(settings, operation.operationId)) : Promise.resolve(null),
    ]);
    diagnostic.actor =
      reads[0].status === 'fulfilled'
        ? { actualUid: reads[0].value?.metadata.uid, ready: !!reads[0].value && ready(reads[0].value) }
        : { read: 'unconfirmed' };
    if (registryUid) {
      try {
        assert.equal(reads[1].status, 'fulfilled');
        assert.equal(reads[1].value?.metadata.uid, registryUid);
        record = assertStagingRecord(reads[1].value, operation, settings);
        assert.deepEqual(record.actor, {
          namespace: settings.runnerNamespace,
          name: pod.metadata.name,
          uid: pod.metadata.uid,
        });
        diagnostic.registry = { phase: record.phase, closed: record.closed, testPhase: record.testPhases?.[phase] };
        diagnostic.worker = record.workers.find((w) => w.phase === phase);
        diagnostic.namespaceUid = record.namespaceUid;
      } catch {
        diagnostic.registryRead = 'unconfirmed';
        record = undefined;
      }
    }
    if (record?.namespaceUid) {
      // The namespace UID must still match before inspecting fixture workloads.
      // Never read Secrets or Pod environment/command contents for diagnostics.
      const namespacePath = `/api/v1/namespaces/${record.namespace}`;
      try {
        const current = await client.json('GET', namespacePath);
        assert.equal(current?.metadata.uid, record.namespaceUid, 'Diagnostic namespace identity changed');
        const pods = await client.json('GET', `${namespacePath}/pods`);
        diagnostic.pods = pods.items.map((p) => ({
          name: p.metadata.name,
          uid: p.metadata.uid,
          deleting: !!p.metadata.deletionTimestamp,
          phase: p.status?.phase,
          conditions: p.status?.conditions,
          containers: p.status?.containerStatuses,
        }));
      } catch {
        diagnostic.workloadRead = 'unconfirmed';
      }
    }
    await fs.writeFile(
      path.join(privateDirectory, `phase-${phase}-diagnostic-${randomUUID()}.json`),
      JSON.stringify(diagnostic),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    // Existing RPC-finally persistence uploads the private snapshot. Diagnostic
    // collection does not add an upload wait to a running command's monitor.
  }
  const phaseCompletion = async (phase, deadline, report) => {
    if (!registryUid) return;
    const object = await api.json('GET', stagingRecordPath(settings, operation.operationId));
    assert.equal(object?.metadata.uid, registryUid, 'Operation registry was replaced');
    const record = assertStagingRecord(object, operation, settings);
    assert.deepEqual(record.actor, {
      namespace: settings.runnerNamespace,
      name: pod.metadata.name,
      uid: pod.metadata.uid,
    });
    const workers = record.workers.filter((w) => w.phase === phase);
    assert.ok(workers.length <= 1, 'Ambiguous phase worker');
    const worker = workers[0];
    await report({ record, worker });
    if (worker?.failed) throw Error(`Provider ${phase} failed; inspect private diagnostics`);
    if (phase !== 'verifyCleanup') {
      if (!worker?.closed) return worker && { state: 'pending' };
      assert.ok(worker.receipt, 'Closed phase has no successful receipt; command outcome is unknown');
      if (!['settle', 'cleanup'].includes(phase)) assert.ok(!record.closed, 'Qualification admission closed');
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await rpc(
            ['node', actorFile, 'receipt'],
            {
              operationId: operation.operationId,
              actorUid: pod.metadata.uid,
              phase,
              workerId: worker.id,
              receipt: worker.receipt,
            },
            Math.max(1, Math.min(15000, deadline - performance.now())),
          );
          break;
        } catch (error) {
          // Only this immutable read can retry, once, within the same deadline.
          if (!(error instanceof KubernetesExecOutcomeUnknown) || attempt > 0 || performance.now() >= deadline)
            throw error;
        }
      }
      assert.deepEqual(
        describeProviderPhaseReceipt(Buffer.from(JSON.stringify(result))),
        worker.receipt,
        'Recovered phase receipt changed',
      );
      for (const key of ['operationId', 'inputHash', 'projectId', 'projectNumber'])
        assert.equal(result[key], operation[key]);
      assert.equal(result.protocol, 1);
      return { state: 'succeeded', result };
    }
    if (!record.cleanupReceipt) {
      assert.ok(!worker?.closed, 'Closed cleanup worker has no successful receipt; command outcome is unknown');
      return worker && { state: 'pending' };
    }
    const { workerId, result } = record.cleanupReceipt;
    assert.ok(record.closed && record.phase === 'cleaned' && record.cleanupVerified);
    assert.ok(record.workers.length > 0 && record.workers.every((w) => w.closed), 'Cleanup still has active writers');
    assert.ok(
      record.workers.some((w) => w.id === workerId && w.phase === 'verifyCleanup'),
      'Cleanup worker changed',
    );
    for (const key of ['operationId', 'inputHash', 'projectId', 'projectNumber'])
      assert.equal(result[key], operation[key]);
    assert.equal(result.protocol, 1);
    return { state: 'succeeded', result };
  };
  const driver = Object.fromEntries(
    ['armExpiry', 'prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup'].map((phase) => [
      phase,
      async () => {
        assert.ok(!issued.has(phase), 'Never replay a remote phase');
        issued.add(phase);
        await fs.writeFile(
          path.join(privateDirectory, `actor-${phase}-intent.json`),
          JSON.stringify({ phase, uid: pod.metadata.uid }),
          { flag: 'wx', mode: 0o600 },
        );
        await persist();
        const timeoutMs = timeoutFor(operation, phase);
        let lastObservation;
        const report = observeProviderProgress({
          phase,
          deadlineAt: Date.now() + timeoutMs,
          log: onProgress,
          intervalMs: progressIntervalMs,
          stallAfterMs,
          snapshot: (observation) => snapshot(phase, observation),
        });
        await report();
        try {
          const result = await rpc(
            ['node', `/qualification/private/${operation.operationId}/provider.mjs`, phase],
            { operation, privateDirectory: `/qualification/private/${operation.operationId}/results` },
            timeoutMs,
            phase === 'armExpiry'
              ? undefined
              : (deadline) =>
                  phaseCompletion(phase, deadline, async (observation) => {
                    lastObservation = observation;
                    await report(observation);
                  }),
            report.flush,
          );
          if (phase === 'armExpiry') {
            assert.ok(typeof result.identity === 'string' && result.identity);
            registryUid = result.identity;
            onProgress({ phase, state: 'command-completed' });
          }
          await fs.writeFile(path.join(privateDirectory, `${phase}-receipt.json`), JSON.stringify(result), {
            flag: 'wx',
            mode: 0o600,
          });
          await persist();
          return result;
        } catch (error) {
          onProgress({ phase, state: 'failed', diagnostic: 'private-state-snapshot' });
          try {
            await snapshot(phase, { ...lastObservation, status: { phase, diagnostic: 'phase-failed' } });
            await persist();
          } catch {
            onProgress({ phase, state: 'failed', diagnostic: 'snapshot-incomplete' });
          }
          throw error;
        }
      },
    ]),
  );
  let closing;
  return {
    driver,
    close({ cleanupVerified }) {
      if (!cleanupVerified) return; // Independent expiry cleanup owns an uncertain writer.
      return (closing ??= (async () => {
        let failure;
        try {
          const exported = verifyTemporaryActorExport(
            await rpc(
              ['node', actorFile, 'export'],
              { operationId: operation.operationId },
              Math.min(600000, timeoutFor(operation, 'export')),
            ),
          );
          await fs.writeFile(path.join(privateDirectory, 'actor-export.json'), JSON.stringify(exported), {
            flag: 'wx',
            mode: 0o600,
          });
          await persist();
        } catch (error) {
          failure = error;
        }
        // Cleanup already proved writer absence. Failed diagnostics must not
        // retain the paid actor, but still prevent qualification publication.
        try {
          const current = await api.json('GET', `${collection}/${operation.operationId}`);
          assert.equal(current?.metadata.uid, job.metadata.uid);
          await api.json('DELETE', `${collection}/${operation.operationId}`, {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            propagationPolicy: 'Foreground',
            preconditions: { uid: job.metadata.uid },
          });
          await wait('actor removal', async () => !(await api.json('GET', actorPath)));
        } catch (error) {
          if (failure) throw new AggregateError([failure, error], 'Actor diagnostics and removal both failed');
          throw error;
        }
        if (failure) throw failure;
      })());
    },
  };
}
