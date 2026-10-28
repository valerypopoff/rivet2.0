import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, parseAllDocuments } from 'yaml';
import { HaReleaseGate } from './kubernetes-ha-release-gate.mjs';
import {
  runManagedGateCommand as run,
  createReleaseGateWebAppOAuthSession,
} from './kubernetes-managed-release-gate.mjs';
import { buildManagedReleaseGateConfig } from './lib/kubernetes-managed-release-gate-config.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { runHaKubernetesRollout } from './lib/ha-kubernetes-rollout.mjs';
import { createDeploymentSafety } from './lib/deployment-safety.mjs';
import { assertHaRetirement } from './lib/ha-rolling-upgrade.mjs';
import { runHaKubernetesControlTopology } from './lib/ha-kubernetes-control-topology.mjs';
import { startHaWorkflowTraffic, startHaWebAppTraffic } from './lib/ha-workflow-traffic.mjs';
import {
  runtimeQualificationPurpose,
  runOrdinaryRuntimeUpgrade,
  assertRuntimeUpgradePair,
  waitForOrdinaryRuntime,
} from './lib/runtime-upgrade-qualification.mjs';
import { HaReleaseProbes } from './lib/ha-release-probes.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
import {
  assertStudioServerReleaseManifest,
  assertReleaseManifestMatchesCurrentChart,
} from './lib/studio-server-release-manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const chart = path.join(root, 'deploy/studio-server/helm');
const normalResources = parse(readFileSync(path.join(chart, 'values.yaml'), 'utf8')).resources;
const role = (r) => r.metadata?.labels?.['app.kubernetes.io/component'];
const ready = (p) =>
  !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
export const runtimeControlOwnerContainer = (pod) => {
  const containers = pod.spec?.containers?.filter((c) => ['backend', 'api'].includes(c.name)) ?? [];
  assert.equal(containers.length, 1, 'fixture requires one unambiguous API owner container');
  return containers[0].name;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mergeRuntimeControlGuards = (values, guards) => ({
  ...values,
  ...guards,
  ha: { ...values.ha, ...guards.ha },
  replicaCount: { ...values.replicaCount, ...guards.replicaCount },
  workflowSchema: { ...values.workflowSchema, ...guards.workflowSchema },
});
export const hasRuntimeControlPublicEndpoint = (slices, services, uid) => {
  const publicNames = new Set(services.filter((s) => !s.spec.publishNotReadyAddresses).map((s) => s.metadata.name));
  return slices.some(
    (s) =>
      publicNames.has(s.metadata.labels?.['kubernetes.io/service-name']) &&
      s.endpoints?.some((e) => e.targetRef?.uid === uid && e.conditions?.ready !== false),
  );
};
export const waitForRuntimeControlColdProxies = (readPods, oldUids, timeout) =>
  until(
    'all old proxy processes exited',
    async () => (await readPods()).every((p) => !oldUids.includes(p.metadata.uid)),
    timeout,
  );
export function publishedScheduleCompletedWithoutDevelopers(runs, absentAt) {
  if (!runs.length) return false;
  assert.equal(runs.length, 1, 'The independence schedule must execute exactly once');
  const [run] = runs;
  if (['failed', 'interrupted'].includes(run.status)) throw Error('Published schedule failed without developer');
  if (run.startedAt !== undefined || run.status === 'succeeded')
    assert.ok(
      Number.isFinite(run.startedAt) && run.startedAt >= absentAt,
      'Schedule ran before developer processes were absent',
    );
  return run.status === 'succeeded' && run.recordingStatus === 'saved';
}
const until = async (name, check, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(`Local runtime control proof timed out: ${name}`);
    await sleep(500);
  }
};

/** Local functional proof only, never a promoted manifest/provider certificate.
 * Reuses the real managed fixture and release/retirement adapters. */
