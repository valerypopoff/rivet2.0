import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { createKubernetesTransport } from './execution-autoscaler-kubernetes.mjs';
import { stagingActorRole } from './reusable-staging-coordinator.mjs';
import { packageReusableStaging } from '../package-reusable-staging.mjs';
import { qualificationOperation, executeRuntimeQualification } from './runtime-qualification-execution.mjs';
import { ReusableStagingState, stagingRecordPath } from './reusable-staging-state.mjs';
import { stagingCloudReader } from './reusable-staging-cloud.mjs';
import { stopExpiredStagingWriter, verifyStagingCleanup } from './reusable-staging-cleanup.mjs';
import {
  immutable,
  temporaryAdmission,
  temporaryHash,
  verifyTemporaryCertificate,
  temporaryHostname,
  assertTemporaryCertificate,
} from './temporary-staging-contract.mjs';
import { temporaryFoundationSpecs, assertTemporaryClusterNodeIdentity } from './temporary-staging-gcp.mjs';
import { inspectStagingPrerequisites } from './reusable-staging-prerequisites.mjs';
import { captureTemporaryBootstrap } from './temporary-staging-inventory.mjs';
import { inspectTemporaryActorNodeIdentity } from './temporary-staging-node-identity.mjs';
import { verifyOfflineTemporaryActor, verifyTemporaryActorExport } from './temporary-staging-actor.mjs';
import {
  verifyAnonymousStagingImage,
  stagingRegistryConfig,
  verifyPrivateStagingImages,
} from './temporary-staging-images.mjs';
import {
  issueTemporaryCertificate,
  settleTemporaryCertificate,
  verifyTemporaryChallenge,
  transientTemporaryChallengeError,
} from './temporary-staging-certificate.mjs';

const exec = promisify(execFile);
const ns = (name) => `/api/v1/namespaces/${name}`;
const actorFile = 'deploy/studio-server/scripts/qualification/temporary-actor.mjs';
const ready = (p) =>
  p?.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') && !p.metadata.deletionTimestamp;
const write = (file, value) => fs.writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });

/** Concrete bootstrap/transport only. The existing inner fixture still owns
 * application settlement; it is never given cluster/network delete authority. */
