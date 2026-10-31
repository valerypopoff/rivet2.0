import assert from 'node:assert/strict';
// test-style: fixture-read: Use generated local certificates, private driver packages and operation journals only.
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryPlan } from './fixtures/temporary-staging-plan.mjs';
import { TemporaryStagingStore } from './lib/temporary-staging-store.mjs';
import { temporaryGcp } from './lib/temporary-staging-gcp.mjs';
import { temporaryStagingRuntime } from './lib/temporary-staging-runtime.mjs';
import { provisionTemporaryEnvironment, cleanupTemporaryEnvironment } from './lib/temporary-staging-lifecycle.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { temporaryHash } from './lib/temporary-staging-contract.mjs';
import { verifyTemporaryChallenge } from './lib/temporary-staging-certificate.mjs';
const require = createRequire(new URL('../../../packages/studio-server-api/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const { handler } = createRequire(import.meta.url)('../../../postman/mocks/temporary-gcp/contract.cjs');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const wait = async (label, check) => {
  for (let i = 0; i < 4; i++) if (await check()) return;
  throw Error(`Local wait failed: ${label}`);
};

test('concrete bootstrap uses real authenticated HTTPS/WebSocket paths and tears down partial creation without replay', async (t) => {
  for (const mode of [
    'normal bootstrap',
    'opaque Autopilot bootstrap',
    'stopped janitor admission',
    'stopped installed refresh admission',
    'stopped final bootstrap admission',
    'lost actor acknowledgement',
    'lost export',
    'corrupt export',
    'late test admission',
    'IP hostname bootstrap',
    'lost HTTPS acknowledgement',
  ])
    await t.test(mode, async (child) => {
      const lostActor = mode === 'lost actor acknowledgement',
        failedExport = mode === 'lost export' || mode === 'corrupt export',
        ipHostname = mode === 'IP hostname bootstrap' || mode === 'lost HTTPS acknowledgement',
        lostHttps = mode === 'lost HTTPS acknowledgement',
        stoppedAdmission = mode.startsWith('stopped ');
      const stopController = new AbortController(),
        stopError = new Error('Synthetic bootstrap admission stopped');
      let stopRequestCount;
      const admissionGuard = async () => {
        if (stopController.signal.aborted) throw stopController.signal.reason;
      };
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bootstrap-'));
      child.after(() => fs.rm(temp, { recursive: true, force: true }));
      const certFile = path.join(temp, 'cert.pem'),
        keyFile = path.join(temp, 'key.pem');
      execFileSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyFile,
          '-out',
          certFile,
          '-days',
          '2',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:rivet-q-12345-1.staging.example.net',
        ],
        { stdio: 'pipe' },
      );
      const cert = await fs.readFile(certFile),
        key = await fs.readFile(keyFile);
      const objects = new Map(),
        requests = [],
        packets = [];
      const stopAdmission = () => {
        stopRequestCount = requests.length;
        stopController.abort(stopError);
      };
      let serial = 1;
      let exportCalls = 0;
      let cloudBase;
      const httpChildren = [];
      const server = https.createServer({ cert, key }, async (req, res) => {
        const send = (code, value) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        const url = new URL(req.url, 'https://localhost'),
          resource = url.pathname;
        assert.equal(req.headers.authorization, 'Bearer local-only');
        requests.push({ method: req.method, resource });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
        if (resource === '/api/v1/namespaces/kube-system') return send(200, { metadata: { uid: 'system-uid' } });
        if (resource === '/api/v1/namespaces/default/services/kubernetes')
          return send(200, { metadata: { uid: 'kubernetes-service-uid' }, spec: { clusterIP: '10.13.0.1' } });
        if (resource === '/api/v1/nodes/actor-node')
          return send(200, {
            metadata: {
              name: 'actor-node',
              uid: 'actor-node-uid',
              labels: { 'topology.kubernetes.io/zone': 'europe-central2-a' },
            },
            spec: { providerID: 'gce://isolated-project/europe-central2-a/actor-node' },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              addresses: [
                { type: 'InternalIP', address: '10.11.0.2' },
                { type: 'ExternalIP', address: '34.118.0.99' },
              ],
            },
          });
        if (req.method === 'POST') {
          const target = `${resource}/${body.metadata.name}`;
          assert.ok(!objects.has(target));
          const value = {
            ...body,
            metadata: { ...body.metadata, uid: `uid-${serial++}`, resourceVersion: '1', generation: 1 },
          };
          if (body.kind === 'Pod') {
            value.status = { conditions: [{ type: 'Ready', status: 'True' }] };
            value.spec.nodeName = 'actor-node';
          }
          objects.set(target, value);
          if (lostActor && body.kind === 'Pod') return res.destroy();
          return send(201, value);
        }
        if (req.method === 'GET') {
          const resources = [
            { name: 'pods', kind: 'Pod' },
            { name: 'configmaps', kind: 'ConfigMap' },
            { name: 'secrets', kind: 'Secret' },
            { name: 'serviceaccounts', kind: 'ServiceAccount' },
            { name: 'events', kind: 'Event' },
            { name: 'services', kind: 'Service' },
          ].map((r) => ({ ...r, namespaced: true, verbs: ['list', 'delete'] }));
          if (resource === '/api/v1') return send(200, { resources });
          if (resource === '/apis')
            return send(200, {
              groups: [
                'apps/v1',
                'rbac.authorization.k8s.io/v1',
                'gateway.networking.k8s.io/v1',
                'networking.gke.io/v1',
              ].map((groupVersion) => ({ preferredVersion: { groupVersion } })),
            });
          const groupResources = {
            '/apis/apps/v1': ['deployments'],
            '/apis/rbac.authorization.k8s.io/v1': ['roles', 'rolebindings'],
            '/apis/gateway.networking.k8s.io/v1': ['gateways', 'httproutes'],
            '/apis/networking.gke.io/v1': ['healthcheckpolicies'],
          };
          if (groupResources[resource])
            return send(200, {
              resources: groupResources[resource].map((name) => ({
                name,
                namespaced: true,
                verbs: ['list', 'delete'],
              })),
            });
          if (
            /\/namespaces\/[^/]+\/(?:pods|configmaps|secrets|serviceaccounts|events|services|deployments|roles|rolebindings|gateways|httproutes|healthcheckpolicies)$/.test(
              resource,
            )
          )
            return send(200, {
              items: [...objects.entries()].filter(([key]) => key.startsWith(resource + '/')).map(([, v]) => v),
            });
          if (objects.has(resource) && resource.endsWith('/configmaps/rivet-qualification-janitor-health')) {
            const deployment = [...objects.values()].find(
              (v) => v.kind === 'Deployment' && v.metadata.name === 'rivet-qualification-janitor',
            );
            const codeName = deployment?.spec.template.spec.volumes.find((v) => v.name === 'code')?.configMap.name;
            const code = [...objects.values()].find((v) => v.kind === 'ConfigMap' && v.metadata.name === codeName);
            if (!code) return send(200, objects.get(resource));
            if (mode === 'stopped janitor admission') stopAdmission();
            const settings = JSON.parse(code.data['settings.json']);
            return send(200, {
              ...objects.get(resource),
              data: { health: JSON.stringify({ driverDigest: settings.approvedDriverDigest, observedAt: Date.now() }) },
            });
          }
          return send(objects.has(resource) ? 200 : 404, objects.get(resource) ?? { kind: 'Status' });
        }
        if (req.method === 'DELETE') {
          assert.equal(body.preconditions.uid, objects.get(resource)?.metadata.uid);
          const removed = objects.get(resource);
          objects.delete(resource);
          if (removed.kind === 'Namespace')
            for (const [key, value] of objects)
              if (value.metadata.namespace === removed.metadata.name) objects.delete(key);
          return send(200, { kind: 'Status', status: 'Success' });
        }
        if (req.method === 'PUT' && objects.has(resource)) {
          assert.equal(body.metadata.uid, objects.get(resource).metadata.uid);
          assert.equal(body.metadata.resourceVersion, objects.get(resource).metadata.resourceVersion);
          body.metadata.resourceVersion = String(++serial);
          objects.set(resource, body);
          return send(200, body);
        }
        if (req.method === 'PATCH' && objects.has(resource)) {
          assert.equal(req.headers['content-type'], 'application/json-patch+json');
          const value = objects.get(resource);
          assert.deepEqual(body.slice(0, 2), [
            { op: 'test', path: '/metadata/uid', value: value.metadata.uid },
            { op: 'test', path: '/metadata/resourceVersion', value: value.metadata.resourceVersion },
          ]);
          for (const patch of body.slice(2)) {
            assert.equal(patch.op, 'replace');
            if (patch.path === '/data/challenge.json') value.data['challenge.json'] = patch.value;
            else {
              assert.equal(patch.path, '/spec/listeners');
              value.spec.listeners = patch.value;
            }
          }
          value.metadata.resourceVersion = String(++serial);
          if (value.kind === 'Gateway')
            for (const child of httpChildren.filter((_, i) => i === 0 || lostHttps))
              await fetch(new URL('compute/' + child.resource, cloudBase), {
                method: 'DELETE',
                headers: { authorization: 'Bearer local-only' },
              });
          if (lostHttps && value.kind === 'Gateway') return res.destroy();
          return send(200, value);
        }
        return send(501, { kind: 'Status' });
      });
      const ws = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) =>
        ws.handleUpgrade(req, socket, head, (client) => {
          assert.equal(req.headers.authorization, 'Bearer local-only');
          const chunks = [];
          client.on('message', (data) => {
            if (data[0] === 0) chunks.push(data.subarray(1));
            else if (data[0] === 255) {
              const packet = JSON.parse(Buffer.concat(chunks));
              packets.push(packet);
              client.send(Buffer.concat([Buffer.from([2]), Buffer.from('expected private phase progress\n')]));
              const exporting =
                new URL(req.url, 'https://localhost').searchParams.getAll('command').at(-1) === 'export';
              if (exporting) {
                const registry = [...objects.values()].find(
                  (v) => v.metadata.labels?.['rivet.dev/qualification-operation'],
                );
                assert.equal(JSON.parse(registry.data.record).cleanupVerified, true, 'Export must follow settlement');
                exportCalls++;
                if (mode === 'lost export') {
                  client.send(
                    Buffer.concat([
                      Buffer.from([3]),
                      Buffer.from('{"status":"Failure","message":"fixture export lost"}'),
                    ]),
                  );
                  client.close();
                  return;
                }
              }
              const output = Buffer.from(
                JSON.stringify(
                  exporting
                    ? {
                        files: [
                          {
                            name: 'terminal.json',
                            bytes: 'e30=',
                            hash: mode === 'corrupt export' ? 'f'.repeat(64) : temporaryHash('{}'),
                          },
                        ],
                      }
                    : packet.files
                      ? {
                          installed: true,
                          label: 'étape',
                          files: Object.fromEntries(
                            Object.entries(packet.files).map(([name, value]) => [name, value.hash]),
                          ),
                        }
                      : {},
                ),
              );
              const cut = output.indexOf(Buffer.from('é')) + 1;
              client.send(Buffer.concat([Buffer.from([1]), output.subarray(0, cut)]));
              client.send(Buffer.concat([Buffer.from([1]), output.subarray(cut)]));
              client.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
              client.close();
            }
          });
        }),
      );
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      child.after(() => {
        ws.close();
        server.closeAllConnections();
        return new Promise((r) => server.close(r));
      });
      const cloudServer = http.createServer(handler());
      cloudServer.listen(0, '127.0.0.1');
      await once(cloudServer, 'listening');
      child.after(() => {
        cloudServer.closeAllConnections();
        return new Promise((r) => cloudServer.close(r));
      });
      const url = `http://127.0.0.1:${cloudServer.address().port}/`;
      cloudBase = url;
      const image = { repository: 'registry.test/image', digest: `sha256:${'a'.repeat(64)}` };
      const create = (previous) =>
        createStudioServerReleaseManifest({
          rootDir: root,
          source: {
            repository: 'example/rivet',
            ref: 'refs/heads/main',
            sha: previous ? 'a'.repeat(40) : 'b'.repeat(40),
          },
          images: Object.fromEntries(
            ['api', 'web', 'executor', 'proxy'].map((k) => [
              k,
              { ...image, digest: `sha256:${(previous ? 'a' : 'b').repeat(64)}` },
            ]),
          ),
          candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
          predecessorRelease: previous,
        });
      const previous = promoteStudioServerReleaseManifest(create(null), {
          promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
        }),
        candidate = create(previous);
      const policy = autoscalerPolicy({ minReplicas: 2, maxReplicas: 4 });
      const installed = {
        scope: 'production-read-only',
        observedAt: new Date().toISOString(),
        manifestDigest: getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
        images: previous.images,
        schemaVersion: previous.database.managedWorkflowSchema.version,
        namespaceUid: 'prod-ns',
        clusterUid: 'prod-system',
        valuesDigest: `sha256:${'1'.repeat(64)}`,
        settingsDigest: `sha256:${'2'.repeat(64)}`,
        controlPlaneMode: 'singleton',
        edgeProfile: 'compact',
        policyDigest: autoscalerPolicyDigest(policy),
        policy,
        baseline: { backend: 1, web: 1, execution: 2, proxy: 2, autoscaler: 1 },
      };
      const registryFile = path.join(temp, 'pull.json'),
        registry = Buffer.from(
          JSON.stringify({
            auths: { 'registry.test': { auth: Buffer.from('pull-reader:fixture-only').toString('base64') } },
          }),
        );
      await fs.writeFile(registryFile, registry, { mode: 0o600 });
      const plan = temporaryPlan({
        certificateSha256: temporaryHash(cert),
        privateKeySha256: temporaryHash(key),
        registrySecretSha256: temporaryHash(registry),
        candidateDigest: getStudioServerReleaseManifestDigest(candidate),
        predecessorDigest: getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
        ...(ipHostname
          ? {
              hostnameMode: 'ip-encoded-http01',
              domain: 'sslip.io',
              managedZone: null,
              certificateSha256: null,
              privateKeySha256: null,
              acme: {
                image: `certbot/certbot@sha256:${'1'.repeat(64)}`,
                termsUrl: 'https://letsencrypt.org/documents/test.pdf',
                subscriberTermsApproved: true,
                certificateIssuanceApproved: true,
              },
            }
          : {}),
      });
      let certificateCalls = 0,
        publicChecks = 0;
      const challengeServer = http.createServer((req, res) => {
        const config = [...objects.values()].find(
          (v) => v.kind === 'ConfigMap' && v.metadata.name === 'qualification-acme',
        );
        const packet = JSON.parse(config.data['challenge.json']);
        const gateway = [...objects.values()].find((v) => v.kind === 'Gateway');
        assert.equal(gateway.spec.listeners[0].protocol, 'HTTP');
        const pod = [...objects.values()].find((v) => v.kind === 'Pod' && v.metadata.name === 'qualification-acme');
        assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'rivet-qualification-pull' }]);
        assert.equal(pod.spec.automountServiceAccountToken, false);
        assert.ok([...objects.values()].some((v) => v.kind === 'HTTPRoute'));
        assert.equal(req.url, '/.well-known/acme-challenge/' + packet.token);
        res.end(packet.validation);
      });
      await new Promise((resolve) => challengeServer.listen(0, '127.0.0.1', resolve));
      child.after(
        () =>
          new Promise((resolve) => {
            challengeServer.closeAllConnections();
            challengeServer.close(resolve);
          }),
      );
      await fetch(new URL('_control', url), { method: 'POST', body: JSON.stringify({ plan }) });
      const cloud = temporaryGcp(plan, {
        origins: Object.fromEntries(
          ['compute', 'container', 'crm', 'iam', 'dns'].map((k) => [k, new URL(`${k}/`, url).href]),
        ),
        simulation: true,
        token: async () => 'local-only',
      });
      const store = new TemporaryStagingStore(path.join(temp, plan.operationId), {
        lock: async () => ({ close: async () => {} }),
      });
      await store.initialize(plan);
      const bootstrap = temporaryStagingRuntime({
        root,
        certificateFile: certFile,
        keyFile,
        registryFile,
        inputs: { candidate, previous, installed, policy },
        signal: stopController.signal,
        refreshInstalled: async () => {
          if (mode === 'stopped installed refresh admission') stopAdmission();
          return { ...installed, observedAt: new Date().toISOString() };
        },
        verifyPrerequisites: async (state) => {
          await state.cluster();
          if (mode === 'stopped final bootstrap admission') stopAdmission();
          return { publicTlsVerified: true };
        },
        ...(ipHostname
          ? {
              verifyPublicChallenge: (packet) => {
                publicChecks++;
                if (publicChecks === 1)
                  throw new DOMException('Synthetic cold Gateway connection timeout', 'TimeoutError');
                return verifyTemporaryChallenge(packet, {
                  resolve: async () => [packet.address],
                  fetchImpl: (url, options) =>
                    fetch(`http://127.0.0.1:${challengeServer.address().port}` + new URL(url).pathname, options),
                });
              },
              certificateIssuer: async (s, { hostname, publishChallenge }) => {
                certificateCalls++;
                assert.equal(
                  publicChecks,
                  2,
                  'Public probe must succeed after its cold-start timeout before any certificate order',
                );
                assert.equal((await s.read()).record.hostname.name, hostname);
                await publishChallenge({ token: 'a'.repeat(24), validation: 'b'.repeat(40) });
                const prefix = `projects/${plan.projectId}/regions/${plan.region}`;
                const proxy = `${prefix}/targetHttpProxies/retired-http`;
                httpChildren.push(
                  {
                    resource: `${prefix}/forwardingRules/preparation`,
                    value: {
                      id: '9801',
                      name: 'preparation',
                      IPAddress: (await s.read()).record.hostname.address,
                      target: `https://www.googleapis.com/compute/v1/${proxy}`,
                    },
                  },
                  { resource: proxy, value: { id: '9802', name: 'retired-http' } },
                );
                for (const child of httpChildren)
                  await fetch(new URL('_replace', url), {
                    method: 'POST',
                    body: JSON.stringify({
                      ...child,
                      value: { ...child.value, selfLink: `https://www.googleapis.com/compute/v1/${child.resource}` },
                    }),
                  });
                const target = path.join(temp, 'issued.pem');
                execFileSync(
                  process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
                  [
                    'req',
                    '-x509',
                    '-key',
                    keyFile,
                    '-out',
                    target,
                    '-days',
                    '2',
                    '-subj',
                    '/CN=' + hostname,
                    '-addext',
                    'subjectAltName=DNS:' + hostname,
                  ],
                  { stdio: 'pipe' },
                );
                return { certificate: await fs.readFile(target), key };
              },
            }
          : {}),
      });
      // Provisioning is the subject of the other HTTP matrix. Here we inject only
      // the cluster's actual local HTTPS endpoint before exercising real bootstrap.
      const runtime = {
        ...bootstrap,
        offlinePreflight: async () => {},
        bootstrap: async (s, c, opts) => {
          const specResource = `projects/${plan.projectId}/locations/${plan.region}/clusters/${plan.operationId}`;
          const value = await c.request('container', 'GET', specResource);
          value.networkConfig = {
            ...value.networkConfig,
            network: `projects/${plan.projectId}/global/networks/${plan.operationId}`,
            subnetwork: `projects/${plan.projectId}/regions/${plan.region}/subnetworks/${plan.operationId}-nodes`,
            defaultEnablePrivateNodes: false,
          };
          if (mode !== 'opaque Autopilot bootstrap')
            await fetch(new URL('_replace', url), {
              method: 'POST',
              body: JSON.stringify({
                resource: `projects/${plan.projectId}/zones/europe-central2-a/instances/actor-node`,
                value: {
                  id: '999',
                  name: 'actor-node',
                  createdByClusterId: value.id,
                  networkInterfaces: [
                    {
                      network: `https://www.googleapis.com/compute/v1/projects/${plan.projectId}/global/networks/${plan.operationId}`,
                      subnetwork:
                        'projects/' +
                        plan.projectId +
                        '/regions/' +
                        plan.region +
                        '/subnetworks/' +
                        plan.operationId +
                        '-nodes',
                      networkIP: '10.11.0.2',
                      accessConfigs: [{ natIP: '34.118.0.99' }],
                    },
                  ],
                },
              }),
            });
          value.endpoint = `127.0.0.1:${server.address().port}`;
          value.masterAuth.clusterCaCertificate = cert.toString('base64');
          await fetch(new URL('_replace', url), {
            method: 'POST',
            body: JSON.stringify({ resource: specResource, value }),
          });
          await s.change((r) => {
            const item = r.resources.find((i) => i.key === 'cluster');
            item.identity.endpoint = value.endpoint;
            item.identity.ca = value.masterAuth.clusterCaCertificate;
          });
          return bootstrap.bootstrap(s, c, opts);
        },
      };
      // Pin the local endpoint from the outset, before the immutable ID is stored.
      const realIdentity = cloud.identity;
      cloud.identity = (spec, value) =>
        realIdentity(
          spec,
          spec.kind === 'cluster' && value
            ? {
                ...value,
                endpoint: `127.0.0.1:${server.address().port}`,
                masterAuth: { clusterCaCertificate: cert.toString('base64') },
              }
            : value,
        );
      await store.locked(async () => {
        if (stoppedAdmission) {
          await assert.rejects(
            provisionTemporaryEnvironment(store, cloud, runtime, { wait, guard: admissionGuard }),
            (error) => error === stopError,
          );
          const record = (await store.read()).record;
          assert.ok(stopController.signal.aborted);
          assert.equal(record.phase, 'provisioning');
          assert.equal(record.qualificationIssued, undefined);
          assert.equal(record.remotePhases, undefined);
          if (mode !== 'stopped final bootstrap admission') assert.equal(record.operation, undefined);
          assert.ok(Number.isInteger(stopRequestCount));
          assert.equal(
            requests.slice(stopRequestCount).some((request) => request.method !== 'GET'),
            false,
            'Admission stop must not dispatch new bootstrap work',
          );
        } else if (lostActor || lostHttps)
          await assert.rejects(provisionTemporaryEnvironment(store, cloud, runtime, { wait, guard: admissionGuard }));
        else {
          await provisionTemporaryEnvironment(store, cloud, runtime, { wait, guard: admissionGuard });
          const record = (await store.read()).record;
          assert.equal(record.operation.expiresAt, record.expiresAt);
          assert.equal(record.settings.inClusterServer, 'https://10.13.0.1/');
          assert.ok(record.settings.trustedClients.includes('34.118.0.99/32'));
          assert.equal(
            record.actorNodeIdentity.kind,
            mode === 'opaque Autopilot bootstrap' ? 'gke-autopilot-node' : 'compute-instance',
          );
          assert.equal('instanceId' in record.actorNodeIdentity, mode !== 'opaque Autopilot bootstrap');
          assert.equal(packets.length, 1);
          const pod = [...objects.values()].find((v) => v.kind === 'Pod');
          assert.equal(pod.spec.serviceAccountName, 'rivet-qualification-actor');
          assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'rivet-qualification-pull' }]);
          assert.ok(record.settings.registrySecret.uid && record.settings.janitorRegistrySecret.uid);
          if (ipHostname) {
            assert.equal(certificateCalls, 1);
            assert.equal(publicChecks, 3);
            assert.equal(record.dns, undefined);
            assert.equal(record.tlsMaterial.hostname, `${plan.operationId}.${record.settings.domain}`);
            assert.equal([...objects.values()].find((v) => v.kind === 'Gateway').spec.listeners[0].protocol, 'HTTPS');
            assert.ok(
              record.edgeChildren.some((child) => child.id === '9802'),
              'Detached HTTP children must remain cleanup-owned',
            );
            assert.equal(
              (await cloud.edgeChildren(record.hostname.address)).some((child) => child.id === '9802'),
              false,
            );
          }
          assert.equal(
            pod.spec.containers[0].env.some((e) => /GITHUB|PRODUCTION/.test(e.name)),
            false,
          );
          if (mode === 'late test admission') {
            const late =
              Date.parse(record.expiresAt) -
              (plan.allowance.cleanupReserveSeconds + plan.allowance.minimumTestSeconds) * 1000 +
              1;
            child.mock.method(Date, 'now', () => late);
            try {
              await assert.rejects(bootstrap.qualify(store, cloud));
              assert.equal(
                (await store.read()).record.remotePhases?.armExpiry,
                undefined,
                'No new test phase may consume the reserved settlement/export window',
              );
            } finally {
              child.mock.restoreAll();
            }
          }
          const registryPath = `/api/v1/namespaces/${record.settings.controlNamespace}/configmaps/${plan.operationId}`;
          const inner = {
            protocol: 1,
            operation: record.operation,
            namespace: `rivet-staging-${plan.operationId}`,
            release: 'rivet-qualification',
            closed: true,
            phase: 'settled',
            inventory: [],
            cleanupVerified: false,
          };
          const registry = {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
              name: plan.operationId,
              namespace: record.settings.controlNamespace,
              uid: 'registry-uid',
              resourceVersion: '1',
              labels: { 'rivet.dev/qualification-operation': plan.operationId },
            },
            data: { record: JSON.stringify(inner) },
          };
          objects.set(registryPath, registry);
          await assert.rejects(bootstrap.settleAndExport(store, cloud, { wait }), /Fixture not settled/);
          assert.equal(exportCalls, 0, 'A partial recording must not become the terminal export');
          inner.cleanupVerified = true;
          inner.phase = 'cleaned';
          registry.data.record = JSON.stringify(inner);
          const staleExport = path.join(store.directory, 'actor-export.json');
          await fs.writeFile(staleExport, 'preserve earlier partial diagnostics');
          const evidenceExported = await bootstrap.settleAndExport(store, cloud, { wait });
          assert.equal(evidenceExported, !failedExport);
          assert.equal(exportCalls, 1);
          const exportRecord = (await store.read()).record;
          if (failedExport) {
            assert.equal(exportRecord.exported, undefined);
            assert.equal(exportRecord.evidenceFailure, 'terminal-diagnostics-unavailable');
          } else {
            const exported = exportRecord.exported;
            assert.equal(
              temporaryHash(JSON.parse(await fs.readFile(path.join(store.directory, exported.file), 'utf8'))),
              exported.hash,
            );
          }
          assert.equal(await fs.readFile(staleExport, 'utf8'), 'preserve earlier partial diagnostics');
          const eventPath = `/apis/networking.gke.io/v1/namespaces/${record.settings.runnerNamespace}/healthcheckpolicies/ambiguous`;
          objects.set(eventPath, {
            apiVersion: 'networking.gke.io/v1',
            kind: 'HealthCheckPolicy',
            metadata: {
              name: 'ambiguous',
              namespace: record.settings.runnerNamespace,
              uid: 'unowned-custom-object-uid',
            },
          });
          await assert.rejects(cleanupTemporaryEnvironment(store, cloud, bootstrap, { wait }), /Unowned bootstrap/);
          assert.equal(
            requests.some((r) => r.method === 'DELETE' && !r.resource.endsWith('/qualification-acme')),
            false,
            'Ambiguous inventory must block all bootstrap deletion',
          );
          objects.delete(eventPath); // Remove only the deliberately injected local test object.
          const rootResource = `projects/${plan.projectId}/regions/${plan.region}`;
          const childResources = [
            {
              resource: `${rootResource}/forwardingRules/gateway-child`,
              value: {
                id: '9901',
                name: 'gateway-child',
                IPAddress: '192.0.2.10',
                target: `https://www.googleapis.com/compute/v1/${rootResource}/backendServices/gateway-child`,
              },
            },
            { resource: `${rootResource}/backendServices/gateway-child`, value: { id: '9902', name: 'gateway-child' } },
          ];
          for (const { resource, value } of childResources)
            await fetch(new URL('_replace', url), {
              method: 'POST',
              body: JSON.stringify({
                resource,
                value: { ...value, selfLink: `https://www.googleapis.com/compute/v1/${resource}` },
              }),
            });
          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
              cleanupTemporaryEnvironment(store, cloud, bootstrap, { wait }),
              /Gateway child absence/,
            );
            assert.ok((await store.read()).record.resources.find((r) => r.key === 'gateway').absent);
            assert.ok(
              [...objects.values()].some((v) => v.kind === 'Pod'),
              'Retried cleanup must retain the controller/actor until edge children disappear',
            );
            assert.equal(
              requests.filter(
                (r) =>
                  r.method === 'DELETE' &&
                  !r.resource.endsWith('/gateways/qualification') &&
                  !r.resource.endsWith('/qualification-acme'),
              ).length,
              0,
            );
          }
          // Simulate controller GC through the local provider HTTP fixture.
          for (const { resource } of childResources) await cloud.request('compute', 'DELETE', resource);
          if (ipHostname) await cloud.request('compute', 'DELETE', httpChildren[1].resource);
        }
        await cleanupTemporaryEnvironment(store, cloud, bootstrap, { wait });
        assert.equal((await store.read()).record.complete, true);
        assert.equal(
          requests.filter((r) => r.method === 'POST' && r.resource.endsWith('/pods')).length,
          lostHttps ? 1 : ipHostname ? 2 : 1,
        );
        assert.equal(
          requests.filter((r) => r.method === 'PATCH' && r.resource.endsWith('/gateways/qualification')).length,
          ipHostname ? 1 : 0,
        );
        assert.equal(objects.size, 0);
        if (ipHostname) {
          const traffic = await (await fetch(new URL('_requests', url))).json();
          assert.equal(
            traffic.some((row) => row.service === 'dns'),
            false,
            'IP-hostname bootstrap must not require a managed DNS zone',
          );
        }
      });
    });
});
