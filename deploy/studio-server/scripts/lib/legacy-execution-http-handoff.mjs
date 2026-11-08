import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { waitForHaRoutingWithdrawal } from './ha-routing-withdrawal.mjs';

// This module shipped with the buffered-response fix. Probe the immutable
// running image, not the replacement template or the supervisor protocol (which
// predates that fix). Missing module means legacy; other probe errors must stop.
export const bufferedResponseProbe = [
  'node',
  '--input-type=module',
  '-e',
  `import { access } from 'node:fs/promises';
const file = '/app/packages/studio-server-api/dist/studio-server-api/src/retirement-http-connections.js';
let present = true;
try { await access(file); } catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
if (present) {
  const module = await import(file);
  if (typeof module.createRetirementHttpConnections !== 'function') throw Error('Invalid buffered-response capability');
}
console.log(JSON.stringify({ protocol: 1, bufferedResponseSafe: present }));`,
];

export function assertUnpooledExecutionUpstream(configuration, target) {
  // Read the rendered file used by the running proxy. Client-side keepalive is
  // allowed; only proxy -> execution reuse would bypass a Service handoff.
  const blocks = [...configuration.replace(/#[^\n]*/g, '').matchAll(/\bupstream\s+rivet_execution\s*\{([^{}]*)\}/g)];
  assert.equal(blocks.length, 1, 'Expected one execution upstream in the live proxy configuration');
  const keepalive = [...blocks[0][1].matchAll(/\bkeepalive\s+([^;]+);/g)];
  assert.equal(keepalive.length, 1, 'Legacy handoff requires explicit upstream keepalive 0');
  assert.equal(keepalive[0][1].trim(), '0', 'Legacy handoff cannot drain reused upstream sockets');
  if (target) {
    const servers = [...blocks[0][1].matchAll(/\bserver\s+([^;]+);/g)];
    assert.equal(servers.length, 1, 'Legacy HTTP handoff needs one Service upstream');
    const [host, port] = servers[0][1].trim().split(/\s+/)[0].split(':');
    assert.ok(
      host.startsWith(`${target.service.metadata.name}.${target.namespace}.svc.`),
      'Live proxy bypasses the handoff Service',
    );
    assert.ok(
      target.service.spec.ports.some((entry) => String(entry.port) === port),
      'Live proxy bypasses the handoff Service port',
    );
  }
}

export function recoverLegacyHttpService(current, desired, journal) {
  const state = journal?.executionPool?.legacyHttp;
  if (
    !state?.required ||
    state.protocol !== 1 ||
    !state.routeIssued ||
    journal.phase === 'complete' ||
    current.metadata.uid !== state.serviceUid ||
    !isDeepStrictEqual(state.original, desired.spec.selector) ||
    !isDeepStrictEqual(state.selected, {
      ...state.original,
      'rivet.dev/execution-pool': state.selected?.['rivet.dev/execution-pool'],
    }) ||
    !['a', 'b'].includes(state.selected?.['rivet.dev/execution-pool']) ||
    !isDeepStrictEqual(current.spec.selector, state.selected)
  )
    return current;
  return { ...current, spec: { ...current.spec, selector: state.original } };
}

/** One-time compatibility for old API images: route new requests to the ready
 * candidate pool, then allow propagation + the supported 300-second response
 * lifetime BEFORE invoking the old, unsafe idle closer. Accepted background
 * work still follows the ordinary retirement protocol. */
export function createLegacyExecutionHttpHandoff({
  kube,
  release,
  namespace,
  plan,
  service,
  candidateTemplate,
  observePod,
  timeoutMs,
  clock,
  assertCapacity,
}) {
  const slot = candidateTemplate.metadata.labels?.['rivet.dev/execution-pool'];
  assert.ok(['a', 'b'].includes(slot));
  let verifiedThisRun = false;
  const selected = { ...service.spec.selector, 'rivet.dev/execution-pool': slot };
  const assertState = (state) => {
    assert.equal(state?.protocol, 1);
    assert.equal(typeof state.required, 'boolean');
  };
  const read = async () => JSON.parse((await kube(['get', 'service', service.metadata.name, '-o', 'json'])).stdout);
  const save = (operation, state) => {
    operation.assertLease();
    return operation.checkpoint({ executionPool: { ...operation.record.executionPool, legacyHttp: state } });
  };
  const ownedService = async (state, selector) => {
    const current = await read();
    assert.equal(current.metadata.uid, state.serviceUid, 'Legacy HTTP Service identity changed');
    assert.equal(current.metadata.labels?.['app.kubernetes.io/instance'], release);
    assert.deepEqual(current.spec.selector, selector, 'Legacy HTTP Service selector changed');
    assert.deepEqual(current.spec.ports, state.ports, 'Legacy HTTP Service ports changed');
    assert.equal(current.spec.publishNotReadyAddresses ?? false, false);
    return current;
  };
  const patch = async (operation, current, selector) => {
    operation.assertLease();
    await kube([
      'patch',
      'service',
      service.metadata.name,
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
        { op: 'test', path: '/spec/selector', value: current.spec.selector },
        { op: 'replace', path: '/spec/selector', value: selector },
      ]),
    ]);
  };
  const verifyProxies = async (operation) => {
    const instances = [release, operation.record.proxyContinuity?.name].filter(Boolean);
    const pods = JSON.parse(
      (
        await kube([
          'get',
          'pod',
          '-l',
          `app.kubernetes.io/instance in (${instances.join(',')}),app.kubernetes.io/component in (proxy,proxy-bridge)`,
          '-o',
          'json',
        ])
      ).stdout,
    ).items;
    const serving = pods.filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
    );
    assert.ok(
      serving.length && serving.every((pod) => pod.status.phase === 'Running'),
      'No running ready proxy for legacy HTTP handoff',
    );
    // Terminating proxies can still serve existing frontend connections.
    for (const pod of pods.filter((pod) => pod.status?.phase === 'Running')) {
      assert.ok(instances.includes(pod.metadata.labels?.['app.kubernetes.io/instance']));
      try {
        const result = await kube([
          'exec',
          pod.metadata.name,
          '-c',
          'proxy',
          '--',
          'cat',
          '/tmp/nginx/conf.d/default.conf',
        ]);
        assertUnpooledExecutionUpstream(result.stdout, { service, namespace });
      } catch (error) {
        // A Pod which finished terminating after the list cannot retain an
        // upstream socket. Never excuse a still-present or replacement owner.
        const raw = (await kube(['get', 'pod', pod.metadata.name, '--ignore-not-found', '-o', 'json'])).stdout;
        const current = raw.trim() ? JSON.parse(raw) : null;
        if (
          current &&
          !(
            current.metadata?.uid === pod.metadata.uid &&
            current.status?.containerStatuses?.some(
              (container) => container.name === 'proxy' && container.state?.terminated,
            )
          )
        )
          throw error;
      }
    }
  };
  const handoff = {
    async prepare(operation) {
      let state = operation.record.executionPool.legacyHttp;
      if (!state) {
        let required = false;
        for (const owner of operation.record.executionPool.owners) {
          const pod = await observePod(owner.name);
          assert.equal(pod?.uid, owner.uid);
          const result = JSON.parse(
            (await kube(['exec', pod.name, '-c', 'api', '--', ...bufferedResponseProbe])).stdout,
          );
          assert.equal(result.protocol, 1);
          assert.equal(typeof result.bufferedResponseSafe, 'boolean');
          assert.equal((await observePod(owner.name))?.uid, owner.uid);
          required ||= !result.bufferedResponseSafe;
        }
        if (!required) {
          await save(operation, { protocol: 1, required: false });
          return;
        }
        const current = await read();
        assert.ok(current.metadata.uid && current.metadata.resourceVersion);
        assert.deepEqual(current.spec.selector, service.spec.selector);
        for (const [key, value] of Object.entries(selected))
          assert.equal(candidateTemplate.metadata.labels[key], value, 'Candidate does not match handoff selector');
        state = {
          protocol: 1,
          required: true,
          serviceUid: current.metadata.uid,
          original: current.spec.selector,
          selected,
          ports: current.spec.ports,
        };
        await save(operation, state);
      }
      assertState(state);
      if (!state.required) return;
      assert.deepEqual(state.selected, selected);
      assert.deepEqual(state.original, service.spec.selector);
      await assertCapacity();
      await verifyProxies(operation);
      if (!state.routeIssued) {
        const current = await ownedService(state, state.original);
        state = { ...state, routeIssued: true };
        await save(operation, state);
        await patch(operation, current, state.selected);
      }
      // A lost patch acknowledgement is observed, never blindly replayed.
      await ownedService(state, state.selected);
      // Record the actual routing change before waiting out protected requests.
      // Qualification must observe those requests across this handoff, not
      // require them to outlive the later six-minute safety barrier.
      if (!state.routeConfirmed) {
        state = { ...state, routeConfirmed: true };
        await save(operation, state);
      }
      const owners = operation.record.executionPool.owners;
      await waitForHaRoutingWithdrawal({
        pod: owners[0],
        observePod,
        timeoutMs,
        clock,
        protectedResponseMs: 300_000,
        publicServices: new Set([service.metadata.name]),
        readSlices: async () => {
          operation.assertLease();
          await ownedService(state, state.selected);
          for (const owner of owners) assert.equal((await observePod(owner.name))?.uid, owner.uid);
          return JSON.parse((await kube(['get', 'endpointslice', '-o', 'json'])).stdout).items;
        },
        routingReady: (slices) => {
          const endpoints = slices
            .filter((slice) => slice.metadata?.labels?.['kubernetes.io/service-name'] === service.metadata.name)
            .flatMap((slice) => slice.endpoints ?? [])
            .filter((endpoint) => endpoint.conditions?.ready !== false);
          const uids = new Set();
          for (const endpoint of endpoints) {
            const ref = endpoint.targetRef;
            if (owners.some((owner) => owner.uid === ref?.uid)) return false;
            assert.ok(
              ref?.uid &&
                ref.kind === 'Pod' &&
                ref.namespace === namespace &&
                ref.name?.startsWith(plan.candidate.name + '-') &&
                /^[0-9]+$/.test(ref.name.slice(plan.candidate.name.length + 1)),
              'Foreign execution handoff endpoint',
            );
            uids.add(ref.uid);
          }
          return uids.size >= plan.previous.replicas;
        },
      });
      await assertCapacity();
      await verifyProxies(operation);
      await ownedService(state, state.selected);
      await save(operation, { ...state, settled: true });
      verifiedThisRun = true;
    },
    async beforeWithdraw(operation) {
      const state = operation.record.executionPool.legacyHttp;
      assertState(state);
      if (state.required) {
        // Recovery re-observes a complete interval; a stale clock receipt alone
        // cannot authorize the first unsafe command of a new operator process.
        if (!verifiedThisRun) await handoff.prepare(operation);
        assert.equal(state.settled, true);
        assert.equal(state.restoreIssued, undefined);
        await ownedService(state, state.selected);
      }
    },
    async finish(operation) {
      let state = operation.record.executionPool.legacyHttp;
      assertState(state);
      if (!state.required) return;
      assert.equal(state.settled, true);
      if (!state.restoreIssued) {
        const current = await ownedService(state, state.selected);
        state = { ...state, restoreIssued: true };
        await save(operation, state);
        await patch(operation, current, state.original);
      }
      await ownedService(state, state.original);
    },
  };
  return handoff;
}