export class RuntimeControlLocalGate extends HaReleaseGate {
  get purpose() {
    return this.config.runtimeQualificationPurpose ?? 'adoption';
  }
  deploymentSafety(mode, manifestDigest) {
    return createDeploymentSafety({
      mode,
      scope: 'local',
      checkBaseline: () => this.assertLocalContext(),
      localIdentity: {
        release: this.config.release,
        namespace: this.config.namespace,
        context: this.config.context,
        namespaceUid: this.namespaceUid,
        candidateManifestDigest: manifestDigest,
      },
    });
  }
  get edgeProfile() {
    const profile = this.config.runtimeEdgeProfile ?? 'regional';
    assert.ok(['regional', 'compact'].includes(profile), 'unknown local GKE edge profile');
    return profile;
  }
  get proxyCount() {
    return this.edgeProfile === 'compact' ? 2 : 6;
  }
  async assertLocalContext() {
    assert.match(this.config.context, /^rivet-runtime-ha10-[a-z0-9-]+$/);
    assert.equal(this.config.context, this.config.allowedContext);
    assert.match(this.config.namespace, /^rivet-runtime-control-[a-z0-9-]+$/);
    await this.assertContext();
    const server = (
      await this.kubectl(['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'], {
        capture: true,
      })
    ).stdout.trim();
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(server).hostname),
      'proof API must be loopback-only',
    );
    const nodes = JSON.parse((await this.kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).stdout).items;
    assert.ok(nodes.length >= this.proxyCount + 1, 'distinct proxy hosts plus one surge host are required');
    assert.ok(
      nodes.every((n) => n.metadata.name.startsWith(this.config.context)),
      'foreign local node',
    );
  }
  async createNamespace() {
    const before = await this.kubectl(['get', 'namespace', this.config.namespace, '--ignore-not-found', '-o', 'name'], {
      capture: true,
    });
    assert.equal(before.stdout.trim(), '', 'proof requires a fresh namespace; never removes an earlier fixture');
    // Do not delegate to the resettable fixture's delete-before-create path:
    // another namespace could appear after the preliminary GET. CREATE labels
    // atomically and returns the actual new UID; a conflict/lost reply stops.
    const created = JSON.parse(
      (
        await this.kubectl(['create', '-f', '-', '-o', 'json'], {
          capture: true,
          input: JSON.stringify({
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
              name: this.config.namespace,
              labels: { 'rivet.release-gate/owned': 'true' },
            },
          }),
        })
      ).stdout,
    );
    assert.equal(created.metadata.name, this.config.namespace);
    assert.equal(created.metadata.labels['rivet.release-gate/owned'], 'true');
    assert.ok(created.metadata.uid);
    this.namespaceUid = created.metadata.uid;
    await this.artifact(
      'namespace-identity.json',
      JSON.stringify(
        {
          protocol: 1,
          context: this.config.context,
          namespace: this.config.namespace,
          release: this.config.release,
          namespaceUid: this.namespaceUid,
        },
        null,
        2,
      ),
    );
  }
  values(images = this.config.images, singleton = false) {
    const ordinary = this.purpose === 'ordinary-upgrade';
    if (ordinary) singleton = true;
    const manifest = ordinary
      ? [this.config.previousManifest, this.config.candidateManifest].find((m) => isDeepStrictEqual(m?.images, images))
      : null;
    if (ordinary) assert.ok(manifest, 'Images must belong to the exact ordinary predecessor/candidate pair');
    const base = super.values(images, manifest?.database.managedWorkflowSchema ?? this.config.managedWorkflowSchema);
    const policy = autoscalerPolicy(this.config.runtimeAutoscalerPolicy ?? {});
    if (ordinary) {
      assert.equal(policy.minReplicas, 2, 'Ordinary qualification requires the two-execution baseline');
      assert.ok(policy.maxReplicas >= 3, 'Ordinary qualification needs room for the execution surge');
    }
    return {
      ...base,
      ha: { ...base.ha, controlPlane: { mode: singleton ? 'singleton' : 'replicated' } },
      replicaCount: { proxy: this.proxyCount, web: singleton ? 1 : 2, backend: singleton ? 1 : 2, execution: 2 },
      ...(ordinary
        ? {
            // The old adoption fixture's 100m requests distort CPU-based
            // scaling during startup. Routine proofs use the chart's normal
            // developer/execution envelopes, not an under-reserved variant.
            resources: {
              ...base.resources,
              ...structuredClone({ backend: normalResources.backend, execution: normalResources.execution }),
            },
            release: { production: { manifestDigest: images.api.digest } },
            metrics: { enabled: true },
            autoscaling: {
              execution: {
                enabled: false,
                minReplicas: 2,
                maxReplicas: policy.maxReplicas,
                targetCPUUtilizationPercentage: policy.targetCpuPercent,
              },
              executionController: {
                enabled: true,
                suspended: false,
                targetSlotsPercent: policy.targetSlotsPercent,
                stabilizationSeconds: policy.stabilizationSeconds,
                cooldownSeconds: policy.cooldownSeconds,
                withdrawalSeconds: policy.withdrawalSeconds,
                pollSeconds: policy.pollSeconds,
                metricsMaxAgeSeconds: policy.metricsMaxAgeSeconds,
              },
              proxy: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 75 },
              web: { enabled: false },
              backend: { enabled: false },
            },
          }
        : {}),
      availability: {
        gkeGateway: true,
        gkeGatewayProfile: this.edgeProfile,
        disruptionBudget: { enabled: true, maxUnavailable: 1 },
        topologySpread: {
          enabled: true,
          topologyKey: 'topology.kubernetes.io/zone',
          whenUnsatisfiable: 'DoNotSchedule',
          maxSkew: 1,
          minDomains: this.edgeProfile === 'compact' ? 2 : 3,
          nodeTaintsPolicy: 'Honor',
        },
        podAntiAffinity: { enabled: true, required: true, topologyKey: 'kubernetes.io/hostname' },
      },
      // Local timing challenges, not replacement provider drain measurements.
      rollout: { minReadySeconds: 2, maxUnavailable: 0, maxSurge: 1 },
      lifecycle: { ...base.lifecycle, preStopDelaySeconds: 5 },
      publishedExecutionAdmission: { mode: 'enforce', maxActiveRunsPerPod: 4, retryAfterSeconds: 1 },
      env: {
        ...base.env,
        RIVET_ENABLE_DEVELOPMENT_AUTH: 'true',
        RIVET_DEVELOPMENT_AUTH_CLIENTS: '127.0.0.1/32,::1/128,10.0.0.0/8,192.168.0.0/16',
      },
      ...(this.coldProxyMarker
        ? { podAnnotations: { proxy: { 'rivet.dev/runtime-control-cold': this.coldProxyMarker } } }
        : {}),
    };
  }
  kube(args, extra = {}) {
    return this.kubectl(['-n', this.config.namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
  }
  async resources(values, name) {
    const file = path.join(this.config.artifactsDir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(values));
    return parseAllDocuments(
      (
        await run(
          this.helmBin,
          [
            'template',
            this.config.release,
            chart,
            '-n',
            this.config.namespace,
            '-f',
            path.join(chart, 'overlays/managed-release-gate.yaml'),
            '-f',
            file,
          ],
          { capture: true },
        )
      ).stdout,
    )
      .map((d) => {
        if (d.errors.length) throw d.errors[0];
        return d.toJS();
      })
      .filter(Boolean);
  }
  async transition(singleton) {
    const values = this.values(this.config.images, singleton),
      resources = await this.resources(values, `target-${singleton}`);
    return runHaKubernetesControlTopology({
      safety: this.deploymentSafety('topology', this.config.images.api.digest),
      kube: (...args) => this.kube(...args),
      release: this.config.release,
      namespace: this.config.namespace,
      manifestDigest: this.config.images.api.digest,
      resources,
      artifact: (...args) => this.artifact(...args),
      timeoutMs: 180_000,
      applyTemplates: (guards) => this.apply(mergeRuntimeControlGuards(values, guards), `transfer-${singleton}.json`),
    });
  }
  async roll(images, singleton, probes = {}) {
    const values = this.values(images, singleton),
      resources = await this.resources(values, `roll-${singleton}`);
    return runHaKubernetesRollout({
      safety: this.deploymentSafety('rolling', images.api.digest),
      kube: (...args) => this.kube(...args),
      release: this.config.release,
      namespace: this.config.namespace,
      manifestDigest: images.api.digest,
      ...(this.purpose === 'ordinary-upgrade'
        ? { previousManifestDigest: this.config.previousManifest.images.api.digest }
        : {}),
      resources,
      ...probes,
      timeoutMs: 180_000,
      artifact: (...args) => this.artifact(...args),
      applyTemplates: (_work, guards) => this.apply(mergeRuntimeControlGuards(values, guards), 'roll-template.json'),
      restoreAutoscalers: (_work, guards) =>
        this.apply(
          {
            ...mergeRuntimeControlGuards(values, guards),
            workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } },
          },
          'roll-final.json',
        ),
    });
  }
  async assertAutoscalerActive(after) {
    const expectedPolicy = autoscalerPolicyDigest(autoscalerPolicy(this.config.runtimeAutoscalerPolicy ?? {}));
    let observed;
    await until(
      'fresh completed autoscaler sampling',
      async () => {
        const raw = await this.kube([
          'get',
          'configmap',
          releaseOperationJournalName(this.config.release),
          '-o',
          'json',
        ]);
        const record = JSON.parse(JSON.parse(raw.stdout).data.record);
        if (
          record.autoscalingProtocol !== 1 ||
          record.phase !== 'complete' ||
          !Number.isFinite(record.leaseExpiresAt) ||
          record.leaseExpiresAt > Date.now() ||
          !Number.isFinite(record.lastSampleAt) ||
          record.lastSampleAt < after
        )
          return false;
        assert.equal(record.policyDigest, expectedPolicy);
        assert.equal(record.manifestDigest, this.config.images.api.digest);
        observed = { policyDigest: record.policyDigest, sampleAt: record.lastSampleAt };
        return true;
      },
      this.config.deploymentTimeoutSeconds * 1000,
    );
    return observed;
  }
  async pods() {
    return JSON.parse(
      (await this.kube(['get', 'pods', '-l', `app.kubernetes.io/instance=${this.config.release}`, '-o', 'json']))
        .stdout,
    ).items;
  }
  async prepareLocalRestoreVolume() {
    // Minikube's disposable hostPath provisioner neither applies fsGroup nor
    // pins the volume to its host. This is fixture setup, not a production fix.
    const claim = JSON.parse(
      (await this.kube(['get', 'pvc', `${this.config.release}-legacy-restore`, '-o', 'json'])).stdout,
    );
    const volume = JSON.parse((await this.kube(['get', 'pv', claim.spec.volumeName, '-o', 'json'])).stdout);
    assert.equal(volume.spec.claimRef.uid, claim.metadata.uid);
    assert.equal(volume.spec.claimRef.namespace, this.config.namespace);
    assert.equal(
      volume.spec.hostPath?.path,
      `/tmp/hostpath-provisioner/${this.config.namespace}/${claim.metadata.name}`,
      'only the fresh fixture hostPath may be initialized',
    );
    const owner = (await this.pods()).find((p) =>
      p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === claim.metadata.name),
    );
    assert.ok(owner?.spec.nodeName?.startsWith(this.config.context));
    assert.equal(volume.spec.nodeAffinity, undefined);
    await this.kube([
      'patch',
      'pv',
      volume.metadata.name,
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: volume.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: volume.metadata.resourceVersion },
        {
          op: 'add',
          path: '/spec/nodeAffinity',
          value: {
            required: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [owner.spec.nodeName] }],
                },
              ],
            },
          },
        },
      ]),
    ]);
    await this.kube(['create', '-f', '-'], {
      input: JSON.stringify({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'runtime-control-scratch-prepare' },
        spec: {
          restartPolicy: 'Never',
          nodeName: owner.spec.nodeName,
          containers: [
            {
              name: 'prepare',
              image: owner.spec.containers.find((c) => c.name === 'backend').image,
              securityContext: { runAsUser: 0 },
              command: ['/bin/sh', '-ec', 'chown 10001:10001 /scratch; chmod 0770 /scratch'],
              volumeMounts: [{ name: 'scratch', mountPath: '/scratch' }],
            },
          ],
          volumes: [{ name: 'scratch', persistentVolumeClaim: { claimName: claim.metadata.name } }],
        },
      }),
    });
    await this.kube([
      'wait',
      '--for=jsonpath={.status.phase}=Succeeded',
      'pod/runtime-control-scratch-prepare',
      '--timeout=60s',
    ]);
    await this.kube(['delete', 'pod/runtime-control-scratch-prepare', '--wait=true']);
  }
  requestWorkflow(base, route, options = {}) {
    return super.requestWorkflow(base, route, {
      ...options,
      headers: {
        ...options.headers,
        ...(this.publicAppCookie && route.startsWith('/apps/') ? { cookie: this.publicAppCookie } : {}),
      },
    });
  }
  async enableOAuth(base, relativePath, { allowNonLocalhost = false, sessionTtlSeconds = 3600 } = {}) {
    await this.requestWorkflow(base, '/api/app-settings/web-app-auth', {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'oauth',
        provider: 'dummy',
        dummyAllowNonLocalhost: allowNonLocalhost,
        dummyEmail: 'runtime-control@example.test',
        sessionSecret: randomUUID() + randomUUID(),
        sessionTtlSeconds,
      }),
    });
    const snapshot = await this.requestWorkflow(
      base,
      `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`,
    );
    await this.requestWorkflow(base, '/api/workflows/projects/web-apps/access', {
      method: 'PATCH',
      body: JSON.stringify({
        relativePath,
        preconditions: {
          expectedProjectId: snapshot.projectId,
          expectedDraftRevisionId: snapshot.draftRevisionId,
          expectedPublicationVersion: snapshot.publicationVersion,
        },
        accessUpdates: [{ uiGraphId: 'release-gate-web-app', allowedEmails: ['runtime-control@example.test'] }],
      }),
    });
    this.publicAppCookie = await createReleaseGateWebAppOAuthSession(
      base,
      'release-gate-web-app',
      'runtime-control@example.test',
    );
    return snapshot.projectId;
  }
  async waitForDeveloperRoute(base) {
    // The singleton contract permits a developer-only interruption. Pod Ready
    // can precede Service propagation to the proxy's UI-auth subrequest. Poll
    // only this safe GET before submitting any new mutation; never retry POSTs.
    await until('developer route recovery', async () => {
      try {
        await this.requestWorkflow(base, '/api/config', { method: 'GET', timeoutMs: 10_000 });
        // A successful load-balanced GET only proves one node has observed the
        // new Service endpoints. Check every local proxy before the next POST.
        const proxies = (await this.pods()).filter((p) => role(p) === 'proxy' && ready(p));
        if (proxies.length !== this.proxyCount) return false;
        const probes = await Promise.all(
          proxies.map((p) => {
            const port = p.spec.containers
              .find((c) => c.name === 'proxy')
              ?.ports?.find((v) => v.name === 'proxy-http')?.containerPort;
            assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
            return this.kube(
              [
                'exec',
                p.metadata.name,
                '-c',
                'proxy',
                '--',
                'sh',
                '-ec',
                `test -n "$RIVET_KEY"; wget -q -O /dev/null --header="Authorization: Bearer $RIVET_KEY" http://127.0.0.1:${port}/api/config`,
              ],
              { allowFailure: true },
            );
          }),
        );
        return probes.every((p) => p.exitCode === 0);
      } catch {
        return false;
      }
    });
  }
  async replaceIsolatedExecution() {
    // A cold execution process must also be independent of developer endpoints.
    // This is an owned local failure fixture, not a production upgrade command.
    await this.assertLocalContext();
    const ns = JSON.parse(
      (await this.kubectl(['get', 'namespace', this.config.namespace, '-o', 'json'], { capture: true })).stdout,
    );
    assert.equal(ns.metadata.uid, this.namespaceUid);
    assert.equal(ns.metadata.labels?.['rivet.release-gate/owned'], 'true');
    assert.ok(!(await this.pods()).some((p) => ['backend', 'web'].includes(role(p))));
    const name = `${this.config.release}-ha-execution`;
    const workload = JSON.parse((await this.kube(['get', 'statefulset', name, '-o', 'json'])).stdout);
    assert.equal(workload.spec.replicas, 2);
    const scale = async (from, to) => {
      const current = JSON.parse((await this.kube(['get', 'statefulset', name, '-o', 'json'])).stdout);
      assert.equal(current.metadata.uid, workload.metadata.uid);
      assert.equal(current.spec.replicas, from);
      await this.kube([
        'scale',
        `statefulset/${name}`,
        `--replicas=${to}`,
        `--current-replicas=${from}`,
        `--resource-version=${current.metadata.resourceVersion}`,
      ]);
    };
    const observe = async (podName) => (await this.pods()).find((p) => p.metadata.name === podName);
    const readyOwners = async () => {
      assert.ok(!(await this.pods()).some((p) => ['backend', 'web'].includes(role(p))));
      assert.ok((await this.pods()).filter((p) => role(p) === 'execution' && ready(p)).length >= 2);
    };
    const retire = async (pod) => {
      const ownerContainer = runtimeControlOwnerContainer(pod);
      const invoke = async (...args) => {
        assert.equal((await observe(pod.metadata.name))?.metadata.uid, pod.metadata.uid);
        return assertHaRetirement(
          JSON.parse(
            (
              await this.kube([
                'exec',
                pod.metadata.name,
                '-c',
                ownerContainer,
                '--',
                'node',
                '/opt/rivet/retire-backend.mjs',
                ...args,
              ])
            ).stdout,
          ),
        );
      };
      const before = await invoke(),
        operation = randomUUID();
      assert.equal(before.state, 'serving');
      assert.ok(!before.operationId);
      const services = JSON.parse((await this.kube(['get', 'service', '-o', 'json'])).stdout).items;
      await invoke(operation, before.incarnation, '--withdraw-only');
      await until('isolated execution routing withdrawal', async () => {
        await readyOwners();
        return !hasRuntimeControlPublicEndpoint(
          JSON.parse((await this.kube(['get', 'endpointslice', '-o', 'json'])).stdout).items,
          services,
          pod.metadata.uid,
        );
      });
      await invoke(operation, before.incarnation, '--begin-only');
      await until('isolated execution accepted work', async () => {
        await readyOwners();
        return assertHaRetirement(await invoke(), before.incarnation, operation).state === 'drained';
      });
    };
    await scale(2, 3);
    await until('independent execution surge', async () => ready((await observe(`${name}-2`)) ?? { metadata: {} }));
    const old = await observe(`${name}-0`);
    assert.ok(old?.metadata.uid && ready(old));
    await retire(old);
    await this.kube(
      ['delete', '--raw', `/api/v1/namespaces/${this.config.namespace}/pods/${old.metadata.name}`, '-f', '-'],
      {
        input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: old.metadata.uid } }),
      },
    );
    await until('cold independent execution replacement', async () => {
      await readyOwners();
      const replacement = await observe(old.metadata.name);
      return replacement?.metadata.uid !== old.metadata.uid && ready(replacement ?? { metadata: {} });
    });
    const surge = await observe(`${name}-2`);
    await retire(surge);
    assert.equal((await observe(surge.metadata.name))?.metadata.uid, surge.metadata.uid);
    await scale(3, 2);
    await until('independent surge process exit', async () => !(await observe(surge.metadata.name)));
    await readyOwners();
    await this.artifact(
      'isolated-execution-replacement.json',
      JSON.stringify(
        {
          oldUid: old.metadata.uid,
          newUid: (await observe(old.metadata.name)).metadata.uid,
          developerPods: 0,
          executionReady: 2,
        },
        null,
        2,
      ),
    );
  }
  async isolateRuntime(base, projectId) {
    const scheduled = await this.requestWorkflow(base, '/api/workflows/scheduled-runs', {
      method: 'POST',
      body: JSON.stringify({
        requestId: randomUUID(),
        draft: {
          name: 'Published without developer',
          description: '',
          projectId,
          version: 'published',
          enabled: true,
          timeZone: 'UTC',
          schedule: {
            kind: 'once',
            localTime: new Date(Date.now() + (this.independenceScheduleDelayMs ?? 120_000)).toISOString().slice(0, 16),
          },
          input: { input: 'scheduled-runtime-independence' },
          record: true,
          timeoutMinutes: 1,
          missed: 'latest',
        },
      }),
    });
    assert.match(scheduled.id, /^[a-f0-9-]{36}$/);
    const p = (await this.pods()).find((p) => role(p) === 'backend');
    const invoke = async (...args) =>
      JSON.parse(
        (
          await this.kube([
            'exec',
            p.metadata.name,
            '-c',
            'backend',
            '--',
            'node',
            '/opt/rivet/retire-backend.mjs',
            ...args,
          ])
        ).stdout,
      );
    const status = await invoke(),
      operation = randomUUID();
    const services = JSON.parse((await this.kube(['get', 'services', '-o', 'json'])).stdout).items;
    await invoke(operation, status.incarnation, '--withdraw-only');
    await until(
      'developer routing withdrawal',
      async () =>
        !hasRuntimeControlPublicEndpoint(
          JSON.parse((await this.kube(['get', 'endpointslice', '-o', 'json'])).stdout).items,
          services,
          p.metadata.uid,
        ),
    );
    await invoke(operation, status.incarnation, '--begin-only');
    await until('developer accepted work', async () => (await invoke()).state === 'drained');
    if (this.scaleExact) {
      await this.scaleExact('statefulset', `${this.config.release}-ha-backend`, 1, 0);
      await this.scaleExact('deployment', `${this.config.release}-web`, 1, 0);
    } else {
      await this.kube([
        'scale',
        `statefulset/${this.config.release}-ha-backend`,
        '--replicas=0',
        '--current-replicas=1',
      ]);
      await this.kube(['scale', `deployment/${this.config.release}-web`, '--replicas=0', '--current-replicas=1']);
    }
    await until(
      'no developer processes',
      async () => !(await this.pods()).some((p) => ['backend', 'web'].includes(role(p))),
    );
    const developersAbsentAt = Date.now();
    const before = (await this.pods()).filter((p) => role(p) === 'proxy').map((p) => p.metadata.uid);
    this.coldProxyMarker = randomUUID();
    const proxy = JSON.parse(
      (await this.kube(['get', 'deployment', `${this.config.release}-proxy`, '-o', 'json'])).stdout,
    );
    await this.kube([
      'patch',
      'deployment',
      `${this.config.release}-proxy`,
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: proxy.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: proxy.metadata.resourceVersion },
        {
          op: 'add',
          path: '/spec/template/metadata/annotations',
          value: {
            ...proxy.spec.template.metadata.annotations,
            'rivet.dev/runtime-control-cold': this.coldProxyMarker,
          },
        },
      ]),
    ]);
    await this.kube([
      'rollout',
      'status',
      `deployment/${this.config.release}-proxy`,
      `--timeout=${(this.independenceTimeoutMs ?? 180000) / 1000}s`,
    ]);
    await waitForRuntimeControlColdProxies(() => this.pods(), before, this.independenceTimeoutMs);
    await this.verifyPublishedBrowser(base);
    await until(
      'published schedule with control absent',
      async () => {
        const result = await this.kube([
          'exec',
          'deployment/release-gate-postgres',
          '--',
          'psql',
          '-U',
          'rivet',
          '-d',
          'rivet',
          '-At',
          '-c',
          `SELECT COALESCE(json_agg(json::json), '[]') FROM rivet_schedule_runs WHERE schedule_id='${scheduled.id}'`,
        ]);
        const runs = JSON.parse(result.stdout.trim());
        return publishedScheduleCompletedWithoutDevelopers(runs, developersAbsentAt);
      },
      this.independenceTimeoutMs,
    );
    if (this.purpose === 'adoption') await this.replaceIsolatedExecution();
    await this.apply(this.values(this.config.images, true), 'developer-recovered.json');
    await this.waitForDeveloperRoute(base);
    return {
      coldProxyReplacement: true,
      coldExecutionReplacement: this.purpose === 'adoption',
      browserOAuthAction: true,
      publishedScheduleRecording: true,
    };
  }
  async verifyPublishedBrowser(base) {
    const proof = await run(
      process.execPath,
      [
        path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
        'studio-server:ui:observe',
        'runtime-control-independence.spec.ts',
      ],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: '1',
          PLAYWRIGHT_SLOW_MO: '0',
          PLAYWRIGHT_BASE_URL: base,
          RIVET_RUNTIME_CONTROL_FIXTURE: '1',
        },
      },
    );
    assert.equal(proof.exitCode, 0);
  }
}

