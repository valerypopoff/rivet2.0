import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { RuntimeControlLocalGate, mergeRuntimeControlGuards } from '../kubernetes-runtime-control-local.mjs';
import {
  renderSecrets,
  renderDependencies,
  runManagedGateCommand as run,
  createReleaseGateWebAppOAuthSession,
} from '../kubernetes-managed-release-gate.mjs';
import { runHaKubernetesRollout, haRolloutAutoscalingValues } from '../lib/ha-kubernetes-rollout.mjs';
import { createDeploymentSafety } from '../lib/deployment-safety.mjs';
import { releaseOperationJournalName } from '../lib/release-operation-journal.mjs';
import { getStudioServerReleaseManifestDigest } from '../lib/studio-server-release-manifest.mjs';
import { waitForGkeFrontendAvailability } from '../lib/ha-gke-availability.mjs';
import { resolveHelmBinOrThrow } from '../lib/k8s-tools.mjs';
import { inspectStagingPrerequisites } from '../lib/reusable-staging-prerequisites.mjs';
import { applyOverlapQualificationProfile } from '../lib/qualification-overlap-profile.mjs';
import { requestContinuityProfile, continuityTimeoutMs, continuityFromResources } from '../lib/request-continuity.mjs';
import { createKubernetesProxyContinuity, createComputeBackendObserver } from '../lib/proxy-continuity-kubernetes.mjs';
import { stagingAccessToken, stagingCloudReader } from '../lib/reusable-staging-cloud.mjs';
import { observeStagingInventory } from '../lib/reusable-staging-cleanup.mjs';
import { stagingHostname } from '../lib/reusable-staging-state.mjs';

export const root =
  process.env.RIVET_QUALIFICATION_SOURCE_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url));
const ipaddr = createRequire(path.join(root, 'packages/studio-server-api/package.json'))('ipaddr.js');
export const role = (p) => p.metadata?.labels?.['app.kubernetes.io/component'];
export const ready = (p) =>
  !!p && !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(label, check, timeoutMs = 1200000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(1000);
  }
  throw Error(`Staging observation timed out: ${label}`);
}
const imageDigest = (manifest) =>
  getStudioServerReleaseManifestDigest(manifest, { requirePromoted: manifest.state === 'promoted' });
