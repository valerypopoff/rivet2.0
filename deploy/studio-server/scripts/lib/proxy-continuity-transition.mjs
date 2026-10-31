import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  assertProtectedProxyTemplate,
  assertRequestContinuityProfile,
  continuityProfileDigest,
  continuityHandoffSeconds,
} from './request-continuity.mjs';

const marker = 'rivet.dev/continuity-operation';
const servingHeader = 'X-Rivet-Continuity-Serving';
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const hash = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const clone = structuredClone;
const identity = (r) => {
  assert.ok(
    r?.metadata?.uid && r.metadata.resourceVersion && !r.metadata.deletionTimestamp,
    'Network owner is unavailable',
  );
  return { kind: r.kind, name: r.metadata.name, namespace: r.metadata.namespace, uid: r.metadata.uid };
};
const annotations = (r) => r.metadata.annotations ?? {};
const frozenHpaSpec = (state) => {
  const spec = clone(state.hpa.spec);
  spec.minReplicas = state.bridgeReplicas;
  spec.behavior = { ...spec.behavior, scaleDown: { ...spec.behavior?.scaleDown, selectPolicy: 'Disabled' } };
  return spec;
};
const subset = (actual, expected) =>
  Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => subset(actual[i], v))
    : expected && typeof expected === 'object'
      ? actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => subset(actual[k], v))
      : equal(actual, expected);

export function proxyContinuitySettled(record) {
  const state = record.proxyContinuity;
  return (
    state === undefined ||
    (state.phase === 'complete' &&
      state.routeRestored === true &&
      (!state.hpaFreezeIntent || state.hpaReleased) &&
      state.entries.every((e) => !e.intent || e.absent))
  );
}

/** Only a new, separately selected ingress pool is created. No serving pod is
 * relabelled, adopted or deleted to retrofit its immutable lifecycle. */
