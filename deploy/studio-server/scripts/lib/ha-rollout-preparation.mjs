import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { podResourceRequest, resourceQuantity } from './pod-resource-requests.mjs';
import { releaseOperationJournalName } from './release-operation-journal.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roles = new Set(['proxy', 'web', 'backend', 'execution', 'evaluation', 'maintenance']);
const roleOf = (r) => r.metadata.labels?.['app.kubernetes.io/component'];
const base = (ns) => `/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`;
const requestedFieldsMatch = (actual, requested, key) =>
  key === 'resources'
    ? ['requests', 'limits'].every((kind) =>
        Object.entries(requested[kind] ?? {}).every(
          ([resource, amount]) =>
            resourceQuantity(actual?.[kind]?.[resource], resource) === resourceQuantity(amount, resource),
        ),
      )
    : Array.isArray(requested)
      ? Array.isArray(actual) &&
        actual.length === requested.length &&
        requested.every((v, i) => requestedFieldsMatch(actual[i], v))
      : requested && typeof requested === 'object'
        ? actual && Object.entries(requested).every(([k, v]) => requestedFieldsMatch(actual[k], v, k))
        : isDeepStrictEqual(actual, requested);

/** Scheduler-native capacity probes. No application command, data mount or serving label. */
export function rolloutPreparationJobs(
  resources,
  { token, namespace, journalUid, controlPlaneMode, originalPods, workloads = [], timeoutMs },
) {
  const jobs = resources
    .filter((r) => ['StatefulSet', 'Deployment'].includes(r.kind) && roles.has(roleOf(r)))
    .map((r) => {
      const role = roleOf(r),
        template = r.spec.template,
        spec = template.spec;
      const images = [...new Set([...spec.containers, ...(spec.initContainers ?? [])].map((c) => c.image))];
      assert.ok(
        images.length && images.length <= 8 && images.every((i) => /^\S+@sha256:[a-f0-9]{64}$/.test(i)),
        'Preparation requires bounded immutable images',
      );
      const serial = role === 'maintenance' || (role === 'backend' && controlPlaneMode === 'singleton');
      const originalOwnerUid = workloads.find((w) => w.name === r.metadata.name)?.uid;
      const original = originalPods.find(
        (p) =>
          originalOwnerUid &&
          p.metadata.name === `${r.metadata.name}-0` &&
          !p.metadata.deletionTimestamp &&
          p.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === r.kind && o.name === r.metadata.name && o.uid === originalOwnerUid,
          ),
      );
      if (serial) assert.ok(original?.spec.nodeName, 'Serial owner node is unknown before image preparation');
      const probeRole = `prepare-${role}`;
      const labels = { ...template.metadata.labels, 'app.kubernetes.io/component': probeRole };
      // Keep topology accounting against real peers AND this isolated probe,
      // without letting Services, StatefulSets, HPAs or execution discovery select it.
      const spread = structuredClone(spec.topologySpreadConstraints ?? []);
      for (const constraint of spread) {
        assert.ok(
          !constraint.matchLabelKeys?.length &&
            constraint.labelSelector?.matchLabels?.['app.kubernetes.io/component'] === role,
          'Unsupported preparation spread selector; use reviewed placement before deployment',
        );
        delete constraint.labelSelector.matchLabels['app.kubernetes.io/component'];
        constraint.labelSelector.matchExpressions = [
          ...(constraint.labelSelector.matchExpressions ?? []),
          { key: 'app.kubernetes.io/component', operator: 'In', values: [role, probeRole] },
        ];
      }
      const amounts = Object.fromEntries(
        ['cpu', 'memory', 'ephemeral-storage'].map((resource) => [resource, podResourceRequest(spec, resource)]),
      );
      for (const c of [...spec.containers, ...(spec.initContainers ?? [])])
        assert.ok(
          [...Object.keys(c.resources?.requests ?? {}), ...Object.keys(c.resources?.limits ?? {})].every(
            (k) => k in amounts,
          ),
          'Extended-resource preparation needs an explicit policy',
        );
      if (serial)
        for (const resource of Object.keys(amounts))
          amounts[resource] = Math.max(0, amounts[resource] - podResourceRequest(original.spec, resource));
      const footprint = {
        cpu: `${Math.max(10, Math.ceil(amounts.cpu * 1000))}m`,
        memory: String(Math.max(16777216, Math.ceil(amounts.memory))),
        'ephemeral-storage': String(Math.max(16777216, Math.ceil(amounts['ephemeral-storage']))),
      };
      const pod = {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 30,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        ...(spec.imagePullSecrets ? { imagePullSecrets: spec.imagePullSecrets } : {}),
        ...(spec.nodeSelector ? { nodeSelector: spec.nodeSelector } : {}),
        ...(spec.tolerations ? { tolerations: spec.tolerations } : {}),
        ...(spec.schedulerName ? { schedulerName: spec.schedulerName } : {}),
        ...(!serial && spec.affinity ? { affinity: spec.affinity } : {}),
        ...(!serial && spread.length ? { topologySpreadConstraints: spread } : {}),
      };
      assert.ok(
        !spec.runtimeClassName && !spec.hostNetwork && !spec.containers.some((c) => c.ports?.some((p) => p.hostPort)),
        'Preparation does not emulate custom runtimes or host-port reservations',
      );
      if (serial)
        pod.affinity = {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchFields: [{ key: 'metadata.name', operator: 'In', values: [original.spec.nodeName] }],
                },
              ],
            },
          },
        };
      const container = (image, i, resources) => ({
        name: `image-${i}`,
        image,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sh', '-ec', 'exit 0'],
        resources: { requests: resources, limits: resources },
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
      });
      pod.initContainers = images.slice(1).map((image, i) => container(image, i + 1, footprint));
      pod.containers = [container(images[0], 0, footprint)];
      const job = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `rivet-prepare-${hash({ token, name: r.metadata.name }).slice(0, 24)}`,
          namespace,
          labels: { 'rivet.dev/rollout-preparation': token },
          ownerReferences: [
            {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              name: releaseOperationJournalName(r.metadata.labels['app.kubernetes.io/instance']),
              uid: journalUid,
              controller: true,
            },
          ],
        },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: Math.max(1, Math.min(300, Math.floor(timeoutMs / 1000))),
          ttlSecondsAfterFinished: 600,
          template: { metadata: { labels }, spec: pod },
        },
      };
      for (const resource of resources) {
        const selector = resource.kind === 'Service' ? resource.spec.selector : resource.spec?.selector?.matchLabels;
        if (selector && Object.keys(selector).length)
          assert.ok(
            !Object.entries(selector).every(([k, v]) => labels[k] === v),
            'Preparation pod would match an application selector',
          );
      }
      return job;
    });
  assert.ok(jobs.length && jobs.length <= 8, 'Preparation workload count is unconfirmed');
  return jobs;
}