async function adoptionMain() {
  const config = buildManagedReleaseGateConfig({ rootDir: root, mode: 'smoke' });
  config.runtimeEdgeProfile = process.env.RIVET_RUNTIME_EDGE_PROFILE ?? 'regional';
  config.runtimeQualificationPurpose = 'adoption';
  config.keepNamespace = true;
  const baseline = JSON.parse(await fs.readFile(process.env.RIVET_RUNTIME_CONTROL_BASELINE_IMAGES, 'utf8'));
  const next = process.env.RIVET_RUNTIME_CONTROL_NEXT_IMAGES
    ? JSON.parse(await fs.readFile(process.env.RIVET_RUNTIME_CONTROL_NEXT_IMAGES, 'utf8'))
    : undefined;
  if (next) assert.notEqual(next.api?.digest, config.images.api.digest, 'next API must be a different immutable build');
  const gate = new RuntimeControlLocalGate(
    config,
    process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
    resolveHelmBinOrThrow(root),
  );
  let traffic,
    web,
    phase = 'prepare',
    sampler,
    sampling = false;
  let failure;
  const report = { qualification: 'local-functional-only', edgeProfile: gate.edgeProfile, phases: [], readiness: [] };
  const fullCount = gate.proxyCount + 7,
    singletonCount = gate.proxyCount + 4;
  try {
    await gate.assertLocalContext();
    await fs.mkdir(config.artifactsDir, { recursive: true });
    await gate.createNamespace();
    await gate.createRegistrySecret();
    await gate.installDependencies();
    await gate.apply(gate.values(baseline), `old-${fullCount}.json`);
    const base = await gate.openProxy();
    const state = await gate.exercisePersistence(base);
    const projectId = await gate.enableOAuth(base, state.relativePath);
    await gate.prepareLocalRestoreVolume();
    const sentinel = randomUUID();
    await gate.kube([
      'exec',
      `${config.release}-maintenance-backend-0`,
      '-c',
      'backend',
      '--',
      'node',
      '--input-type=module',
      '-e',
      `await (await import('node:fs/promises')).writeFile('/data/rivet-restore/runtime-control-fixture',${JSON.stringify(sentinel)})`,
    ]);
    traffic = startHaWorkflowTraffic(gate, base, () => phase);
    web = startHaWebAppTraffic(gate, base, () => phase);
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        const pods = await gate.pods();
        const count = pods.filter((p) => role(p) === 'execution' && ready(p)).length;
        const health = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(10_000) });
        assert.equal(health.status, 200, 'the real edge health path must remain available during ownership transfer');
        const snapshot = await health.json();
        assert.equal(snapshot.ok, true);
        report.readiness.push({
          at: new Date().toISOString(),
          phase,
          executionReady: count,
          healthProfile: snapshot.profile,
        });
        assert.ok(count >= 2, 'production execution fell below two ready owners');
        await sleep(500);
      }
    })();
    sampler.catch(() => {});
    phase = `old-to-bridge-${fullCount}`;
    await gate.roll(config.images, false);
    report.phases.push(phase);
    phase = `bridge-${fullCount}-to-${singletonCount}`;
    await gate.transition(true);
    report.phases.push(phase);
    await gate.waitForDeveloperRoute(base);
    const readSentinel = async (name) =>
      (
        await gate.kube([
          'exec',
          name,
          '-c',
          'backend',
          '--',
          'node',
          '--input-type=module',
          '-e',
          "console.log(await (await import('node:fs/promises')).readFile('/data/rivet-restore/runtime-control-fixture','utf8'))",
        ])
      ).stdout.trim();
    assert.equal(
      await readSentinel(`${config.release}-ha-backend-0`),
      sentinel,
      'forward transfer must preserve actual disk bytes',
    );
    assert.equal((await gate.pods()).filter((p) => !p.metadata.deletionTimestamp).length, singletonCount);
    phase = 'embedded-maintenance';
    const bundle = await gate.requestWorkflow(base, '/api/workflows/project-bundles', {
      method: 'POST',
      body: JSON.stringify({ relativePath: state.relativePath, version: 'published', requestId: randomUUID() }),
    });
    let archive;
    await until('embedded export', async () => {
      archive = await gate.requestWorkflow(base, `/api/workflows/project-bundles/${bundle.id}`);
      if (['failed', 'interrupted'].includes(archive.phase)) throw Error('Embedded export failed');
      return archive.phase === 'ready';
    });
    const download = await fetch(`${base}/api/workflows/project-bundles/${bundle.id}/download`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(download.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await download.arrayBuffer()))
        .digest('hex'),
      archive.archiveHash,
    );
    report.phases.push(phase);
    phase = 'runtime-without-developers';
    report.independence = await gate.isolateRuntime(base, projectId);
    report.phases.push(phase);
    if (next) {
      phase = 'singleton-mixed-image-roll';
      await gate.roll(next, true);
      config.images = next;
      report.phases.push(phase);
    }
    phase = 'singleton-serial-roll';
    // Same immutable image, deliberately changed pod-template annotation: this
    // proves serial RWO replacement, not a second mixed-image certificate.
    const annotated = gate.values(config.images, true);
    annotated.podAnnotations = {
      ...annotated.podAnnotations,
      backend: { 'rivet.dev/local-control-proof': randomUUID() },
    };
    const resources = await gate.resources(annotated, 'serial-roll');
    await runHaKubernetesRollout({
      safety: gate.deploymentSafety('rolling', config.images.api.digest),
      kube: (...args) => gate.kube(...args),
      release: config.release,
      namespace: config.namespace,
      manifestDigest: config.images.api.digest,
      resources,
      timeoutMs: 180_000,
      applyTemplates: (_w, g) => gate.apply(mergeRuntimeControlGuards(annotated, g), 'serial-template.json'),
      restoreAutoscalers: (_w, g) =>
        gate.apply(
          {
            ...mergeRuntimeControlGuards(annotated, g),
            workflowSchema: { ...annotated.workflowSchema, migrationJob: { enabled: false } },
          },
          'serial-final.json',
        ),
    });
    report.phases.push(phase);
    phase = `reverse-${singletonCount}-to-${fullCount}`;
    await gate.transition(false);
    report.phases.push(phase);
    await gate.waitForDeveloperRoute(base);
    assert.equal(
      await readSentinel(`${config.release}-maintenance-backend-0`),
      sentinel,
      'reverse transfer must preserve actual disk bytes',
    );
    assert.equal((await gate.pods()).filter((p) => !p.metadata.deletionTimestamp).length, fullCount);
  } catch (error) {
    failure = error;
  } finally {
    sampling = false;
    const observations = await Promise.allSettled([sampler, traffic?.stop(), web?.stop()]);
    report.traffic = traffic?.report;
    report.web = web?.report;
    if (observations.some((r) => r.status === 'rejected'))
      failure ??= Error('Local runtime readiness observation failed.');
    if (traffic?.report.failures.length || web?.report.failures.length)
      failure ??= Error('Public traffic failed during the local proof.');
    report.outcome = failure ? 'failed' : 'passed';
    await gate.artifact('runtime-control-local-report.json', JSON.stringify(report, null, 2));
    await gate.capture('runtime-control-final').catch(() => {});
    await gate.close();
  }
  if (failure) throw failure;
  console.log(
    `Local mixed-image bridge, ${singletonCount}-pod transfer, embedded export, serial replacement and reverse transfer passed.`,
  );
}