export function buildProxyBridge(baseline, config, token) {
  const { profile, network, namespace, release } = config;
  assertRequestContinuityProfile(profile);
  identity(baseline.hpa);
  assert.equal(baseline.hpa.spec.scaleTargetRef.kind, 'Deployment');
  assert.equal(baseline.hpa.spec.scaleTargetRef.name, baseline.deployment.metadata.name);
  assert.ok(
    subset(baseline.hpa.spec, config.hpaSpec),
    'Changing proxy HPA policy during first adoption needs separate qualification',
  );
  const bridgeReplicas = baseline.hpa.spec.maxReplicas;
  assert.ok(
    Number.isSafeInteger(bridgeReplicas) && bridgeReplicas >= 2 && bridgeReplicas <= 4,
    'Bridge capacity must retain the qualified proxy HPA ceiling',
  );
  for (const r of [baseline.route, baseline.policy, baseline.service, baseline.deployment, baseline.gateway])
    identity(r);
  assert.equal(baseline.gateway.spec.gatewayClassName, 'gke-l7-regional-external-managed');
  assert.equal(baseline.policy.spec.targetRef.name, baseline.service.metadata.name);
  assert.deepEqual(
    baseline.service.spec.selector,
    baseline.deployment.spec.selector.matchLabels,
    'Proxy Service selector must match the captured Deployment',
  );
  assert.equal(baseline.policy.spec.targetRef.kind, 'Service');
  assert.ok(!baseline.policy.spec.targetRef.group);
  assert.ok(
    !baseline.policy.spec.default?.timeoutSec ||
      baseline.policy.spec.default.timeoutSec >= profile.maxProtectedRequestSeconds,
  );
  assert.ok(
    !annotations(baseline.route)[marker] && !annotations(baseline.policy)[marker],
    'Another ingress transition is present',
  );
  assert.equal(baseline.route.spec.hostnames?.length, 1, 'A single explicit HTTPS hostname is required');
  assert.ok(
    baseline.route.spec.parentRefs?.length === 1 && baseline.route.spec.parentRefs[0].name === network.gatewayName,
  );
  assert.ok(baseline.route.spec.rules?.length > 0);
  for (const rule of baseline.route.spec.rules) {
    assert.ok(
      rule.backendRefs?.length === 1 &&
        rule.backendRefs[0].name === baseline.service.metadata.name &&
        (!rule.backendRefs[0].namespace || rule.backendRefs[0].namespace === namespace) &&
        (!rule.backendRefs[0].kind || rule.backendRefs[0].kind === 'Service') &&
        !rule.backendRefs[0].group,
      'Unsupported public route; preserve it for a separately reviewed transition',
    );
    assert.ok(
      !(rule.filters ?? []).some((f) => f.type === 'ResponseHeaderModifier'),
      'Response header policy needs explicit review',
    );
    assert.ok(
      !(rule.filters ?? []).some((f) => f.type === 'RequestMirror'),
      'Mirrored routes require separate continuity qualification',
    );
    assert.ok(
      baseline.service.spec.ports.some((p) => p.port === rule.backendRefs[0].port),
      'Public route references an unknown proxy port',
    );
  }
  const name = `${release.slice(0, 24)}-pc-${hash(token).slice(0, 10)}`;
  const labels = { 'app.kubernetes.io/instance': name, 'app.kubernetes.io/component': 'proxy-bridge', [marker]: token };
  const metadata = { name, namespace, labels, annotations: { [marker]: token } };
  const object = (apiVersion, kind, spec) => ({ apiVersion, kind, metadata: clone(metadata), spec });
  const template = clone(baseline.deployment.spec.template);
  delete template.metadata.ownerReferences;
  template.metadata.labels = { ...template.metadata.labels, ...labels };
  template.metadata.annotations = { ...template.metadata.annotations, [marker]: token };
  template.spec.terminationGracePeriodSeconds = profile.proxyTerminationGracePeriodSeconds;
  assert.ok(template.spec.containers?.length === 1, 'Only the reviewed single-container proxy is supported');
  for (const c of template.spec.containers) {
    assert.match(c.image, /@sha256:[a-f0-9]{64}$/);
    assert.ok(
      !c.env?.some((e) => /KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/.test(e.name) && e.value),
      'Plaintext proxy credentials must not enter the operation journal',
    );
    c.lifecycle = { preStop: { exec: { command: ['/bin/sh', '-c', `sleep ${profile.proxyPreStopDelaySeconds}`] } } };
  }
  // Rebind only selectors that actually selected the original proxy peers.
  const old = baseline.deployment.spec.selector.matchLabels;
  const rebind = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.matchLabels && Object.entries(old).every(([k, v]) => value.matchLabels[k] === v))
      value.matchLabels = { ...value.matchLabels, ...labels };
    for (const child of Object.values(value)) if (child && typeof child === 'object') rebind(child);
  };
  rebind(template.spec.affinity);
  rebind(template.spec.topologySpreadConstraints);
  assertProtectedProxyTemplate(template, profile);
  const service = object('v1', 'Service', {
    type: 'ClusterIP',
    selector: labels,
    ports: clone(baseline.service.spec.ports).map((p) => {
      const result = { ...p };
      delete result.nodePort;
      return result;
    }),
  });
  const policy = object('networking.gke.io/v1', 'GCPBackendPolicy', {
    default: {
      ...clone(baseline.policy.spec.default),
      connectionDraining: { drainingTimeoutSec: profile.backendServiceDrainSeconds },
    },
    targetRef: { group: '', kind: 'Service', name },
  });
  const health = object('networking.gke.io/v1', 'HealthCheckPolicy', {
    default: {
      config: { type: 'HTTP', httpHealthCheck: { portSpecification: 'USE_SERVING_PORT', requestPath: '/readyz' } },
    },
    targetRef: { group: '', kind: 'Service', name },
  });
  const probe = object('gateway.networking.k8s.io/v1', 'HTTPRoute', {
    parentRefs: clone(baseline.route.spec.parentRefs),
    hostnames: clone(baseline.route.spec.hostnames),
    rules: [
      {
        matches: [{ headers: [{ type: 'Exact', name: 'X-Rivet-Continuity-Probe', value: token }] }],
        backendRefs: [{ name, port: baseline.route.spec.rules[0].backendRefs[0].port, weight: 1 }],
        filters: [
          {
            type: 'ResponseHeaderModifier',
            responseHeaderModifier: { set: [{ name: servingHeader, value: 'bridge' }] },
          },
        ],
      },
    ],
  });
  probe.metadata.name = `${name}-probe`;
  const deployment = object('apps/v1', 'Deployment', {
    replicas: bridgeReplicas,
    strategy: { type: 'Recreate' },
    minReadySeconds: 120,
    selector: { matchLabels: labels },
    template,
  });
  const pdb = object('policy/v1', 'PodDisruptionBudget', {
    minAvailable: bridgeReplicas,
    selector: { matchLabels: labels },
  });
  return {
    name,
    bridgeReplicas,
    entries: [service, policy, health, probe, deployment, pdb].map((desired) => ({ desired, intent: false })),
    route: clone(baseline.route),
    policy: clone(baseline.policy),
    bindings: [baseline.service, baseline.deployment, baseline.gateway].map(identity),
    namespaceUid: baseline.namespaceUid,
    sourceTemplateDigest: hash(baseline.deployment.spec.template),
    hpa: clone(baseline.hpa),
  };
}