export function temporaryStagingRuntime({
  root,
  certificateFile,
  keyFile,
  estimateFile,
  registryFile,
  inputs,
  signal,
  refreshInstalled,
  verifyPrerequisites = inspectStagingPrerequisites,
  certificateIssuer = issueTemporaryCertificate,
  certificateSettlement = settleTemporaryCertificate,
  verifyPublicChallenge = verifyTemporaryChallenge,
  diagnosticDirectory,
}) {
  inputs = immutable(inputs);
  const requiredImages = (plan) => [
    ...new Set([
      plan.actorImage,
      plan.postgresImage,
      plan.objectStorageImage,
      ...(plan.acme ? [plan.acme.image] : []),
      ...[inputs.previous, inputs.candidate].flatMap((m) =>
        Object.values(m.images).map((i) => `${i.repository}@${i.digest}`),
      ),
    ]),
  ];
  let api,
    settings,
    operation,
    checkpoint = async () => {};
  const hydrate = async (store, cloud, timeoutMs = 15000) => {
    const { record } = await store.read(),
      cluster = record.resources.find((r) => r.key === 'cluster');
    assert.ok(cluster?.identity && !cluster.absent);
    const spec = temporaryFoundationSpecs(record.plan).find((s) => s.key === 'cluster');
    assert.equal(cloud.identity(spec, await cloud.get(spec)).id, cluster.identity.id);
    const WebSocketClass = createRequire(path.join(root, 'packages/studio-server-api/package.json'))('ws');
    const transport = async (deadline) => {
      const token = await cloud.credentials();
      return createKubernetesTransport({
        origin: `https://${cluster.identity.endpoint}/`,
        token: () => token,
        ca: () => Buffer.from(cluster.identity.ca, 'base64'),
        timeoutMs: deadline,
        WebSocketClass,
      });
    };
    api = {
      json: async (...args) => (await transport(15000)).json(...args),
      exec: async (...args) => (await transport(timeoutMs)).exec(...args),
    };
    if (record.identities?.clusterUid)
      assert.equal((await api.json('GET', ns('kube-system')))?.metadata.uid, record.identities.clusterUid);
    settings = record.settings;
    operation = record.operation;
    return record;
  };
  const created = async (store, key, collection, body) => {
    let { record } = await store.read();
    const apiPath = `${collection}/${body.metadata.name}`;
    temporaryAdmission(record);
    await checkpoint();
    assert.ok(!signal?.aborted);
    assert.ok(!record.resources.some((r) => r.key === key), 'Never repeat a Kubernetes create');
    assert.equal(await api.json('GET', apiPath), null);
    const nonce = randomUUID();
    body = structuredClone(body);
    body.metadata.annotations = {
      ...body.metadata.annotations,
      'rivet.dev/temporary-input': record.plan.inputHash,
      'rivet.dev/temporary-nonce': nonce,
    };
    await store.change((r) => {
      r.resources.push({
        key,
        kind: 'kubernetes',
        billable: ['Pod', 'Deployment', 'StatefulSet', 'Job'].includes(body.kind),
        apiPath,
        nonce,
        bodyHash: temporaryHash(body),
        createIssued: true,
      });
    });
    const result = await api.json('POST', collection, body);
    assert.ok(result.metadata.uid);
    await store.change((r) => {
      r.resources.find((i) => i.key === key).identity = { id: result.metadata.uid, name: result.metadata.name };
    });
    return result;
  };
  const reconcile = async (store, item) => {
    const value = await api.json('GET', item.apiPath);
    if (!value) {
      assert.ok(item.identity && item.deleteIssued, 'Unknown Kubernetes create cannot be assumed absent');
      return null;
    }
    assert.equal(value.metadata.annotations?.['rivet.dev/temporary-input'], (await store.read()).record.plan.inputHash);
    assert.equal(value.metadata.annotations?.['rivet.dev/temporary-nonce'], item.nonce);
    if (item.identity) assert.equal(value.metadata.uid, item.identity.id, 'Kubernetes incarnation changed');
    else
      await store.change((r) => {
        r.resources.find((i) => i.key === item.key).identity = { id: value.metadata.uid, name: value.metadata.name };
      });
    return value;
  };
  const captureEdge = async (store, cloud, item) => {
    const gateway = await reconcile(store, item);
    if (!gateway) return;
    const { record } = await store.read();
    const spec = temporaryFoundationSpecs(record.plan).find((s) => s.key === 'address');
    const address = await cloud.get(spec);
    assert.equal(String(address.id), record.resources.find((i) => i.key === 'address').identity.id);
    assert.equal(gateway.spec.addresses[0].value, address.name);
    const children = await cloud.edgeChildren(address.address);
    const baseline = new Set(record.baseline.map((i) => i.id));
    assert.ok(
      children.every((i) => !baseline.has(i.id)),
      'A pre-existing edge child is not cleanup-owned',
    );
    await store.change((r) => {
      r.edgeChildren ??= [];
      for (const child of children) {
        const prior = r.edgeChildren.find((i) => i.resource === child.resource);
        if (prior) assert.equal(prior.id, child.id);
        else r.edgeChildren.push(child);
      }
    });
  };
  const snapshotBootstrap = async (store) => {
    let children;
    try {
      children = await captureTemporaryBootstrap(api, (await store.read()).record);
    } catch (error) {
      if (error.resources)
        await store.change((r) => {
          r.blockedInventory = error.resources;
        });
      throw error;
    }
    await store.change((r) => {
      r.blockedInventory = [];
      r.bootstrapChildren ??= [];
      for (const child of children)
        if (!r.bootstrapChildren.some((i) => i.uid === child.uid && i.apiPath === child.apiPath))
          r.bootstrapChildren.push(child);
    });
  };
  const remove = async (store, item, wait) => {
    const value = await reconcile(store, item);
    if (!value) return;
    if (item.apiPath.startsWith('/api/v1/namespaces/') && item.apiPath.split('/').length === 5) {
      await snapshotBootstrap(store);
    }
    if (!item.deleteIssued) {
      await store.change((r) => {
        r.resources.find((i) => i.key === item.key).deleteIssued = true;
      });
      await api.json('DELETE', item.apiPath, {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        propagationPolicy: 'Foreground',
        preconditions: { uid: value.metadata.uid, resourceVersion: value.metadata.resourceVersion },
      });
    } else
      assert.ok(value.metadata.deletionTimestamp, 'Unacknowledged Kubernetes deletion requires inspection, not replay');
    await wait('exact bootstrap absence', async () => {
      const v = await api.json('GET', item.apiPath);
      if (!v) return true;
      assert.equal(v.metadata.uid, value.metadata.uid);
      return false;
    });
    await store.change((r) => {
      r.resources.find((i) => i.key === item.key).absent = true;
    });
  };
  const actor = async (
    store,
    cloud,
    command,
    packet,
    { timeoutMs = 1800000, maxOutputBytes = 4 * 1024 * 1024 } = {},
  ) => {
    const record = await hydrate(store, cloud, timeoutMs),
      item = record.resources.find((r) => r.key === 'actor');
    const pod = await reconcile(store, item);
    assert.ok(ready(pod), 'Exact actor is not ready');
    if (record.actorNodeIdentity) {
      const node = await api.json('GET', `/api/v1/nodes/${pod.spec.nodeName}`);
      await inspectTemporaryActorNodeIdentity(record, cloud, pod, node, record.actorNodeIdentity);
    }
    const diagnostics = [];
    let bytes = 0,
      primaryError;
    try {
      return JSON.parse(
        await api.exec(`${item.apiPath}/exec`, command, {
          container: 'actor',
          stdin: Buffer.from(JSON.stringify(packet)),
          maxOutputBytes,
          onStderr: (chunk) => {
            if ((bytes += chunk.length) <= 1024 * 1024) diagnostics.push(chunk);
          },
        }),
      );
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        const file = `remote-${randomUUID()}.log`;
        await fs.writeFile(path.join(store.directory, file), Buffer.concat(diagnostics), { flag: 'wx', mode: 0o600 });
        await store.change((r) => {
          r.remoteDiagnostics ??= [];
          r.remoteDiagnostics.push({ file, command, bytes, truncated: bytes > 1024 * 1024 });
        });
      } catch (error) {
        if (primaryError)
          throw new AggregateError([primaryError, error], 'Remote phase and private diagnostic persistence failed');
        throw error;
      }
    }
  };
  const phaseDriver = (store, cloud) =>
    Object.fromEntries(
      ['armExpiry', 'prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup'].map((phase) => [
        phase,
        async (op) => {
          let record = (await store.read()).record;
          if (['armExpiry', 'prepare', 'upgrade', 'autoscaling'].includes(phase)) {
            await checkpoint();
            // Preparation may have consumed the window checked at bootstrap.
            // Recheck the reserved drain/export time before each new test phase.
            temporaryAdmission(record, { tests: true });
            assert.ok(!signal?.aborted);
          }
          // The outer record is durable before remote exec. Missing acknowledgement
          // does not authorize a second exec of the same phase.
          assert.ok(!record.remotePhases?.[phase]);
          await store.change((r) => {
            r.remotePhases ??= {};
            r.remotePhases[phase] = { issued: true };
          });
          const result = await actor(
            store,
            cloud,
            ['node', `/qualification/private/${op.operationId}/provider.mjs`, phase],
            { operation: op, privateDirectory: `/qualification/private/${op.operationId}/results` },
            {
              timeoutMs: ['armExpiry', 'prepare', 'upgrade', 'autoscaling'].includes(phase)
                ? Math.max(1, Math.min(7200000, Date.parse(op.expiresAt) - Date.now()))
                : 3600000,
            },
          );
          await store.change((r) => {
            r.remotePhases[phase].receipt = result;
          });
          return result;
        },
      ]),
    );
  return {
    async offlinePreflight(plan) {
      assert.equal(
        temporaryHash(await fs.readFile(estimateFile)),
        plan.estimate.evidenceSha256,
        'Reviewed itemized estimate changed or is missing',
      );
      if (!plan.hostnameMode)
        verifyTemporaryCertificate(plan, await fs.readFile(certificateFile), await fs.readFile(keyFile));
      assert.equal(inputs.candidate.source.sha, plan.sourceSha);
      const { getStudioServerReleaseManifestDigest } = await import('./studio-server-release-manifest.mjs');
      assert.equal(getStudioServerReleaseManifestDigest(inputs.candidate), plan.candidateDigest);
      assert.equal(
        getStudioServerReleaseManifestDigest(inputs.previous, { requirePromoted: true }),
        plan.predecessorDigest,
      );
      // Validate the complete release/installation/profile combination before
      // creating even the foundation, not only after a paid cluster is ready.
      qualificationOperation({
        ...inputs,
        operationId: plan.operationId,
        approval: {
          enabled: true,
          projectId: plan.projectId,
          projectNumber: plan.projectNumber,
          maxUsd: plan.allowance.maxUsd,
          maxSeconds: plan.allowance.maxSeconds,
          driverBundleSha256: '0'.repeat(64),
          developerOverlapProfile: inputs.developerOverlapProfile,
          requestContinuityProfile: inputs.requestContinuityProfile,
          staging: {
            mode: 'reusable-cluster',
            clusterUid: 'uncreated-temporary-cluster',
            gatewayUid: 'uncreated-temporary-gateway',
            clusterServer: 'https://uncreated.invalid/',
          },
        },
      });
      const images = requiredImages(plan);
      if (plan.registrySecretSha256)
        await verifyPrivateStagingImages(await stagingRegistryConfig(plan, registryFile, images), images, exec);
      else for (const image of images) await verifyAnonymousStagingImage(image);
      await exec('docker', ['image', 'inspect', plan.actorImage], { timeout: 15000, maxBuffer: 65536 });
      await verifyOfflineTemporaryActor(
        plan,
        diagnosticDirectory
          ? { diagnosticFile: path.join(diagnosticDirectory, `actor-preflight-${randomUUID()}.private.json`) }
          : {},
      );
      if (plan.acme) {
        await exec('docker', ['image', 'inspect', plan.acme.image], { timeout: 15000, maxBuffer: 65536 });
        await exec('docker', ['run', '--rm', '--pull=never', '--network=none', plan.acme.image, '--version'], {
          timeout: 30000,
          maxBuffer: 65536,
        });
      }
    },
    async bootstrap(store, cloud, { wait, guard }) {
      checkpoint = guard;
      let record = await hydrate(store, cloud),
        plan = record.plan;
      const clusterSpec = temporaryFoundationSpecs(plan).find((spec) => spec.key === 'cluster');
      const liveCluster = await cloud.get(clusterSpec);
      assert.equal(
        cloud.identity(clusterSpec, liveCluster).id,
        record.resources.find((item) => item.key === 'cluster').identity.id,
      );
      assertTemporaryClusterNodeIdentity(plan, liveCluster);
      const clusterUid = (await api.json('GET', ns('kube-system'))).metadata.uid;
      const kubernetesService = await api.json('GET', '/api/v1/namespaces/default/services/kubernetes');
      assert.ok(kubernetesService?.metadata.uid);
      const ip = (value) => value.split('.').reduce((n, p) => n * 256 + Number(p), 0);
      const [network, mask] = plan.cidrs.services.split('/'),
        first = ip(network),
        addressNumber = ip(kubernetesService.spec.clusterIP);
      assert.ok(
        addressNumber > first && addressNumber < first + 2 ** (32 - Number(mask)) - 1,
        'Kubernetes service address is outside the approved cluster range',
      );
      await store.change((r) => {
        r.identities = { clusterUid };
      });
      const control = `${plan.operationId}-ctl`,
        runner = `${plan.operationId}-actor`,
        edge = `${plan.operationId}-edge`;
      for (const name of [control, runner, edge])
        await created(store, `ns-${name}`, '/api/v1/namespaces', {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name,
            ...(plan.hostnameMode && name === edge ? { labels: { 'rivet.dev/qualification-route': 'true' } } : {}),
          },
        });
      let challengePull;
      if (plan.hostnameMode && plan.registrySecretSha256) {
        const bytes = await stagingRegistryConfig(plan, registryFile, requiredImages(plan));
        challengePull = await created(store, 'challenge-pull', `${ns(edge)}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'rivet-qualification-pull', namespace: edge },
          type: 'kubernetes.io/dockerconfigjson',
          data: { '.dockerconfigjson': bytes.toString('base64') },
        });
      }
      const accountId = record.accounts.find((a) => a.email === plan.janitorServiceAccount).id;
      for (const [namespace, name] of [
        [control, 'rivet-qualification-janitor'],
        [runner, 'rivet-qualification-actor'],
      ]) {
        const member = `serviceAccount:${plan.projectId}.svc.id.goog[${namespace}/${name}]`;
        assert.equal(await cloud.readBinding(member, accountId), false, 'Reserved staging IAM member already exists');
        await guard();
        await cloud.project();
        await store.change((r) => {
          r.iam ??= [];
          r.iam.push({ member, accountId, preexisting: false, addIssued: true });
        });
        await cloud.iamBinding(member, false, accountId);
        await store.change((r) => {
          r.iam.find((i) => i.member === member).added = true;
        });
      }
      const address = await cloud.get(temporaryFoundationSpecs(plan).find((s) => s.key === 'address'));
      assert.equal(String(address.id), record.resources.find((r) => r.key === 'address').identity.id);
      const hostname = temporaryHostname(plan, address.address);
      let certificate, key;
      const httpsListener = {
        name: 'https',
        hostname,
        port: 443,
        protocol: 'HTTPS',
        tls: { mode: 'Terminate', certificateRefs: [{ name: 'qualification-tls' }] },
        allowedRoutes: {
          namespaces: { from: 'Selector', selector: { matchLabels: { 'rivet.dev/qualification-route': 'true' } } },
        },
      };
      if (!plan.hostnameMode) {
        certificate = await fs.readFile(certificateFile);
        key = await fs.readFile(keyFile);
        verifyTemporaryCertificate(plan, certificate, key);
        await created(store, 'tls', `${ns(edge)}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'qualification-tls', namespace: edge },
          type: 'kubernetes.io/tls',
          data: {
            'tls.crt': certificate.toString('base64'),
            'tls.key': key.toString('base64'),
          },
        });
        const rrset = { name: `${plan.operationId}.${plan.domain}.`, type: 'A', ttl: 60, rrdatas: [address.address] };
        assert.equal((await cloud.readDns(rrset.name)).length, 0);
        await guard();
        await cloud.project();
        await store.change((r) => {
          r.dns = { rrset, addIssued: true };
        });
        await cloud.dnsRecord(rrset);
        await store.change((r) => {
          r.dns.added = true;
        });
      } else
        await store.change((r) => {
          r.hostname = { name: hostname, address: address.address, addressId: String(address.id) };
        });
      const gateway = await created(
        store,
        'gateway',
        `/apis/gateway.networking.k8s.io/v1/namespaces/${edge}/gateways`,
        {
          apiVersion: 'gateway.networking.k8s.io/v1',
          kind: 'Gateway',
          metadata: { name: 'qualification', namespace: edge },
          spec: {
            gatewayClassName: 'gke-l7-regional-external-managed',
            addresses: [{ type: 'NamedAddress', value: address.name }],
            listeners: [
              plan.hostnameMode
                ? {
                    name: 'http',
                    hostname,
                    port: 80,
                    protocol: 'HTTP',
                    allowedRoutes: { namespaces: { from: 'Same' } },
                  }
                : httpsListener,
            ],
          },
        },
      );
      if (plan.hostnameMode) {
        const label = { 'rivet.dev/acme': plan.operationId },
          probe = { token: randomBytes(24).toString('base64url'), validation: randomBytes(32).toString('base64url') };
        await created(store, 'acme-config', `${ns(edge)}/configmaps`, {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'qualification-acme', namespace: edge },
          data: { 'challenge.json': JSON.stringify(probe) },
        });
        await created(store, 'acme-service', `${ns(edge)}/services`, {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'qualification-acme', namespace: edge },
          spec: { selector: label, ports: [{ port: 8080, targetPort: 8080 }] },
        });
        await created(store, 'acme-health', `/apis/networking.gke.io/v1/namespaces/${edge}/healthcheckpolicies`, {
          apiVersion: 'networking.gke.io/v1',
          kind: 'HealthCheckPolicy',
          metadata: { name: 'qualification-acme', namespace: edge },
          spec: {
            default: {
              config: {
                type: 'HTTP',
                httpHealthCheck: { portSpecification: 'USE_SERVING_PORT', requestPath: '/health' },
              },
            },
            targetRef: { group: '', kind: 'Service', name: 'qualification-acme' },
          },
        });
        await created(store, 'acme-pod', `${ns(edge)}/pods`, {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'qualification-acme', namespace: edge, labels: label },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: 'Never',
            ...(challengePull ? { imagePullSecrets: [{ name: challengePull.metadata.name }] } : {}),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'challenge',
                image: plan.actorImage,
                command: ['node', '/app/deploy/studio-server/scripts/qualification/temporary-acme-server.mjs'],
                ports: [{ containerPort: 8080 }],
                resources: { requests: { cpu: '250m', memory: '512Mi' } },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                readinessProbe: { httpGet: { path: '/health', port: 8080 } },
                volumeMounts: [{ name: 'challenge', mountPath: '/acme', readOnly: true }],
              },
            ],
            volumes: [{ name: 'challenge', configMap: { name: 'qualification-acme' } }],
          },
        });
        await created(store, 'acme-route', `/apis/gateway.networking.k8s.io/v1/namespaces/${edge}/httproutes`, {
          apiVersion: 'gateway.networking.k8s.io/v1',
          kind: 'HTTPRoute',
          metadata: { name: 'qualification-acme', namespace: edge },
          spec: {
            parentRefs: [{ name: 'qualification', sectionName: 'http' }],
            hostnames: [hostname],
            rules: [
              {
                matches: [{ path: { type: 'PathPrefix', value: '/.well-known/acme-challenge/' } }],
                backendRefs: [{ name: 'qualification-acme', port: 8080 }],
              },
            ],
          },
        });
        const verifyChallenge = async (packet) => {
          await wait('owned public HTTP challenge response', async () => {
            await guard(plan);
            try {
              return await verifyPublicChallenge({ hostname, address: address.address, ...packet });
            } catch (e) {
              if (transientTemporaryChallengeError(e)) return false;
              throw e;
            }
          });
        };
        const patchOnce = async (resourceKey, intent, operations) => {
          const item = (await store.read()).record.resources.find((r) => r.key === resourceKey);
          assert.ok(!item[intent], 'Never replay an unacknowledged bootstrap patch');
          const live = await reconcile(store, item);
          assert.ok(live);
          await guard(plan);
          await store.change((r) => {
            r.resources.find((x) => x.key === resourceKey)[intent] = {
              uid: live.metadata.uid,
              resourceVersion: live.metadata.resourceVersion,
              operationsHash: temporaryHash(operations),
            };
          });
          const patched = await api.json(
            'PATCH',
            item.apiPath,
            [
              { op: 'test', path: '/metadata/uid', value: live.metadata.uid },
              { op: 'test', path: '/metadata/resourceVersion', value: live.metadata.resourceVersion },
              ...operations,
            ],
            'application/json-patch+json',
          );
          assert.equal(patched.metadata.uid, live.metadata.uid);
        };
        await verifyChallenge(probe);
        ({ certificate, key } = await certificateIssuer(store, {
          hostname,
          wait,
          guard: () => guard(plan),
          publishChallenge: async (packet) => {
            await patchOnce('acme-config', 'challengePublishIssued', [
              { op: 'replace', path: '/data/challenge.json', value: JSON.stringify(packet) },
            ]);
            await verifyChallenge(packet);
          },
        }));
        assertTemporaryCertificate(hostname, plan.allowance.maxSeconds, certificate, key);
        await store.change((r) => {
          r.tlsMaterial = {
            hostname,
            certificateSha256: temporaryHash(certificate),
            privateKeySha256: temporaryHash(key),
          };
        });
        await created(store, 'tls', `${ns(edge)}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'qualification-tls', namespace: edge },
          type: 'kubernetes.io/tls',
          data: { 'tls.crt': certificate.toString('base64'), 'tls.key': key.toString('base64') },
        });
        // Retain the HTTP listener's exact cloud children before its replacement
        // can detach them. Final cleanup also observes the HTTPS children.
        await captureEdge(
          store,
          cloud,
          (await store.read()).record.resources.find((i) => i.key === 'gateway'),
        );
        await patchOnce('gateway', 'httpsInstallIssued', [
          { op: 'replace', path: '/spec/listeners', value: [httpsListener] },
        ]);
        for (const name of ['acme-route', 'acme-health', 'acme-service', 'acme-pod', 'acme-config'])
          await remove(
            store,
            (await store.read()).record.resources.find((r) => r.key === name),
            wait,
          );
      }
      settings = {
        protocol: 1,
        mode: 'reusable-cluster',
        projectId: plan.projectId,
        projectNumber: plan.projectNumber,
        clusterUid,
        clusterServer: `https://${record.resources.find((i) => i.key === 'cluster').identity.endpoint}/`,
        inClusterServer: `https://${kubernetesService.spec.clusterIP}/`,
        kubernetesServiceUid: kubernetesService.metadata.uid,
        context: 'qualification',
        controlNamespace: control,
        runnerNamespace: runner,
        gatewayNamespace: edge,
        gatewayName: 'qualification',
        gatewayUid: gateway.metadata.uid,
        domain: hostname.slice(plan.operationId.length + 1),
        trustedClients: plan.trustedClients,
        postgresImage: plan.postgresImage,
        objectStorageImage: plan.objectStorageImage,
        storageClassName: 'standard-rwo',
        ...(inputs.developerOverlapProfile ? { developerOverlapProfile: inputs.developerOverlapProfile } : {}),
        ...(inputs.requestContinuityProfile ? { requestContinuityProfile: inputs.requestContinuityProfile } : {}),
        ...(inputs.requestContinuityProfile ? { region: plan.region } : {}),
      };
      if (plan.registrySecretSha256) {
        const bytes = await stagingRegistryConfig(plan, registryFile, requiredImages(plan)),
          name = 'rivet-qualification-pull';
        const secret = (namespace) => ({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name, namespace },
          type: 'kubernetes.io/dockerconfigjson',
          data: { '.dockerconfigjson': bytes.toString('base64') },
        });
        const pull = await created(store, 'actor-pull', `${ns(runner)}/secrets`, secret(runner));
        const janitorPull = await created(store, 'janitor-pull', `${ns(control)}/secrets`, secret(control));
        settings.registrySecret = { name, uid: pull.metadata.uid };
        settings.janitorRegistrySecret = { name, uid: janitorPull.metadata.uid };
      }
      await created(store, 'actor-account', `${ns(runner)}/serviceaccounts`, {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: 'rivet-qualification-actor',
          namespace: runner,
          annotations: { 'iam.gke.io/gcp-service-account': plan.janitorServiceAccount },
        },
      });
      const role = stagingActorRole(`${plan.operationId}-actor`);
      await created(store, 'actor-role', '/apis/rbac.authorization.k8s.io/v1/clusterroles', role);
      await created(store, 'actor-binding', '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', {
        apiVersion: role.apiVersion,
        kind: 'ClusterRoleBinding',
        metadata: { name: role.metadata.name },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role.metadata.name },
        subjects: [{ kind: 'ServiceAccount', namespace: runner, name: 'rivet-qualification-actor' }],
      });
      await created(store, 'actor', `${ns(runner)}/pods`, {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          annotations: { 'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false' },
          name: 'qualification-actor',
          namespace: runner,
          labels: { 'rivet.dev/qualification-runner': 'true' },
        },
        spec: {
          serviceAccountName: 'rivet-qualification-actor',
          ...(settings.registrySecret ? { imagePullSecrets: [{ name: settings.registrySecret.name }] } : {}),
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 120,
          securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
          containers: [
            {
              name: 'actor',
              image: plan.actorImage,
              command: ['node', '-e', 'setInterval(()=>{},1000)'],
              workingDir: plan.actorSourceRoot,
              env: [
                { name: 'RIVET_QUALIFICATION_SOURCE_ROOT', value: plan.actorSourceRoot },
                { name: 'KUBECONFIG', value: `/qualification/private/${plan.operationId}/kubeconfig.json` },
                ...['NAME', 'UID'].map((k) => ({
                  name: `POD_${k}`,
                  valueFrom: { fieldRef: { fieldPath: `metadata.${k.toLowerCase()}` } },
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
      });
      await wait('actor Ready', async () => {
        await guard(plan);
        return ready(await api.json('GET', `${ns(runner)}/pods/qualification-actor`));
      });
      const actorPod = await api.json('GET', `${ns(runner)}/pods/qualification-actor`);
      const node = await api.json('GET', `/api/v1/nodes/${actorPod.spec.nodeName}`);
      const actorNodeIdentity = await inspectTemporaryActorNodeIdentity(
        (await store.read()).record,
        cloud,
        actorPod,
        node,
      );
      settings.trustedClients = [...new Set([...settings.trustedClients, `${actorNodeIdentity.egressIp}/32`])];
      await store.change((r) => {
        r.actorNodeIdentity = actorNodeIdentity;
      });
      const output = path.join(store.directory, 'package');
      const { driverDigest } = await packageReusableStaging({
        settings,
        output,
        janitorImage: plan.actorImage,
        googleServiceAccount: plan.janitorServiceAccount,
      });
      const objects = parseDocuments(await fs.readFile(path.join(output, 'janitor.yaml'), 'utf8'));
      for (const [i, object] of objects.entries())
        await created(store, `janitor-${i}`, objectCollection(object), object);
      const files = {};
      for (const name of await fs.readdir(path.join(output, 'driver'))) {
        const bytes = await fs.readFile(path.join(output, 'driver', name));
        files[name] = { bytes: bytes.toString('base64'), hash: temporaryHash(bytes) };
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
        contexts: [{ name: 'qualification', context: { cluster: 'staging', user: 'actor' } }],
        'current-context': 'qualification',
      };
      const kubeBytes = Buffer.from(JSON.stringify(kubeconfig));
      files['kubeconfig.json'] = { bytes: kubeBytes.toString('base64'), hash: temporaryHash(kubeBytes) };
      await guard(plan);
      await store.change((r) => {
        r.actorInstallIssued = true;
        r.settings = settings;
        r.identities = { clusterUid, gatewayUid: gateway.metadata.uid, clusterServer: settings.clusterServer };
        r.driverDigest = driverDigest;
      });
      const installed = await actor(store, cloud, ['node', `${plan.actorSourceRoot}/${actorFile}`, 'install'], {
        operationId: plan.operationId,
        files,
      });
      assert.equal(installed.installed, true);
      assert.deepEqual(
        installed.files,
        Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value.hash])),
      );
      await wait('fresh janitor health', async () => {
        await guard(plan);
        const h = await api.json('GET', `${ns(control)}/configmaps/rivet-qualification-janitor-health`);
        await guard(plan);
        const v = JSON.parse(h?.data?.health ?? '{}');
        return v.driverDigest === driverDigest && Date.now() - v.observedAt < 60000;
      });
      record = (await store.read()).record;
      await guard(plan);
      const observedInstalled = await refreshInstalled();
      const { assertQualificationInstallationMatches } = await import('./runtime-qualification-installation.mjs');
      assertQualificationInstallationMatches(observedInstalled, inputs.installed);
      await guard(plan);
      operation = qualificationOperation({
        ...inputs,
        installed: observedInstalled,
        operationId: plan.operationId,
        approval: {
          enabled: true,
          projectId: plan.projectId,
          projectNumber: plan.projectNumber,
          maxUsd: plan.allowance.maxUsd,
          maxSeconds: plan.allowance.maxSeconds,
          driverBundleSha256: driverDigest,
          developerOverlapProfile: settings.developerOverlapProfile,
          requestContinuityProfile: settings.requestContinuityProfile,
          staging: { mode: 'reusable-cluster', ...record.identities },
          temporaryEnvironment: {
            inputHash: plan.inputHash,
            startedAt: record.firstBillableIntentAt,
            expiresAt: record.expiresAt,
          },
        },
      });
      await store.change((r) => {
        r.operation = operation;
      });
      await wait('strict Gateway, TLS, storage and metrics prerequisites', async () => {
        await guard(plan);
        try {
          await verifyPrerequisites(new ReusableStagingState(api, settings, operation));
          return true;
        } catch (e) {
          if (e.code === 'ERR_ASSERTION' || e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') return false;
          throw e;
        }
      });
    },
    async qualify(store, cloud) {
      const record = await hydrate(store, cloud);
      let sequence = 0;
      return executeRuntimeQualification(
        record.operation,
        phaseDriver(store, cloud),
        (state) => write(path.join(store.directory, `fixture-${String(sequence++).padStart(3, '0')}.json`), state),
        { signal },
      );
    },
    async settleCertificate(store, { wait }) {
      await certificateSettlement(store, { wait, stop: true });
    },
    async settleAndExport(store, cloud, { wait }) {
      let record = (await store.read()).record;
      if (!record.resources.some((i) => i.key === 'cluster' && i.identity && !i.absent)) {
        assert.ok(!record.resources.some((i) => i.kind === 'kubernetes'));
        return;
      }
      record = await hydrate(store, cloud);
      for (const item of record.resources.filter((i) => i.kind === 'kubernetes' && !i.absent))
        await reconcile(store, item);
      if (!record.operation) {
        assert.ok(!record.remotePhases);
        return;
      }
      const state = new ReusableStagingState(api, settings, operation),
        object = await api.json('GET', stagingRecordPath(settings, operation.operationId));
      if (!object) {
        assert.ok(!record.remotePhases?.prepare, 'Missing admitted fixture record blocks deletion');
        return;
      }
      const fixture = JSON.parse(object.data.record);
      if (!fixture.cleanupVerified) {
        // The in-cluster janitor alone takes over unknown/busy actor work at
        // expiry. An external heartbeat cannot claim application work settled.
        assert.ok(
          Date.now() >= Date.parse(operation.expiresAt),
          'Fixture not settled; retain the environment until exact recovery/expiry',
        );
        await stopExpiredStagingWriter(state, wait);
        await wait('inner janitor settlement and cleanup', async () => {
          const value = await api.json('GET', stagingRecordPath(settings, operation.operationId));
          return value && JSON.parse(value.data.record).cleanupVerified;
        });
      }
      assert.ok(await verifyStagingCleanup(state, stagingCloudReader(settings, { token: cloud.credentials })));
      // From here work is proven settled. Missing diagnostics fail qualification,
      // but cannot alone hold safely removable infrastructure open. Journal or
      // ownership failures outside this evidence-only block still stop cleanup.
      try {
        const terminal = await api.json('GET', stagingRecordPath(settings, operation.operationId));
        assert.ok(terminal);
        await write(path.join(store.directory, `terminal-fixture-${randomUUID()}.json`), terminal);
        // Export only after terminal settlement. Unique files preserve partial
        // evidence and avoid rewriting an earlier attempt after interruption.
        assert.ok(record.actorInstallIssued, 'Missing installed actor evidence');
        if (!record.exported) {
          const exported = verifyTemporaryActorExport(
            await actor(
              store,
              cloud,
              ['node', `${record.plan.actorSourceRoot}/${actorFile}`, 'export'],
              { operationId: record.plan.operationId },
              { maxOutputBytes: 32 * 1024 * 1024 },
            ),
          );
          const file = `actor-export-${randomUUID()}.json`;
          await write(path.join(store.directory, file), exported);
          await store.change((r) => {
            r.exported = { file, hash: temporaryHash(exported) };
          });
        } else {
          const exported = verifyTemporaryActorExport(
            JSON.parse(await fs.readFile(path.join(store.directory, record.exported.file), 'utf8')),
          );
          assert.equal(temporaryHash(exported), record.exported.hash);
        }
        return !record.evidenceFailure;
      } catch {
        await store.change((r) => {
          r.evidenceFailure = 'terminal-diagnostics-unavailable';
        });
        return false;
      }
    },
    async removeEdgeAndBootstrap(store, cloud, { wait }) {
      let record = (await store.read()).record;
      if (!record.resources.some((i) => i.kind === 'kubernetes' && !i.absent) && (!record.dns || record.dns.removed))
        return;
      await hydrate(store, cloud);
      await snapshotBootstrap(store);
      const edge = record.resources.find((i) => i.key === 'gateway');
      if (edge && !edge.absent) {
        await captureEdge(store, cloud, edge);
        await remove(store, edge, wait);
      }
      // A previous cleanup may have deleted the Gateway but timed out waiting
      // for its children. Those observations remain mandatory on every retry.
      for (const child of (await store.read()).record.edgeChildren ?? [])
        await wait('Gateway child absence', async () => {
          const value = await cloud.request('compute', 'GET', child.resource);
          if (!value) return true;
          assert.equal(String(value.id), child.id);
          return false;
        });
      record = (await store.read()).record;
      for (const item of record.resources
        .filter((i) => i.kind === 'kubernetes' && i.key !== 'gateway' && !i.absent)
        .reverse())
        await remove(store, item, wait);
      for (const item of (await store.read()).record.bootstrapChildren ?? [])
        assert.equal(
          await api.json('GET', item.apiPath),
          null,
          'A recorded bootstrap child remains after namespace deletion',
        );
      if (record.dns && !record.dns.removed) {
        const current = await cloud.readDns(record.dns.rrset.name);
        if (current.length) {
          assert.deepEqual(current, [record.dns.rrset]);
          assert.ok(!record.dns.removeIssued, 'DNS removal is uncertain');
          await store.change((r) => {
            r.dns.removeIssued = true;
          });
          await cloud.dnsRecord(record.dns.rrset, true);
        } else assert.ok(record.dns.removeIssued, 'DNS absence without removal intent');
        await wait('DNS record absence', async () => !(await cloud.readDns(record.dns.rrset.name)).length);
        await store.change((r) => {
          r.dns.removed = true;
        });
      }
    },
    async removePermissions(store, cloud) {
      const { record } = await store.read();
      for (const item of record.iam ?? []) {
        assert.equal(item.preexisting, false);
        if (item.removed) continue;
        if (await cloud.readBinding(item.member, item.accountId)) {
          assert.ok(!item.removeIssued, 'IAM removal uncertain; do not replay');
          await store.change((r) => {
            r.iam.find((i) => i.member === item.member).removeIssued = true;
          });
          await cloud.iamBinding(item.member, true, item.accountId);
        } else assert.ok(item.removeIssued, 'IAM grant outcome uncertain or externally changed');
        assert.equal(await cloud.readBinding(item.member, item.accountId), false);
        await store.change((r) => {
          r.iam.find((i) => i.member === item.member).removed = true;
        });
      }
    },
  };
}

function parseDocuments(text) {
  return text
    .split('\n---\n')
    .filter((t) => t.trim())
    .map((t) => parse(t));
}
function objectCollection(object) {
  const plural = {
    ServiceAccount: 'serviceaccounts',
    ConfigMap: 'configmaps',
    Deployment: 'deployments',
    ClusterRole: 'clusterroles',
    ClusterRoleBinding: 'clusterrolebindings',
    Role: 'roles',
    RoleBinding: 'rolebindings',
  }[object.kind];
  assert.ok(plural);
  return `${object.apiVersion === 'v1' ? '/api/v1' : `/apis/${object.apiVersion}`}${object.metadata.namespace ? `/namespaces/${object.metadata.namespace}` : ''}/${plural}`;
}
