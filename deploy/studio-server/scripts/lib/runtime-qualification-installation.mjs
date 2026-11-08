import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { autoscalerPolicy, autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import { assertOrdinaryRuntimeLayout } from './ha-release-evidence.mjs';
import { overlapQualificationProfile } from './qualification-overlap-profile.mjs';
import { requestContinuityProfile } from './request-continuity.mjs';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const installedSettingsDigest = (value) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;

/** An explicit reviewed target, not a claim about the live PostgreSQL limit. */
export function executionPoolCapacityProfile(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ['maxConnections', 'maxSurgeReplicas']);
  assert.ok(Number.isSafeInteger(value.maxConnections) && value.maxConnections > 0);
  assert.ok(Number.isSafeInteger(value.maxSurgeReplicas) && value.maxSurgeReplicas > 0);
  return { maxConnections: value.maxConnections, maxSurgeReplicas: value.maxSurgeReplicas };
}

/** Only chart-owned sizing/timing fields cross into staging; no env, endpoints,
 * secret references, raw settings or operation guards. */
export function qualificationSizing(values) {
  const pick = (value, keys) =>
    Object.fromEntries(keys.filter((k) => value?.[k] !== undefined).map((k) => [k, structuredClone(value[k])]));
  const resources = Object.fromEntries(
    ['proxy', 'web', 'backend', 'backendOverlap', 'execution', 'api'].map((role) => [
      role,
      Object.fromEntries(
        ['requests', 'limits']
          .filter((k) => values.resources?.[role]?.[k])
          .map((k) => [k, pick(values.resources[role][k], ['cpu', 'memory', 'ephemeral-storage'])]),
      ),
    ]),
  );
  return {
    replicaCount: pick(values.replicaCount, ['proxy']),
    autoscaling: {
      proxy: pick(values.autoscaling?.proxy, [
        'enabled',
        'minReplicas',
        'maxReplicas',
        'targetCPUUtilizationPercentage',
      ]),
    },
    availability: { topologySpread: pick(values.availability?.topologySpread, ['minDomains']) },
    resources,
    ...(values.ha?.executionPools?.enabled
      ? {
          ha: {
            executionPools: {
              enabled: true,
              active: values.ha.executionPools.active,
              ...(values.ha.executionPools.maxSurgeReplicas
                ? { maxSurgeReplicas: values.ha.executionPools.maxSurgeReplicas }
                : {}),
              retiringReplicas: 0,
            },
          },
        }
      : {}),
    ...(requestContinuityProfile(values)
      ? {
          requestContinuity: pick(values.requestContinuity, [
            'enabled',
            'maxProtectedRequestSeconds',
            'backendServiceDrainSeconds',
            'propagationSeconds',
          ]),
        }
      : {}),
    lifecycle: {
      ...pick(values.lifecycle, [
        'health',
        'shutdownGraceSeconds',
        'terminationGracePeriodSeconds',
        'preStopDelaySeconds',
        'probes',
      ]),
      ...(values.lifecycle?.proxy
        ? { proxy: pick(values.lifecycle.proxy, ['preStopDelaySeconds', 'terminationGracePeriodSeconds']) }
        : {}),
    },
    rollout: pick(values.rollout, ['minReadySeconds', 'maxUnavailable', 'maxSurge']),
    postgres: pick(values.postgres, ['maxConnections', 'reservedConnections', 'poolMaxPerApiPod']),
    legacyRestore: pick(values.legacyRestore, ['enabled', 'size']),
    publishedExecutionAdmission: pick(values.publishedExecutionAdmission, [
      'mode',
      'maxActiveRunsPerPod',
      'retryAfterSeconds',
    ]),
  };
}

export function assertQualificationInstallationMatches(current, expected) {
  assert.deepEqual(
    current.executionPoolCapacity ?? null,
    expected.executionPoolCapacity ?? null,
    'Reviewed execution capacity target changed since qualification',
  );
  assert.equal(
    installedSettingsDigest(current.qualificationValues ?? null),
    installedSettingsDigest(expected.qualificationValues ?? null),
    'Installation qualificationValues changed since qualification',
  );
  for (const key of ['manifestDigest', 'namespaceUid', 'clusterUid', 'settingsDigest', 'valuesDigest']) {
    assert.ok(typeof expected[key] === 'string' && expected[key].length > 0);
    assert.equal(current[key], expected[key], `Production ${key} changed since qualification`);
  }
}

