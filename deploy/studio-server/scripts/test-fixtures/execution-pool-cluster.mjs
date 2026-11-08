import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runHaKubernetesRollout } from '../lib/ha-kubernetes-rollout.mjs';
import { fixtureDeploymentSafety } from '../fixtures/deployment-safety.mjs';
import { matchesKubernetesTemplate } from '../lib/kubernetes-template-match.mjs';

function difference(actual, expected, field = '') {
  if (matchesKubernetesTemplate(actual, expected)) return null;
  if (Array.isArray(expected)) {
    for (let index = 0; index < expected.length; index++) {
      const value = expected[index],
        next = value?.name ? actual?.find((item) => item.name === value.name) : actual?.[index];
      const found = difference(next, value, `${field}[${value?.name ?? index}]`);
      if (found) return found;
    }
  } else if (expected && typeof expected === 'object') {
    for (const [name, value] of Object.entries(expected)) {
      const found = difference(actual?.[name], value, `${field}.${name}`);
      if (found) return found;
    }
  }
  return field;
}

/** Real rendered resources, deterministic local Kubernetes/runtime responses.
 * No cloud qualification or application request-duration claim is made here. */
export async function exerciseExecutionPoolRollout({
  previous,
  candidate,
  renderFinal,
  allowExecutionPoolTransition,
  bufferedResponseSafe = true,
}) {
  const objects = new Map(),
    participants = new Map(),
    mutations = [],
    guards = [];
  let version = 0,
    virtualTime = 0;
  const key = (kind, name) => kind.toLowerCase() + '/' + name;
  const store = (input) => {
    const object = structuredClone(input),
      prior = objects.get(key(object.kind, object.metadata.name));
    Object.assign(object.metadata, {
      namespace: 'default',
      uid: prior?.metadata.uid ?? randomUUID(),
      resourceVersion: String(++version),
      generation: (prior?.metadata.generation ?? 0) + 1,
    });
    if (object.kind === 'Service' && !object.spec.clusterIP) object.spec.clusterIP = '10.96.0.10';
    objects.set(key(object.kind, object.metadata.name), object);
    return object;
  };
  const makePod = (owner, name, kind) => {
    const pod = store({
      kind: 'Pod',
      metadata: {
        ...owner.spec.template.metadata,
        name,
        labels: {
          ...owner.spec.template.metadata.labels,
          ...(kind === 'StatefulSet' ? { 'controller-revision-hash': owner.status.updateRevision } : {}),
        },
        ownerReferences: [{ kind, name: owner.metadata.name, uid: owner.metadata.uid, controller: true }],
      },
      spec: { ...owner.spec.template.spec, nodeName: 'node-' + name },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    });
    participants.set(pod.metadata.uid, {
      protocol: 1,
      withdrawalProtocol: 1,
      state: 'serving',
      operationId: null,
      incarnation: randomUUID(),
    });
    return pod;
  };
  const apply = (resources) => {
    for (const resource of resources) {
      const live = store(resource);
      if (!['Deployment', 'StatefulSet'].includes(resource.kind)) continue;
      live.status = {
        observedGeneration: live.metadata.generation,
        readyReplicas: live.spec.replicas,
        availableReplicas: live.spec.replicas,
        updatedReplicas: live.spec.replicas,
        updateRevision: 'candidate-revision',
      };
      if (live.kind === 'StatefulSet') {
        for (let i = 0; i < live.spec.replicas; i++) {
          const name = `${live.metadata.name}-${i}`;
          if (!objects.has(key('Pod', name))) makePod(live, name, 'StatefulSet');
        }
      } else {
        for (const [id, pod] of objects)
          if (
            pod.kind === 'Pod' &&
            pod.metadata.labels['app.kubernetes.io/component'] === live.metadata.labels['app.kubernetes.io/component']
          )
            objects.delete(id);
        const set = store({
          kind: 'ReplicaSet',
          metadata: {
            name: live.metadata.name + '-rs',
            labels: live.metadata.labels,
            ownerReferences: [
              { kind: 'Deployment', controller: true, name: live.metadata.name, uid: live.metadata.uid },
            ],
          },
          spec: { template: live.spec.template },
        });
        for (let i = 0; i < live.spec.replicas; i++) makePod(set, `${live.metadata.name}-rs-${i}`, 'ReplicaSet');
      }
    }
    if (guards.length)
      for (const desired of candidate.filter((resource) => resource.kind === 'Deployment')) {
        const actual = objects.get(key('Deployment', desired.metadata.name));
        assert.equal(
          difference(actual.spec.template, desired.spec.template),
          null,
          `Rendered candidate Deployment differs from actual Helm apply: ${desired.metadata.name}`,
        );
      }
  };
  apply(previous);
  const select = (kinds) => [...objects.values()].filter((object) => kinds.includes(object.kind.toLowerCase()));
  const response = (value) => ({ stdout: JSON.stringify(value ?? null) });
  const kube = async (args, options = {}) => {
    if (args[0] === 'get' && args[1] === '--raw') {
      const url = new URL(args[2], 'http://fixture.invalid');
      const matches = (object) =>
        (url.searchParams.get('labelSelector') ?? '')
          .split(',')
          .filter(Boolean)
          .every((entry) => {
            const [name, value] = entry.split('=');
            return object.metadata.labels?.[name] === value;
          });
      if (args[2].startsWith('/apis/metrics.k8s.io/'))
        return response({
          items: select(['pod']).map((pod) => ({
            metadata: pod.metadata,
            timestamp: new Date().toISOString(),
            containers: [{ name: pod.spec.containers[0].name, usage: { cpu: '10m' } }],
          })),
        });
      const kinds = {
        statefulsets: 'StatefulSet',
        services: 'Service',
        pods: 'Pod',
        deployments: 'Deployment',
        replicasets: 'ReplicaSet',
        horizontalpodautoscalers: 'HorizontalPodAutoscaler',
        endpointslices: 'EndpointSlice',
      };
      const match =
        /\/(statefulsets|services|pods|deployments|replicasets|horizontalpodautoscalers|endpointslices)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (match)
        return response(
          match[2]
            ? objects.get(key(kinds[match[1]], decodeURIComponent(match[2])))
            : { items: select([kinds[match[1]].toLowerCase()]).filter(matches) },
        );
      throw Error('Unexpected raw fixture read: ' + args[2]);
    }
    if (args[0] === 'get') {
      const aliases = {
        pod: 'pod',
        statefulset: 'statefulset',
        deployment: 'deployment',
        hpa: 'horizontalpodautoscaler',
        service: 'service',
        configmap: 'configmap',
        replicaset: 'replicaset',
      };
      const kinds = args[1].split(',').map((name) => aliases[name] ?? name);
      if (kinds.includes('endpointslice'))
        return response({
          items: select(['service']).map((service) => ({
            metadata: { labels: { 'kubernetes.io/service-name': service.metadata.name } },
            endpoints: select(['pod'])
              .filter((pod) =>
                Object.entries(service.spec.selector ?? {}).every(([key, value]) => pod.metadata.labels[key] === value),
              )
              .map((pod) => ({
                conditions: {
                  ready: service.spec.publishNotReadyAddresses === true || pod.status.conditions[0].status === 'True',
                },
                targetRef: { kind: 'Pod', namespace: 'default', name: pod.metadata.name, uid: pod.metadata.uid },
              })),
          })),
        });
      if (args[2] && !args[2].startsWith('-')) {
        const object = objects.get(key(kinds[0], args[2]));
        return object ? response(object) : { stdout: '' };
      }
      const items = select(kinds);
      return response({
        items: args.some((arg) => arg.includes('component in (proxy,proxy-bridge)'))
          ? items.filter((pod) =>
              ['proxy', 'proxy-bridge'].includes(pod.metadata.labels['app.kubernetes.io/component']),
            )
          : items,
      });
    }
    if (['create', 'replace'].includes(args[0])) {
      const value = JSON.parse(options.input),
        prior = objects.get(key(value.kind, value.metadata.name));
      if (args[0] === 'replace') assert.equal(value.metadata.resourceVersion, prior.metadata.resourceVersion);
      return response(store(value));
    }
    if (args[0] === 'exec') {
      const pod = objects.get(key('Pod', args[1])),
        status = participants.get(pod.metadata.uid);
      if (args.at(-1)?.includes('retirement-http-connections.js'))
        return response({ protocol: 1, bufferedResponseSafe });
      if (args.includes('/tmp/nginx/conf.d/default.conf'))
        return {
          stdout: `upstream rivet_execution { keepalive 0; server ${
            select(['service']).find(
              (service) => service.metadata.labels['app.kubernetes.io/component'] === 'execution',
            ).metadata.name
          }.default.svc.cluster.local:80; }`,
        };
      if (!args.includes('/opt/rivet/retire-backend.mjs'))
        return {
          stdout:
            'rivet_published_execution_active_runs 0\nrivet_published_execution_admission_limit{mode="enforce"} 4\n',
        };
      const offset = args.indexOf('/opt/rivet/retire-backend.mjs');
      if (args.length > offset + 1) {
        const [operationId, incarnation, mode] = args.slice(offset + 1);
        assert.equal(incarnation, status.incarnation);
        status.operationId = operationId;
        status.state = mode === '--withdraw-only' ? 'withdrawing' : 'drained';
        pod.status.conditions[0].status = 'False';
        mutations.push(mode + ':' + pod.metadata.name);
      }
      return response(status);
    }
    if (args[0] === 'delete') {
      const name = args[2].split('/').at(-1),
        pod = objects.get(key('Pod', name));
      assert.equal(JSON.parse(options.input).preconditions.uid, pod.metadata.uid);
      assert.equal(participants.get(pod.metadata.uid).state, 'drained');
      objects.delete(key('Pod', name));
      const owner = objects.get(key('StatefulSet', pod.metadata.ownerReferences[0].name));
      makePod(owner, name, 'StatefulSet');
      mutations.push('recreate:' + name);
      return response({});
    }
    if (args[0] === 'patch') {
      if (args[1] === 'service') {
        const service = objects.get(key('Service', args[2])),
          patch = JSON.parse(args.at(-1));
        assert.equal(patch[0].value, service.metadata.uid);
        assert.equal(patch[1].value, service.metadata.resourceVersion);
        assert.deepEqual(patch[2].value, service.spec.selector);
        service.spec.selector = patch[3].value;
        store(service);
        mutations.push('service-handoff:' + (service.spec.selector['rivet.dev/execution-pool'] ?? 'restore'));
        return response(service);
      }
      const owner = objects.get(key('StatefulSet', args[2])),
        patch = JSON.parse(args.at(-1));
      assert.equal(patch[0].value, owner.metadata.uid);
      assert.equal(patch[1].value, owner.metadata.resourceVersion);
      assert.equal(patch[2].value, owner.spec.replicas);
      for (const pod of select(['pod']).filter((pod) =>
        pod.metadata.ownerReferences.some((ref) => ref.uid === owner.metadata.uid),
      )) {
        assert.equal(participants.get(pod.metadata.uid).state, 'drained');
        objects.delete(key('Pod', pod.metadata.name));
      }
      owner.spec.replicas = 0;
      const scaled = store(owner);
      scaled.status = { ...scaled.status, observedGeneration: scaled.metadata.generation, readyReplicas: 0 };
      mutations.push('pool-scale-zero:' + owner.metadata.name);
      return response(owner);
    }
    if (args[0] === 'scale') {
      const owner = objects.get(key('StatefulSet', args[1].split('/')[1]));
      const value = (flag) => args.find((arg) => arg.startsWith(flag + '=')).slice(flag.length + 1);
      assert.equal(Number(value('--current-replicas')), owner.spec.replicas);
      assert.equal(value('--resource-version'), owner.metadata.resourceVersion);
      const count = Number(value('--replicas'));
      for (let index = owner.spec.replicas; index < count; index++)
        makePod(owner, `${owner.metadata.name}-${index}`, 'StatefulSet');
      owner.spec.replicas = count;
      const scaled = store(owner);
      scaled.status = { ...scaled.status, observedGeneration: scaled.metadata.generation, readyReplicas: count };
      return response(scaled);
    }
    throw Error('Unexpected fixture command: ' + args.join(' '));
  };
  const identity = { release: 'rivet', namespace: 'default', manifestDigest: 'candidate' };
  const result = await runHaKubernetesRollout({
    ...identity,
    resources: candidate,
    allowExecutionPoolTransition,
    kube,
    timeoutMs: 10000,
    safety: fixtureDeploymentSafety('rolling', identity),
    artifact: async () => {},
    settle: async () => {},
    routingWithdrawalClock: {
      now: () => virtualTime,
      wait: async () => {
        // Several owners poll in parallel. A whole-minute jump per waiter
        // would advance their shared clock past each other's deadline.
        virtualTime += 1000;
      },
    },
    applyTemplates: async (_workloads, values) => {
      guards.push(values);
      apply(await renderFinal(values));
    },
    restoreAutoscalers: async (_workloads, values) => {
      guards.push(values);
      apply(await renderFinal(values));
    },
    beforeRetirement: async () => {},
    afterWithdrawal: async () => {},
    createProxyContinuity: () => ({
      identity: { localFixture: true },
      prepare: async (operation) =>
        operation.checkpoint({ proxyContinuity: { phase: 'complete', routeRestored: true, entries: [] } }),
      verify: async () => {},
      templateValues: () => ({}),
      beforeRestoreAutoscalers: async () => {},
      afterRestoreAutoscalers: async () => {},
      finish: async () => {},
    }),
  });
  return { result, mutations, guards, resources: [...objects.values()] };
}