async function ordinaryMain() {
  const config = buildManagedReleaseGateConfig({ rootDir: root, mode: 'smoke' });
  config.runtimeQualificationPurpose = 'ordinary-upgrade';
  config.runtimeEdgeProfile = process.env.RIVET_RUNTIME_EDGE_PROFILE ?? 'compact';
  assert.equal(
    config.runtimeEdgeProfile,
    'compact',
    'Ordinary seven-pod proof is compact only; select adoption explicitly for conversions',
  );
  config.previousManifest = assertStudioServerReleaseManifest(
    JSON.parse(await fs.readFile(process.env.RIVET_RUNTIME_CONTROL_BASELINE_MANIFEST, 'utf8')),
    { requirePromoted: true },
  );
  config.candidateManifest = assertStudioServerReleaseManifest(
    JSON.parse(await fs.readFile(process.env.RIVET_RUNTIME_CONTROL_CANDIDATE_MANIFEST, 'utf8')),
  );
  assertRuntimeUpgradePair(config.previousManifest, config.candidateManifest);
  assertReleaseManifestMatchesCurrentChart(config.candidateManifest, root, { requirePromoted: false });
  assert.deepEqual(config.images, config.candidateManifest.images);
  config.runtimeAutoscalerPolicy = process.env.RIVET_RUNTIME_AUTOSCALER_POLICY
    ? JSON.parse(await fs.readFile(process.env.RIVET_RUNTIME_AUTOSCALER_POLICY, 'utf8'))
    : undefined;
  // Failed accepted work is retained for explicit settlement, never forced away.
  config.keepNamespace = true;
  const gate = new RuntimeControlLocalGate(
    config,
    process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
    resolveHelmBinOrThrow(root),
  );
  try {
    await gate.assertLocalContext();
    await fs.mkdir(config.artifactsDir, { recursive: true });
    await gate.createNamespace();
    await gate.createRegistrySecret();
    await gate.installDependencies();
    await gate.apply(gate.values(config.previousManifest.images, true), 'ordinary-predecessor.json');
    await waitForOrdinaryRuntime(gate, config.previousManifest.images, (name, check) =>
      until(name, check, config.deploymentTimeoutSeconds * 1000),
    );
    const baseUrl = await gate.openProxy();
    await gate.waitForDeveloperRoute(baseUrl);
    const state = await gate.exercisePersistence(baseUrl);
    await gate.artifact('ha-persisted-state.json', JSON.stringify(state));
    await gate.enableOAuth(baseUrl, state.relativePath);
    await gate.prepareLocalRestoreVolume();
    const probes = new HaReleaseProbes(gate, baseUrl, root);
    await runOrdinaryRuntimeUpgrade({
      gate,
      previous: config.previousManifest,
      candidate: config.candidateManifest,
      probes,
      baseUrl,
      until: (name, check) => until(name, check, config.deploymentTimeoutSeconds * 1000),
    });
  } catch (error) {
    // Do not inspect a pre-existing/foreign namespace if the fresh-namespace
    // guard failed. Bootstrap failures are still useful private diagnostics.
    if (gate.namespaceUid) await gate.capture('ordinary-command-failure').catch(() => {});
    throw error;
  } finally {
    await gate.close();
  }
}

async function main() {
  const purpose = runtimeQualificationPurpose(process.env.RIVET_RUNTIME_QUALIFICATION_PURPOSE);
  await (purpose === 'adoption' ? adoptionMain() : ordinaryMain());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