/** Reads only. Never serialize raw Helm values: they can contain credentials. */
export async function inspectQualificationInstallation({
  context,
  namespace,
  release,
  expectedNamespaceUid,
  valuesText,
  valuesDigest,
  proxyMinimum,
  executionPoolCapacity,
  run,
  helm = 'helm',
  kubectl = 'kubectl',
  now = Date.now,
}) {
  for (const value of [context, namespace, release, expectedNamespaceUid])
    assert.ok(typeof value === 'string' && value.length > 0);
  const operatorValuesDigest = valuesDigest ?? `sha256:${createHash('sha256').update(valuesText).digest('hex')}`;
  assert.match(operatorValuesDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(proxyMinimum === undefined || [1, 2].includes(proxyMinimum), 'Reviewed proxy minimum must be one or two');
  if (executionPoolCapacity) executionPoolCapacity = executionPoolCapacityProfile(executionPoolCapacity);
  const system = JSON.parse(
    (await run(kubectl, ['--context', context, 'get', 'namespace', 'kube-system', '-o', 'json'], { capture: true }))
      .stdout,
  );
  assert.ok(system.metadata?.uid);
  const ns = JSON.parse(
    (await run(kubectl, ['--context', context, 'get', 'namespace', namespace, '-o', 'json'], { capture: true })).stdout,
  );
  assert.equal(ns.metadata.uid, expectedNamespaceUid);
  assert.ok(!ns.metadata.deletionTimestamp);
  const values = JSON.parse(
    (
      await run(helm, ['--kube-context', context, 'get', 'values', release, '-n', namespace, '--all', '-o', 'json'], {
        capture: true,
      })
    ).stdout,
  );
  const e = values.autoscaling.execution,
    c = values.autoscaling.executionController;
  const policy = autoscalerPolicy(
    Object.fromEntries(
      Object.entries({
        minReplicas: e.minReplicas,
        maxReplicas: e.maxReplicas,
        maxSurgeReplicas: values.ha?.executionPools?.maxSurgeReplicas ?? 0,
        targetCpuPercent: e.targetCPUUtilizationPercentage,
        ...Object.fromEntries(
          [
            'targetSlotsPercent',
            'stabilizationSeconds',
            'cooldownSeconds',
            'withdrawalSeconds',
            'pollSeconds',
            'metricsMaxAgeSeconds',
          ].map((k) => [k, c[k]]),
        ),
      }).filter(([, v]) => v !== undefined),
    ),
  );
  const policyDigest = autoscalerPolicyDigest(policy);
  const controlPlaneMode = values.ha?.controlPlane?.mode;
  const profile =
    controlPlaneMode === 'singleton-overlap'
      ? overlapQualificationProfile({
          protocol: 1,
          poolMaxPerApiPod: values.postgres.poolMaxPerApiPod,
          maxConnections: values.postgres.maxConnections,
          reservedConnections: values.postgres.reservedConnections,
          backendResources: values.resources.backendOverlap,
        })
      : undefined;
  assertOrdinaryRuntimeLayout(
    {
      protocol: profile ? 3 : 2,
      autoscalerPolicyDigest: policyDigest,
      ...(profile ? { developerOverlap: { profile } } : {}),
    },
    values,
  );
  const manifestDigest = values.release?.production?.manifestDigest;
  assert.match(manifestDigest, /^sha256:[a-f0-9]{64}$/);
  // A namespace replaced while Helm was being read must not inherit the old
  // installation's authority. Observe both namespace lifetimes again; no retry.
  for (const [name, uid] of [
    [namespace, ns.metadata.uid],
    ['kube-system', system.metadata.uid],
  ]) {
    const current = JSON.parse(
      (await run(kubectl, ['--context', context, 'get', 'namespace', name, '-o', 'json'], { capture: true })).stdout,
    );
    assert.equal(current.metadata.uid, uid, 'Installation namespace changed during observation');
    assert.ok(!current.metadata.deletionTimestamp, 'Installation namespace is terminating');
  }
  const qualificationValues = qualificationSizing(values);
  if (proxyMinimum !== undefined) {
    qualificationValues.replicaCount.proxy = proxyMinimum;
    qualificationValues.autoscaling.proxy.minReplicas = proxyMinimum;
    qualificationValues.availability.topologySpread.minDomains = proxyMinimum;
  }
  let targetPolicy = policy;
  if (executionPoolCapacity) {
    assert.equal(values.ha.executionPools?.enabled, true, 'Surge adoption requires an existing paired installation');
    assert.ok(
      executionPoolCapacity.maxSurgeReplicas >= (policy.maxSurgeReplicas ?? 0),
      'Surge adoption cannot reduce the existing ceiling',
    );
    assert.ok(
      executionPoolCapacity.maxConnections >= values.postgres.maxConnections,
      'Surge adoption cannot reduce the database budget',
    );
    targetPolicy = autoscalerPolicy({ ...policy, maxSurgeReplicas: executionPoolCapacity.maxSurgeReplicas });
    qualificationValues.ha.executionPools.maxSurgeReplicas = executionPoolCapacity.maxSurgeReplicas;
    qualificationValues.postgres.maxConnections = executionPoolCapacity.maxConnections;
  }
  return {
    scope: 'production-read-only',
    observedAt: new Date(now()).toISOString(),
    manifestDigest,
    images: Object.fromEntries(
      ['api', 'executor', 'proxy', 'web'].map((key) => [
        key,
        { repository: values.images?.[key]?.repository, digest: values.images?.[key]?.digest },
      ]),
    ),
    schemaVersion: values.release.production.database?.managedWorkflowSchemaVersion,
    namespaceUid: ns.metadata.uid,
    clusterUid: system.metadata.uid,
    settingsDigest: installedSettingsDigest(values),
    valuesDigest: operatorValuesDigest,
    policy: targetPolicy,
    policyDigest: autoscalerPolicyDigest(targetPolicy),
    ...(executionPoolCapacity ? { executionPoolCapacity } : {}),
    controlPlaneMode,
    edgeProfile: 'compact',
    baseline: { backend: 1, web: 1, execution: 2, proxy: values.autoscaling.proxy.minReplicas, autoscaler: 1 },
    qualificationValues,
  };
}