/** IO owns Kubernetes/provider observations. Mutation intents are checkpointed
 * first; recovery resolves an acknowledged write by reading, never replaying it. */
export function createProxyContinuityTransition({
  config,
  io,
  timeoutMs,
  now = () => performance.now(),
  wait = () => new Promise((r) => setTimeout(r, 1000)),
}) {
  assertRequestContinuityProfile(config.profile);
  assert.ok(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >
        Math.max(
          config.profile.backendServiceDrainSeconds,
          config.profile.propagationSeconds,
          config.profile.proxyTerminationGracePeriodSeconds,
        ) *
          1000,
    'Ingress deadline must exceed drain, propagation and proxy termination grace',
  );
  const digest = hash(config);
  const stateOf = (operation) => operation.record.proxyContinuity;
  const save = async (operation, patch) =>
    operation.checkpoint({ proxyContinuity: { ...stateOf(operation), ...patch } });
  const check = async (operation) => {
    operation.assertLease();
    const state = stateOf(operation);
    assert.equal(state.protocol, 1, 'Unknown ingress transition protocol');
    assert.ok(
      ['creating', 'bridge-serving', 'normal-serving', 'cleanup', 'complete'].includes(state.phase),
      'Unknown ingress transition phase',
    );
    assert.equal(state.configurationDigest, digest, 'Ingress recovery inputs changed');
    assert.equal(await io.namespaceUid(), state.namespaceUid, 'Ingress namespace lifetime changed');
    for (const bound of state.bindings) {
      const live = await io.read(bound);
      assert.equal(identity(live).uid, bound.uid, 'Ingress owner replaced');
      if (operation.record.phase === 'preflight' && bound.kind === 'Deployment' && bound.name === config.proxyName)
        assert.equal(
          hash(live.spec.template),
          state.sourceTemplateDigest,
          'Original proxy template changed before the owned Helm update',
        );
    }
    if (state.hpa) {
      const current = await io.read(identity(state.hpa));
      assert.equal(identity(current).uid, state.hpa.metadata.uid, 'Proxy HPA replaced');
      const frozen = frozenHpaSpec(state);
      const expected = state.hpaFreezeIntent && !state.hpaReleased ? frozen : state.hpa.spec;
      assert.ok(
        equal(current.spec, expected) || (state.hpaRestoreIntent && equal(current.spec, state.hpa.spec)),
        'Proxy HPA changed outside the owned transition',
      );
    }
    for (const entry of state.entries.filter((e) => e.uid && !e.absent)) {
      const live = await io.read(entry.desired, { optional: !!entry.deleteIntent });
      if (!live) continue;
      assert.equal(live.metadata.uid, entry.uid, 'Bridge owner replaced');
      assert.deepEqual(live.spec, entry.observedSpec, 'Bridge specification changed');
      assert.equal(annotations(live)[marker], operation.record.token, 'Bridge ownership changed');
    }
    // Check the latest owned intent, including writes whose response was lost.
    // A retry may observe it, but may never overwrite a different route/policy.
    const latest = new Map(Object.values(state.mutations ?? {}).map((m) => [m.uid, m]));
    for (const original of [state.route, state.policy].filter(Boolean)) {
      const live = await io.read(identity(original));
      assert.equal(identity(live).uid, original.metadata.uid, 'Routing owner replaced');
      const expected = latest.get(original.metadata.uid);
      assert.deepEqual(live.spec, expected?.expected ?? original.spec, 'Foreign routing specification');
      assert.deepEqual(
        annotations(live),
        expected?.annotations ?? annotations(original),
        'Foreign routing annotations',
      );
    }
  };
  const routeSpec = (state, target) => {
    const spec = clone(state.route.spec);
    for (const rule of spec.rules) {
      rule.backendRefs = [
        { ...rule.backendRefs[0], weight: target === 'normal' ? 1 : 0 },
        { name: state.name, port: rule.backendRefs[0].port, weight: target === 'bridge' ? 1 : 0 },
      ];
      rule.filters = [
        ...(rule.filters ?? []),
        { type: 'ResponseHeaderModifier', responseHeaderModifier: { set: [{ name: servingHeader, value: target }] } },
      ];
    }
    return spec;
  };
  const mutate = async (operation, key, original, expected, restore = false) => {
    await check(operation);
    const state = stateOf(operation),
      existing = state.mutations?.[key];
    const current = await io.read(identity(original));
    assert.equal(identity(current).uid, original.metadata.uid, 'Routing identity changed');
    const desiredAnnotations = { ...annotations(original), ...(!restore ? { [marker]: operation.record.token } : {}) };
    if (existing) {
      assert.deepEqual(existing.expected, expected, 'Recovery routing specification changed');
      assert.ok(
        equal(current.spec, expected) && equal(annotations(current), desiredAnnotations),
        'Routing write acknowledgement is unknown; retain serving owners',
      );
    } else {
      const previous = Object.values(state.mutations ?? {})
        .filter((m) => m.uid === current.metadata.uid)
        .at(-1);
      assert.deepEqual(current.spec, previous?.expected ?? original.spec, 'Foreign routing change');
      assert.deepEqual(
        annotations(current),
        previous?.annotations ?? annotations(original),
        'Foreign routing annotations',
      );
      await save(operation, {
        mutations: {
          ...state.mutations,
          [key]: { uid: current.metadata.uid, expected, annotations: desiredAnnotations, intent: true },
        },
      });
      operation.assertLease();
      await io.patch(current, expected, desiredAnnotations);
      const confirmed = await io.read(identity(original));
      assert.equal(identity(confirmed).uid, current.metadata.uid);
      assert.deepEqual(confirmed.spec, expected);
      assert.deepEqual(annotations(confirmed), desiredAnnotations);
    }
  };
  const quiet = async (operation, target, probe = false) => {
    const deadline = now() + timeoutMs;
    let since;
    while (true) {
      await check(operation);
      const state = stateOf(operation);
      const observation = await io.observe({ state, config, target, probe, token: operation.record.token });
      assert.equal(observation.healthy, true, 'Public ingress became unhealthy; serving owners retained');
      if (
        observation.routedTo === target &&
        observation.backendServiceDrainSeconds >= config.profile.backendServiceDrainSeconds
      )
        since ??= now();
      else since = undefined;
      const duration = probe
        ? config.profile.propagationSeconds * 1000
        : continuityHandoffSeconds(config.profile) * 1000;
      if (since !== undefined && now() - since >= duration) return;
      assert.ok(now() < deadline, 'Ingress propagation/drain was not confirmed; no serving owners removed');
      await wait();
    }
  };
  const returnTraffic = async (operation) => {
    await check(operation);
    if (stateOf(operation).phase === 'bridge-serving') {
      await io.normalReady(config, stateOf(operation));
      await mutate(operation, 'normal', stateOf(operation).route, routeSpec(stateOf(operation), 'normal'));
      await save(operation, { phase: 'normal-serving' });
    }
    if (stateOf(operation).phase === 'normal-serving') {
      if (!stateOf(operation).mutations?.restore) await quiet(operation, 'normal');
      await mutate(operation, 'restore', stateOf(operation).route, stateOf(operation).route.spec, true);
      const policy = stateOf(operation).policy,
        expectedPolicy = clone(policy.spec);
      expectedPolicy.default = {
        ...expectedPolicy.default,
        connectionDraining: { drainingTimeoutSec: config.profile.backendServiceDrainSeconds },
      };
      await mutate(operation, 'restorePolicy', policy, expectedPolicy, true);
      await save(operation, { phase: 'cleanup', routeRestored: true });
    }
  };
  return {
    identity: { configurationDigest: digest, profileDigest: continuityProfileDigest(config.profile) },
    async beforeRestoreAutoscalers(operation) {
      // Both pools retain the approved ceiling until normal traffic has had a
      // complete drain window to produce fresh, representative HPA samples.
      await returnTraffic(operation);
      if (stateOf(operation).hpaFreezeIntent && !stateOf(operation).hpaRestoreIntent) {
        await check(operation);
        await save(operation, { hpaRestoreIntent: true });
      }
    },
    templateValues(operation) {
      operation.assertLease();
      const state = stateOf(operation);
      assert.equal(state.configurationDigest, digest);
      return state.hpaFreezeIntent && !state.hpaRestoreIntent
        ? { autoscaling: { proxy: { minReplicas: state.bridgeReplicas, scaleDownPaused: true } } }
        : {};
    },
    async afterRestoreAutoscalers(operation) {
      const state = stateOf(operation);
      if (!state.hpaFreezeIntent) return;
      await check(operation);
      assert.deepEqual(
        (await io.read(identity(state.hpa))).spec,
        state.hpa.spec,
        'Proxy HPA restoration is unconfirmed',
      );
      await save(operation, { hpaReleased: true });
    },
    async verify(operation) {
      await check(operation);
      const state = stateOf(operation);
      assert.notEqual(state.phase, 'creating', 'Ingress protection has not been established');
      // A return-route write can commit before its phase checkpoint. Recover
      // from the recorded intent rather than expecting the previous route.
      const target = state.phase === 'bridge-serving' && !state.mutations?.normal ? 'bridge' : 'normal';
      const observed = await io.observe({ state, config, target, probe: false, token: operation.record.token });
      assert.equal(observed.healthy, true);
      assert.ok(observed.backendServiceDrainSeconds >= config.profile.backendServiceDrainSeconds);
      if (target === 'bridge' || (!state.routeRestored && !state.mutations?.restore))
        assert.equal(observed.routedTo, target, 'Ingress route is no longer confirmed');
    },
    async prepare(operation) {
      if (!stateOf(operation)) {
        const baseline = await io.baseline(config);
        assert.ok(baseline.namespaceUid && baseline.proxyPods?.length >= 2);
        // Validate the same route, HPA and source-template contract under the
        // owned lease even when no bootstrap resources will be needed.
        const bridge = buildProxyBridge(baseline, config, operation.record.token);
        const protectedAlready = baseline.proxyPods.every((p) => {
          try {
            assertProtectedProxyTemplate(p, config.profile);
            return true;
          } catch {
            return false;
          }
        });
        if (
          protectedAlready &&
          baseline.backendServiceDrainSeconds >= config.profile.backendServiceDrainSeconds &&
          baseline.policy.spec.default?.connectionDraining?.drainingTimeoutSec >=
            config.profile.backendServiceDrainSeconds
        ) {
          assertProtectedProxyTemplate(baseline.deployment.spec.template, config.profile);
          await save(operation, {
            protocol: 1,
            configurationDigest: digest,
            namespaceUid: baseline.namespaceUid,
            sourceTemplateDigest: hash(baseline.deployment.spec.template),
            route: baseline.route,
            policy: baseline.policy,
            bindings: [baseline.route, baseline.policy, baseline.service, baseline.deployment, baseline.gateway].map(
              identity,
            ),
            entries: [],
            phase: 'complete',
            routeRestored: true,
          });
          return;
        }
        // Verify provider admission before creating any pool or freezing HPA.
        // Autopilot can reduce a requested Pod termination budget on admission.
        if (io.admit) {
          const desired = bridge.entries.find((e) => e.desired.kind === 'Deployment').desired;
          const admitted = await io.admit(desired);
          assert.ok(
            subset(admitted.spec, desired.spec),
            'Provider admission changes the protected bridge specification; no bridge resources were created',
          );
        }
        await save(operation, {
          ...bridge,
          protocol: 1,
          configurationDigest: digest,
          phase: 'creating',
          routeRestored: false,
        });
      }
      const initial = stateOf(operation);
      if (initial.hpa && !initial.hpaFreezeIntent) {
        await check(operation);
        const current = await io.read(identity(initial.hpa)),
          frozen = frozenHpaSpec(initial);
        await save(operation, { hpaFreezeIntent: true });
        operation.assertLease();
        await io.patch(current, frozen, annotations(current));
      }
      await check(operation);
      if (['complete', 'normal-serving', 'cleanup'].includes(stateOf(operation).phase)) return;
      await io.sourceReady(stateOf(operation));
      for (let i = 0; i < stateOf(operation).entries.length; i++) {
        let state = stateOf(operation),
          entry = state.entries[i];
        if (entry.uid) {
          const current = await io.read(entry.desired);
          assert.equal(identity(current).uid, entry.uid);
          assert.deepEqual(current.spec, entry.observedSpec, 'Bridge specification changed');
          continue;
        }
        if (!entry.intent) {
          await io.beforeCreate?.(entry.desired, state, config);
          const entries = clone(state.entries);
          entries[i].intent = true;
          await save(operation, { entries });
          operation.assertLease();
          await io.create(entry.desired);
        }
        const current = await io.read(entry.desired);
        assert.equal(annotations(current)[marker], operation.record.token, 'Bridge ownership is unconfirmed');
        assert.ok(subset(current.spec, entry.desired.spec), 'Created bridge differs from reviewed specification');
        const entries = clone(stateOf(operation).entries);
        entries[i] = { ...entries[i], uid: identity(current).uid, observedSpec: clone(current.spec) };
        await save(operation, { entries });
      }
      await io.ready(stateOf(operation), config);
      const policy = stateOf(operation).policy;
      const policySpec = clone(policy.spec);
      policySpec.default = {
        ...policySpec.default,
        connectionDraining: { drainingTimeoutSec: config.profile.backendServiceDrainSeconds },
      };
      await mutate(operation, 'policy', policy, policySpec);
      await quiet(operation, 'bridge', true);
      await mutate(operation, 'bridge', stateOf(operation).route, routeSpec(stateOf(operation), 'bridge'));
      await quiet(operation, 'bridge');
      await save(operation, { phase: 'bridge-serving' });
    },
    async finish(operation) {
      await check(operation);
      assert.ok(
        !stateOf(operation).hpaFreezeIntent || stateOf(operation).hpaReleased,
        'Proxy HPA must be restored by the owning Helm operation',
      );
      if (stateOf(operation).phase === 'complete') return;
      assert.equal(stateOf(operation).phase, 'cleanup');
      for (let i = stateOf(operation).entries.length - 1; i >= 0; i--) {
        const entry = stateOf(operation).entries[i];
        if (entry.absent) continue;
        await check(operation);
        const live = await io.read(entry.desired, { optional: true });
        if (live) {
          assert.equal(live.metadata.uid, entry.uid, 'Refuse deleting a replacement bridge object');
          assert.equal(annotations(live)[marker], operation.record.token);
          assert.deepEqual(live.spec, entry.observedSpec, 'Bridge was changed before cleanup');
          if (!entry.deleteIntent) {
            const entries = clone(stateOf(operation).entries);
            entries[i].deleteIntent = true;
            await save(operation, { entries });
            operation.assertLease();
            await io.remove(live);
          }
        } else assert.ok(entry.deleteIntent, 'Bridge disappeared before owned deletion');
        await io.absent(entry);
        const entries = clone(stateOf(operation).entries);
        entries[i].absent = true;
        await save(operation, { entries });
      }
      await save(operation, { phase: 'complete' });
    },
  };
}