async function parallel(items, fn, { stopOnError = false } = {}) {
  const pending = [...items],
    results = [];
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length && !(stopOnError && results.length)) {
      const item = pending.shift();
      try {
        await fn(item);
      } catch (error) {
        results.push(error);
      }
    }
  });
  await Promise.all(workers); // Every accepted child settles before returning, even on failure.
  if (results.length)
    throw new AggregateError(
      results,
      `Replacement preparation failed; no old owner was retired: ${results.map((e) => e.message).join('; ')}`,
    );
}

/** Runs only under the existing deployment lease, before candidate Helm templates. */
export async function prepareHaReplacements({
  operation,
  kube,
  resources,
  namespace,
  release,
  timeoutMs,
  pause = () => new Promise((r) => setTimeout(r, 1000)),
  now = Date.now,
}) {
  const json = async (args, options) => {
    operation.assertLease();
    const raw = (await kube(args, options)).stdout;
    return raw?.trim() ? JSON.parse(raw) : null;
  };
  const ns = await json(['get', 'namespace', namespace, '-o', 'json']);
  assert.ok(ns?.metadata.uid && !ns.metadata.deletionTimestamp);
  const expectedNamespace = operation.record.deploymentSafety?.namespaceUid;
  if (expectedNamespace) assert.equal(ns.metadata.uid, expectedNamespace);
  const mutate = async (args, options, beforeWrite = () => {}) => {
    const checkNamespace = async () => {
      const current = await json(['get', 'namespace', namespace, '-o', 'json']);
      assert.ok(
        current?.metadata.uid === ns.metadata.uid && !current.metadata.deletionTimestamp,
        'Preparation namespace lifetime changed; no further writes are allowed',
      );
    };
    await checkNamespace();
    beforeWrite();
    const result = await json(args, options);
    await checkNamespace();
    return result;
  };
  const cm = await json(['get', 'configmap', releaseOperationJournalName(release), '-o', 'json']);
  assert.equal(JSON.parse(cm.data.record).token, operation.record.token);
  const originalPods = (await json(['get', 'pods', '-o', 'json'])).items;
  assert.ok(Array.isArray(originalPods));
  const jobs = rolloutPreparationJobs(resources, {
    token: operation.record.token,
    namespace,
    journalUid: cm.metadata.uid,
    controlPlaneMode: operation.record.controlPlaneMode,
    originalPods,
    workloads: operation.record.workloads,
    timeoutMs,
  });
  const digest = hash(jobs);
  let changes = Promise.resolve();
  const change = (fn) => {
    const next = changes.then(async () => {
      operation.assertLease();
      const value = structuredClone(operation.record.preparation);
      fn(value);
      await operation.checkpoint({ preparation: value });
    });
    changes = next.catch(() => {});
    return next;
  };
  if (!operation.record.preparation)
    await operation.checkpoint({
      preparation: {
        protocol: 1,
        digest,
        namespaceUid: ns.metadata.uid,
        state: 'preparing',
        jobs: jobs.map((j) => ({ name: j.metadata.name, createIssued: false })),
      },
    });
  const preparation = operation.record.preparation;
  assert.equal(preparation.protocol, 1);
  assert.equal(preparation.digest, digest, 'Preparation inputs changed; no jobs were replayed');
  assert.equal(preparation.namespaceUid, ns.metadata.uid);
  assert.deepEqual(
    preparation.jobs?.map((j) => j.name),
    jobs.map((j) => j.metadata.name),
    'Preparation receipt lost or changed a required Job',
  );
  const jobState = (name) => operation.record.preparation.jobs.find((j) => j.name === name);
  const verifyPreparedNodes = () =>
    parallel(
      operation.record.preparation.jobs.filter((j) => j.warmed),
      async (j) => {
        const node = await json(['get', 'node', j.nodeName, '-o', 'json']);
        assert.ok(
          node?.metadata.uid === j.nodeUid &&
            !node.metadata.deletionTimestamp &&
            !node.spec?.unschedulable &&
            node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
          'Prepared node identity/readiness changed',
        );
      },
    );
  const childrenGone = async (name) => {
    // Check the current journal row, not a pre-checkpoint snapshot. In particular,
    // a lost CREATE may acquire its exact UID only during cleanup inspection.
    const item = jobState(name);
    const pods = await json(['get', 'pods', '-o', 'json']);
    assert.ok(Array.isArray(pods?.items) && !pods.metadata?.continue, 'Preparation child inventory is incomplete');
    return !pods.items.some(
      (p) =>
        p.metadata.uid === item.podUid ||
        (item.uid && p.metadata.ownerReferences?.some((o) => o.controller && o.uid === item.uid)),
    );
  };
  const read = (name) => json(['get', 'job', name, '--ignore-not-found', '-o', 'json']);
  if (preparation.state === 'complete') {
    assert.ok(
      preparation.jobs.every(
        (j) => j.createIssued && j.uid && j.warmed && j.podUid && j.nodeUid && j.nodeName && j.deleteIssued && j.absent,
      ),
      'Preparation completion facts are incomplete',
    );
    for (const item of preparation.jobs) {
      assert.equal(await read(item.name), null, 'Recorded preparation Job still exists');
      assert.ok(await childrenGone(item.name), 'Recorded preparation child still exists');
    }
    await verifyPreparedNodes();
    return;
  }
  assert.equal(
    preparation.state,
    'preparing',
    'Previous preparation is terminal; start a fresh operation after inspected cleanup',
  );
  const owned = (job, desired, uid) => {
    assert.equal(job.metadata.namespace, namespace);
    assert.equal(job.metadata.labels?.['rivet.dev/rollout-preparation'], operation.record.token);
    if (uid) assert.equal(job.metadata.uid, uid, 'Preparation Job was replaced');
    assert.ok(
      job.metadata.uid &&
        job.metadata.resourceVersion &&
        requestedFieldsMatch(job.spec.template, desired.spec.template) &&
        requestedFieldsMatch(job.metadata.ownerReferences, desired.metadata.ownerReferences),
      'Preparation Job ownership/configuration changed',
    );
  };
  const deadline = now() + timeoutMs;
  const assertAdmission = () =>
    assert.ok(now() < deadline, 'Preparation admission deadline reached; old owners retained');
  let primary;
  try {
    await parallel(
      jobs,
      async (desired) => {
        const item = jobState(desired.metadata.name);
        let job;
        if (!item.createIssued) {
          assertAdmission();
          assert.equal(await read(item.name), null, 'Preparation Job name is occupied');
          assertAdmission();
          await change((p) => {
            p.jobs.find((j) => j.name === item.name).createIssued = true;
          });
          job = await mutate(['create', '-f', '-', '-o', 'json'], { input: JSON.stringify(desired) }, assertAdmission);
        } else {
          job = await read(item.name); // Inspect an uncertain CREATE, never send it again.
          assert.ok(job, 'Preparation CREATE is uncertain or expired; inspect without replay');
        }
        owned(job, desired, item.uid);
        await change((p) => {
          p.jobs.find((j) => j.name === item.name).uid = job.metadata.uid;
        });
        for (;;) {
          job = await read(item.name);
          assert.ok(job, 'Preparation Job disappeared before completion');
          owned(job, desired, jobState(item.name).uid);
          assert.ok(
            !job.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True'),
            'Image pull or scheduling preparation failed',
          );
          if (job.status?.conditions?.some((c) => c.type === 'Complete' && c.status === 'True')) break;
          assert.ok(now() < deadline, 'Preparation timed out; old owners retained');
          await pause();
        }
        const pods = (await json(['get', 'pods', '-l', `job-name=${item.name}`, '-o', 'json'])).items;
        assert.ok(Array.isArray(pods) && pods.length === 1, 'Preparation Pod completion is unconfirmed');
        const pod = pods[0];
        assert.ok(
          pod.metadata.uid &&
            pod.metadata.ownerReferences?.some((o) => o.controller && o.uid === job.metadata.uid) &&
            pod.status?.phase === 'Succeeded' &&
            pod.spec.nodeName,
          'Preparation Pod ownership or scheduling is unconfirmed',
        );
        assert.ok(
          requestedFieldsMatch(pod.spec, desired.spec.template.spec),
          'Preparation Pod configuration changed at admission',
        );
        const node = await json(['get', 'node', pod.spec.nodeName, '-o', 'json']);
        assert.ok(
          node?.metadata.uid &&
            !node.metadata.deletionTimestamp &&
            !node.spec?.unschedulable &&
            node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
          'Prepared node is no longer usable',
        );
        await change((p) => {
          Object.assign(
            p.jobs.find((j) => j.name === item.name),
            {
              warmed: true,
              podUid: pod.metadata.uid,
              nodeName: node.metadata.name,
              nodeUid: node.metadata.uid,
            },
          );
        });
      },
      { stopOnError: true },
    );
    await verifyPreparedNodes();
  } catch (error) {
    primary = error;
  }
  try {
    await parallel(jobs, async (desired) => {
      const item = jobState(desired.metadata.name);
      if (!item.createIssued) return;
      let job = await read(item.name);
      if (!job) {
        assert.ok(item.uid || item.deleteIssued, 'Unacknowledged preparation CREATE needs inspection');
      } else {
        owned(job, desired, item.uid);
        if (!item.uid)
          await change((p) => {
            p.jobs.find((j) => j.name === item.name).uid = job.metadata.uid;
          });
        if (!item.deleteIssued) {
          await change((p) => {
            p.jobs.find((j) => j.name === item.name).deleteIssued = true;
          });
          await mutate(['delete', '--raw', `${base(namespace)}/${item.name}`, '-f', '-'], {
            input: JSON.stringify({
              apiVersion: 'v1',
              kind: 'DeleteOptions',
              propagationPolicy: 'Foreground',
              preconditions: { uid: job.metadata.uid, resourceVersion: job.metadata.resourceVersion },
            }),
          });
        } else assert.ok(job.metadata.deletionTimestamp, 'Preparation DELETE is uncertain; inspect without replay');
        while ((job = await read(item.name))) {
          owned(job, desired, jobState(item.name).uid);
          assert.ok(now() < deadline, 'Preparation cleanup is pending; old owners retained');
          await pause();
        }
      }
      while (!(await childrenGone(item.name))) {
        assert.ok(now() < deadline, 'Preparation child cleanup is pending; old owners retained');
        await pause();
      }
      await change((p) => {
        p.jobs.find((j) => j.name === item.name).absent = true;
      });
    });
    if (!primary) await verifyPreparedNodes();
    await change((p) => {
      p.state = primary ? 'cleaned-failed' : 'complete';
    });
  } catch (cleanup) {
    throw primary
      ? new AggregateError([primary, cleanup], 'Preparation and cleanup require inspected recovery')
      : cleanup;
  }
  if (primary) throw primary;
}