export class ReusableProviderGate extends RuntimeControlLocalGate {
  constructor(operation, settings, state, privateDirectory, { runRollout = runHaKubernetesRollout } = {}) {
    const namespace = `rivet-staging-${operation.operationId}`,
      release = 'rivet-qualification';
    const config = {
      context: settings.context,
      allowedContext: settings.context,
      namespace,
      release,
      baseUrl: `https://${stagingHostname(settings, operation)}`,
      artifactsDir: privateDirectory,
      images: operation.candidate.images,
      previousManifest: operation.previous,
      candidateManifest: operation.candidate,
      managedWorkflowSchema: operation.candidate.database.managedWorkflowSchema,
      imagePullPolicy: 'IfNotPresent',
      runtimeQualificationPurpose: 'ordinary-upgrade',
      runtimeEdgeProfile: 'compact',
      runtimeAutoscalerPolicy: operation.policy,
      registry: { secretName: 'rivet-release-gate-registry' },
      keepNamespace: true,
      deploymentTimeoutSeconds: 1200,
    };
    super(config, process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl', resolveHelmBinOrThrow(root));
    this.operation = operation;
    this.settings = settings;
    this.state = state;
    this.profile = 'compact';
    this.singleton = true;
    this.overlap = operation.installed.controlPlaneMode === 'singleton-overlap';
    this.overlapProfilePrepared = this.overlap;
    this.controllerEnabled = true;
    this.manifest = operation.candidate;
    this.currentManifest = operation.previous;
    this.identity = { clusterServer: settings.clusterServer, expiresAt: operation.expiresAt };
    this.journalName = releaseOperationJournalName(release);
    this.runRollout = runRollout;
    this.observeProxyBackend = createComputeBackendObserver(
      { gcpProject: settings.projectId, gcpRegion: settings.region },
      { accessToken: stagingAccessToken, minimumRequestSeconds: 0 },
    );
  }
  async assertLocalContext() {
    await this.assertProofContext();
  }
  async verifySharedPrerequisites() {
    return inspectStagingPrerequisites(this.state);
  }
  async verifyOverlapCapacity() {
    if (!this.operation.developerOverlapProfile) return;
    // Render-only identity cannot be used by apply(): that independently reads
    // the real staging namespace. No cluster command or billable write occurs.
    const values = applyOverlapQualificationProfile(
      this.values(this.operation.previous.images),
      this.operation.developerOverlapProfile,
    );
    values.ha = { ...values.ha, namespaceUid: randomUUID(), controlPlane: { mode: 'singleton-overlap' } };
    await this.resources(values, 'overlap-capacity-preflight');
  }
  async verifyLocalBrowserFixture() {
    // Intercepted page/WS only: prove the runner can launch its actual browser
    // and use the shared auth/action journey before creating paid test resources.
    await run(
      process.execPath,
      [
        path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
        'studio-server:ui:observe',
        'runtime-control-fixture-contract.spec.ts',
      ],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: '1',
          PLAYWRIGHT_SLOW_MO: '0',
          RIVET_QUALIFICATION_BROWSER_ARTIFACTS: path.join(this.config.artifactsDir, 'browser-setup'),
        },
        capture: true,
      },
    );
  }
  async assertProofContext() {
    await this.state.admission();
    const ns = await this.state.namespace();
    assert.ok(ns && !ns.metadata.deletionTimestamp);
    this.namespaceUid = ns.metadata.uid;
    const system = JSON.parse(
      (await super.kubectl(['get', 'namespace', 'kube-system', '-o', 'json'], { capture: true })).stdout,
    );
    assert.equal(system.metadata.uid, this.settings.clusterUid, 'Staging kubectl credential points to another cluster');
  }
  async kubectl(args, options) {
    await this.assertProofContext();
    return super.kubectl(args, options);
  }
  async kube(args, extra = {}) {
    return super.kube(args, extra);
  }
  deploymentSafety(mode, digest) {
    return createDeploymentSafety({
      mode,
      scope: 'rehearsal',
      checkBaseline: () => this.assertProofContext(),
      localIdentity: {
        release: this.config.release,
        namespace: this.config.namespace,
        context: this.config.context,
        namespaceUid: this.namespaceUid,
        candidateManifestDigest: digest,
      },
    });
  }
  values(images = this.config.images) {
    const values = super.values(images, true);
    const manifest = [this.operation.previous, this.operation.candidate].find((m) =>
      isDeepStrictEqual(m.images, images),
    );
    assert.ok(manifest);
    const envelope = this.operation.installed.qualificationValues;
    assert.ok(envelope, 'Production runtime sizing must be explicitly observed');
    this.providerValues = {
      ...values,
      ...structuredClone(envelope),
      release: {
        production: {
          manifestDigest: imageDigest(manifest),
          database: { managedWorkflowSchemaVersion: manifest.database.managedWorkflowSchema.version },
        },
      },
      postgres: { ...values.postgres, ...envelope.postgres },
      imagePullSecrets: this.settings.registrySecret ? [{ name: 'rivet-release-gate-registry' }] : [],
      legacyRestore: {
        ...values.legacyRestore,
        ...envelope.legacyRestore,
        storageClassName: this.settings.storageClassName,
      },
      podAnnotations: {
        ...values.podAnnotations,
        ...(this.executionRollMarker
          ? { execution: { 'rivet.dev/runtime-cooperative-roll': this.executionRollMarker } }
          : {}),
      },
      env: {
        ...values.env,
        RIVET_SERVER_UI_AUTH_MODE: 'key',
        RIVET_REQUIRE_UI_GATE_KEY: 'true',
        RIVET_ENABLE_DEVELOPMENT_AUTH: 'true',
        RIVET_DEVELOPMENT_AUTH_CLIENTS: this.settings.trustedClients.join(','),
        RIVET_TRUSTED_FORWARDING_PROXIES: this.settings.trustedForwardingProxies.join(','),
        RIVET_CORS_ALLOWED_ORIGINS: this.config.baseUrl,
        RIVET_TRUST_INCOMING_FORWARDED_HEADERS: 'true', // Only the approved Gateway reaches this ClusterIP edge.
      },
    };
    if (this.operation.developerOverlapProfile && this.overlapProfilePrepared)
      this.providerValues = applyOverlapQualificationProfile(
        this.providerValues,
        this.operation.developerOverlapProfile,
      );
    const continuity =
      manifest === this.operation.candidate
        ? this.operation.requestContinuityProfile
        : requestContinuityProfile(envelope);
    if (continuity) {
      this.providerValues.requestContinuity = {
        enabled: true,
        maxProtectedRequestSeconds: continuity.maxProtectedRequestSeconds,
        backendServiceDrainSeconds: continuity.backendServiceDrainSeconds,
        propagationSeconds: continuity.propagationSeconds,
        routeName: 'qualification',
        backendPolicyName: 'qualification',
        gatewayName: this.settings.gatewayName,
        gcpProject: this.settings.projectId,
        gcpRegion: this.settings.region,
      };
      this.providerValues.lifecycle.proxy = {
        preStopDelaySeconds: continuity.proxyPreStopDelaySeconds,
        terminationGracePeriodSeconds: continuity.proxyTerminationGracePeriodSeconds,
      };
    }
    this.providerValues.ha.controlPlane.mode = this.overlap ? 'singleton-overlap' : 'singleton';
    return this.providerValues;
  }
  async verifyDeveloperAcceptance(pod) {
    const source = await fs.readFile(
      path.join(root, 'deploy/studio-server/scripts/fixtures/ha-developer-acceptance.mjs'),
      'utf8',
    );
    const result = await this.kube(
      ['exec', '-i', pod.name, '-c', 'backend', '--', 'node', '--input-type=module', '-', pod.uid, pod.incarnation],
      { input: source },
    );
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.podUid, pod.uid);
    assert.ok(pod.incarnation);
    assert.equal(receipt.incarnation, pod.incarnation);
    assert.equal(receipt.developerApi, true);
    assert.equal(receipt.editorSession, true);
    return receipt;
  }
  async apply(values, label = 'provider-values.json') {
    await this.assertProofContext();
    return super.apply(values, label);
  }
  async roll(images, singleton = true, probes = {}) {
    assert.equal(singleton, true);
    const values = this.values(images);
    if (probes.ownerPoolTransition)
      values.workflowSchema = { ...values.workflowSchema, migrationJob: { enabled: false } };
    const resources = await this.resources(values, `roll-${Date.now()}`);
    if (this.operation.qualification?.tier === 'focused' && this.continuityProbes)
      this.continuityProbes.proxyTemplate = resources.find(
        (r) => r.kind === 'Deployment' && r.metadata.name === `${this.config.release}-proxy`,
      ).spec.template;
    const target = [this.operation.previous, this.operation.candidate].find((m) => isDeepStrictEqual(m.images, images));
    const { artifact: observeArtifact, ...rolloutProbes } = probes;
    const result = await this.runRollout({
      safety: this.deploymentSafety('rolling', imageDigest(target)),
      kube: (...args) => this.kube(...args),
      namespace: this.config.namespace,
      release: this.config.release,
      manifestDigest: imageDigest(target),
      previousManifestDigest: imageDigest(this.currentManifest),
      resources,
      ...rolloutProbes,
      createProxyContinuity: (args) =>
        createKubernetesProxyContinuity({
          ...args,
          observeBackend: createComputeBackendObserver(args.config.network, { accessToken: stagingAccessToken }),
        }),
      timeoutMs: this.operation.requestContinuityProfile
        ? continuityTimeoutMs(this.operation.requestContinuityProfile)
        : 1200000,
      artifact: async (...args) => {
        // The adapter owns persistence. The observer must run after the exact
        // journal is saved, and its failure must stop the qualification.
        await this.artifact(...args);
        if (args[0] === 'ha-rollout.json' && this.operation.requestContinuityProfile) {
          const record = JSON.parse(args[1]),
            continuity = record.proxyContinuity;
          await this.continuityProbes?.observeJournal(record);
          if (continuity?.phase === 'bridge-serving' && !this.continuityInventoryRecorded) {
            await observeStagingInventory(this.state, stagingCloudReader(this.settings));
            this.continuityInventoryRecorded = true;
          }
          if (continuity?.phase === 'cleanup' && !this.continuityInventoryRetiring) {
            const service = JSON.parse((await this.kube(['get', 'service', continuity.name, '-o', 'json'])).stdout);
            assert.equal(service.metadata.uid, continuity.entries.find((e) => e.desired.kind === 'Service').uid);
            const status = JSON.parse(service.metadata.annotations['cloud.google.com/neg-status']);
            const paths = status.zones.flatMap((zone) =>
              Object.values(status.network_endpoint_groups).map(
                (name) => `projects/${this.settings.projectId}/zones/${zone}/networkEndpointGroups/${name}`,
              ),
            );
            await this.state.change((r) => {
              r.retiringNegIds = [
                ...new Set([
                  ...(r.retiringNegIds ?? []),
                  ...r.inventory.filter((i) => i.kind === 'neg' && paths.includes(i.resource)).map((i) => i.id),
                ]),
              ];
            });
            this.continuityInventoryRetiring = true;
          }
        }
        await observeArtifact?.(...args);
      },
      applyTemplates: (_work, guards) =>
        this.apply(
          mergeRuntimeControlGuards(mergeRuntimeControlGuards(values, haRolloutAutoscalingValues(resources)), guards),
          'provider-roll-template.json',
        ),
      restoreAutoscalers: (_work, guards) =>
        this.apply(
          {
            ...mergeRuntimeControlGuards(values, guards),
            workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } },
          },
          'provider-roll-final.json',
        ),
    });
    this.currentManifest = target;
    return result;
  }
  async assertAutoscalerActive(after) {
    let result;
    await until('fresh live controller observation', async () => {
      const record = JSON.parse(
        JSON.parse((await this.kube(['get', 'configmap', this.journalName, '-o', 'json'])).stdout).data.record,
      );
      if (
        record.phase !== 'complete' ||
        record.leaseExpiresAt > Date.now() ||
        !Number.isFinite(record.lastSampleAt) ||
        record.lastSampleAt < after
      )
        return false;
      assert.equal(record.manifestDigest, imageDigest(this.currentManifest));
      assert.equal(record.policyDigest, this.operation.policyDigest);
      result = { sampleAt: record.lastSampleAt, policyDigest: record.policyDigest };
      return true;
    });
    return result;
  }
  async installDependencies() {
    await this.assertProofContext();
    if (this.settings.registrySecret) {
      const source = await this.state.api.json(
        'GET',
        `/api/v1/namespaces/${this.settings.runnerNamespace}/secrets/${this.settings.registrySecret.name}`,
      );
      assert.equal(source?.metadata.uid, this.settings.registrySecret.uid);
      assert.equal(source.type, 'kubernetes.io/dockerconfigjson');
      assert.deepEqual(Object.keys(source.data), ['.dockerconfigjson']);
      await this.kube(['create', '-f', '-'], {
        input: JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'rivet-release-gate-registry', namespace: this.config.namespace },
          type: source.type,
          data: source.data,
        }),
      });
    }
    const secret = () => randomBytes(36).toString('base64url');
    this.secrets = {
      postgresPassword: secret(),
      objectStorageAccessKey: 'release-gate',
      objectStorageSecretKey: secret(),
      settingsEncryptionKey: secret(),
      rivetKey: secret(),
    };
    await this.kube(['create', '-f', '-'], { input: renderSecrets(this.config.namespace, this.secrets) });
    const objects = parseAllDocuments(renderDependencies(this.config.namespace)).map((d) => {
      assert.equal(d.errors.length, 0);
      return d.toJS();
    });
    for (const item of objects.filter((r) => r.kind === 'Deployment')) {
      const pod = item.spec.template.spec;
      delete pod.nodeSelector;
      delete pod.tolerations;
      const pg = item.metadata.name === 'release-gate-postgres';
      pod.containers[0].image = pg ? this.settings.postgresImage : this.settings.objectStorageImage;
      if (this.settings.registrySecret) pod.imagePullSecrets = [{ name: 'rivet-release-gate-registry' }];
      if (pg)
        pod.containers[0].args = [
          'postgres',
          '-c',
          `max_connections=${this.operation.installed.qualificationValues.postgres.maxConnections}`,
        ];
      pod.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: item.metadata.name } }];
      const pvc = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: item.metadata.name, namespace: this.config.namespace },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: this.settings.storageClassName,
          resources: { requests: { storage: '2Gi' } },
        },
      };
      await this.kube(['create', '-f', '-'], { input: JSON.stringify(pvc) });
    }
    await this.kube(['create', '-f', '-'], {
      input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }),
    });
    for (const name of ['postgres', 'minio'])
      await this.kube(['rollout', 'status', `deployment/release-gate-${name}`, '--timeout=600s']);
  }
  async createPublicRoute() {
    await this.assertProofContext();
    // Create the exact chart Service before any proxy Pod. GKE must discover
    // its NEG before admission can inject readiness gates into those Pods.
    // Helm adopts only this fresh namespace's explicitly labelled Service.
    const serviceName = `${this.config.release}-proxy`;
    const service = (await this.resources(this.values(this.operation.previous.images), 'public-service')).find(
      (r) => r.kind === 'Service' && r.metadata.name === serviceName,
    );
    assert.equal(service?.spec.type, 'ClusterIP');
    service.metadata = {
      ...service.metadata,
      namespace: this.config.namespace,
      labels: { ...service.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm' },
      annotations: {
        ...service.metadata.annotations,
        'meta.helm.sh/release-name': this.config.release,
        'meta.helm.sh/release-namespace': this.config.namespace,
      },
    };
    await this.kube(['create', '-f', '-'], { input: JSON.stringify(service) });
    const metadata = { name: 'qualification', namespace: this.config.namespace };
    if (this.operation.requestContinuityProfile)
      await this.kube(['create', '-f', '-'], {
        input: JSON.stringify({
          apiVersion: 'networking.gke.io/v1',
          kind: 'GCPBackendPolicy',
          metadata,
          spec: {
            default: {
              timeoutSec: 3600,
              connectionDraining: {
                drainingTimeoutSec:
                  requestContinuityProfile(this.operation.installed.qualificationValues)?.backendServiceDrainSeconds ??
                  60,
              },
            },
            targetRef: { group: '', kind: 'Service', name: serviceName },
          },
        }),
      });
    await this.kube(['create', '-f', '-'], {
      input: JSON.stringify({
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'HTTPRoute',
        metadata,
        spec: {
          hostnames: [new URL(this.config.baseUrl).hostname],
          parentRefs: [{ name: this.settings.gatewayName, namespace: this.settings.gatewayNamespace }],
          rules: [
            {
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
              backendRefs: [{ name: `${this.config.release}-proxy`, port: 80 }],
            },
          ],
        },
      }),
    });
    await this.kube(['create', '-f', '-'], {
      input: JSON.stringify({
        apiVersion: 'networking.gke.io/v1',
        kind: 'HealthCheckPolicy',
        metadata,
        spec: {
          default: {
            config: {
              type: 'HTTP',
              httpHealthCheck: { portSpecification: 'USE_SERVING_PORT', requestPath: '/readyz' },
            },
          },
          targetRef: { group: '', kind: 'Service', name: `${this.config.release}-proxy` },
        },
      }),
    });
    await until('GKE Service NEG discovery before proxy admission', async () => {
      const current = JSON.parse((await this.kube(['get', 'service', serviceName, '-o', 'json'])).stdout);
      const status = JSON.parse(current.metadata.annotations?.['cloud.google.com/neg-status'] ?? '{}');
      return status.zones?.length >= 2 && Object.keys(status.network_endpoint_groups ?? {}).length > 0;
    });
  }
  async loadWorkflowKey({ webAppSession = false } = {}) {
    const secret = JSON.parse((await this.kube(['get', 'secret', 'rivet-release-gate-auth', '-o', 'json'])).stdout);
    this.secrets = { rivetKey: Buffer.from(secret.data.RIVET_KEY, 'base64').toString('utf8') };
    const response = await fetch(`${this.config.baseUrl}/__rivet_auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: this.secrets.rivetKey }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 204);
    this.uiCookie = response.headers
      .getSetCookie()
      .find((v) => v.startsWith('rivet_ui_token='))
      ?.split(';')[0];
    assert.ok(this.uiCookie);
    await response.body?.cancel();
    if (webAppSession) {
      await this.verifyClientProvenance();
      this.publicAppCookie = await createReleaseGateWebAppOAuthSession(
        this.config.baseUrl,
        'release-gate-web-app',
        'runtime-control@example.test',
      );
    }
  }
  get probeHeaders() {
    return { authorization: `Bearer ${this.secrets.rivetKey}`, cookie: this.uiCookie };
  }
  get independenceTimeoutMs() {
    return 1200000;
  }
  get independenceScheduleDelayMs() {
    return 900000;
  }
  requestWorkflow(base, route, options = {}) {
    assert.equal(new URL(base).origin, this.config.baseUrl);
    assert.ok(route.startsWith('/') && !route.startsWith('//') && !route.includes('\\'));
    assert.equal(new URL(route, base).origin, this.config.baseUrl);
    return super.requestWorkflow(base, route, {
      ...options,
      redirect: 'manual',
      headers: {
        ...options.headers,
        cookie: [this.uiCookie, route.startsWith('/apps/') ? this.publicAppCookie : ''].filter(Boolean).join('; '),
      },
    });
  }
  async enableOAuth(base, relativePath) {
    const windowSeconds = Math.ceil(
      (Date.parse(this.operation.expiresAt) - Date.parse(this.operation.startedAt)) / 1000,
    );
    assert.ok(Number.isSafeInteger(windowSeconds) && windowSeconds > 0 && windowSeconds <= 86400);
    return super.enableOAuth(base, relativePath, {
      allowNonLocalhost: true,
      sessionTtlSeconds: Math.max(10800, windowSeconds),
    });
  }
  async frontendAvailability() {
    return waitForGkeFrontendAvailability(this);
  }
  async verifyProtectedProxyAvailability() {
    const resources = await this.resources(this.values(this.config.images), 'protected-proxy-acceptance');
    const continuity = continuityFromResources(resources);
    assert.ok(continuity, 'The isolated proxy must retain its continuity profile');
    return createKubernetesProxyContinuity({
      kube: (...args) => this.kube(...args),
      config: {
        ...continuity,
        release: this.config.release,
        namespace: this.config.namespace,
        hpaSpec: resources.find(
          (r) => r.kind === 'HorizontalPodAutoscaler' && r.spec.scaleTargetRef.name === continuity.proxyName,
        )?.spec,
      },
      timeoutMs: continuityTimeoutMs(continuity.profile),
      observeBackend: createComputeBackendObserver(continuity.network, { accessToken: stagingAccessToken }),
    }).inspect();
  }
  async readyPublic() {
    await waitForGkeFrontendAvailability(this);
    await this.loadWorkflowKey();
    await this.waitForDeveloperRoute(this.config.baseUrl);
    await this.verifyClientProvenance();
  }
  async verifyClientProvenance() {
    const observed = await this.requestWorkflow(
      this.config.baseUrl,
      '/api/app-settings/trusted-clients/current-request',
    );
    let allowed = false;
    try {
      const address = ipaddr.process(observed.clientAddress);
      allowed = this.settings.trustedClients.some((network) => {
        const [range, prefix] = network.includes('/')
          ? ipaddr.parseCIDR(network)
          : [ipaddr.process(network), ipaddr.process(network).kind() === 'ipv4' ? 32 : 128];
        return address.kind() === range.kind() && address.match(range, prefix);
      });
    } catch {
      /* Invalid or unavailable provenance never authorizes test login. */
    }
    assert.ok(
      allowed,
      'Staging forwarding did not resolve an allowed public test client; check proxy subnet, frontend hop and NAT allowlist before OAuth',
    );
    return { verifiedPublicTestClient: true };
  }
  async verifyPublishedBrowser(base) {
    await run(
      process.execPath,
      [
        path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
        'studio-server:ui:observe',
        'runtime-control-independence.spec.ts',
        ...(this.continuityProbes ? ['web-app-accepted-resume.spec.ts'] : []),
      ],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: '1',
          PLAYWRIGHT_SLOW_MO: '0',
          PLAYWRIGHT_BASE_URL: base,
          RIVET_RUNTIME_PROVIDER_FIXTURE: '1',
          RIVET_RUNTIME_PROVIDER_ORIGIN: this.config.baseUrl,
          RIVET_QUALIFICATION_BROWSER_ARTIFACTS: path.join(this.config.artifactsDir, 'browser'),
          RIVET_RUNTIME_PROVIDER_UI_COOKIE: this.uiCookie,
          RIVET_REQUEST_CONTINUITY_FIXTURE: this.continuityProbes ? '1' : '0',
        },
        capture: true,
      },
    );
    if (this.continuityProbes) this.continuityProbes.browserResume = true;
  }
  async scaleExact(kind, name, from, to) {
    const current = JSON.parse((await this.kube(['get', kind, name, '-o', 'json'])).stdout);
    assert.equal(current.metadata.labels?.['app.kubernetes.io/instance'], this.config.release);
    assert.equal(current.spec.replicas, from);
    await this.artifact(
      `scale-${Date.now()}-intent.json`,
      JSON.stringify({ uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion, name, from, to }),
    );
    await this.kube([
      'scale',
      `${kind}/${name}`,
      `--replicas=${to}`,
      `--current-replicas=${from}`,
      `--resource-version=${current.metadata.resourceVersion}`,
    ]);
  }
  async close() {
    await this.stopPortForward();
  } // Shared cluster is never a fixture reset target.
}
