import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { RuntimeControlLocalGate, mergeRuntimeControlGuards } from './kubernetes-runtime-control-local.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { readManagedWorkflowSchemaReleaseContract } from './lib/studio-server-release-manifest.mjs';
import { runHaKubernetesRollout } from './lib/ha-kubernetes-rollout.mjs';
import { runHaKubernetesControlTopology } from './lib/ha-kubernetes-control-topology.mjs';
import { HaReleaseProbes } from './lib/ha-release-probes.mjs';
import { startHaBrowserProbe } from './lib/ha-browser-probe.mjs';

const root = process.cwd(),
  node = process.env.RIVET_OVERLAP_LOCAL_NODE;
assert.match(node ?? '', /^rivet-runtime-ha10-[a-z0-9-]+$/);
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8e6 }).trim();
assert.ok(docker(['inspect', '--format', '{{.Config.Image}}', node]).includes('kicbase'));
const token = randomUUID(),
  id = token.slice(0, 8),
  folder = path.resolve('artifacts', `developer-overlap-${id}`);
await fs.mkdir(folder, { recursive: false });
const endpoint = (container, port) => {
  const value = docker(['port', container, String(port)]).split('\n')[0];
  assert.match(value, /^127\.0\.0\.1:\d+$/);
  return value;
};
const kubeconfig = parse(docker(['exec', node, 'cat', '/etc/kubernetes/admin.conf']));
kubeconfig.clusters[0].cluster.server = `https://${endpoint(node, 8443)}`;
kubeconfig.contexts[0].name = node;
kubeconfig['current-context'] = node;
const privateConfig = path.join(folder, 'kubeconfig.private.json');
await fs.writeFile(privateConfig, JSON.stringify(kubeconfig), { mode: 0o600 });
process.env.KUBECONFIG = privateConfig;
const registry = endpoint('rivet-runtime-q20261021-registry', 5000);
const networks = JSON.parse(
  docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'rivet-runtime-q20261021-registry']),
);
const registryIp = networks[node]?.IPAddress;
assert.match(registryIp ?? '', /^192\.168\.\d+\.\d+$/);
const publishLocal = async (source, role, tag) => {
  const repository = `overlap-${id}-${role}`,
    target = `${registry}/${repository}:${tag}`;
  const archive = path.join(folder, `${role}-${tag}.tar`);
  docker(['save', '--output', archive, source]);
  const image = `docker://${registryIp}:5000/${repository}:${tag}`;
  docker([
    'run',
    '--rm',
    '--network',
    node,
    '--mount',
    `type=bind,source=${archive},target=/image.tar,readonly`,
    'quay.io/skopeo/stable:latest',
    'copy',
    '--dest-tls-verify=false',
    'docker-archive:/image.tar',
    image,
  ]);
  const digest = docker([
    'run',
    '--rm',
    '--network',
    node,
    'quay.io/skopeo/stable:latest',
    'inspect',
    '--tls-verify=false',
    '--format',
    '{{.Digest}}',
    image,
  ]);
  assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/);
  await fs.unlink(archive);
  return { repository: `10.96.0.250:5000/${repository}`, digest };
};
const preparedPath =
  process.env.RIVET_OVERLAP_PREPARED_IMAGES && path.resolve(process.env.RIVET_OVERLAP_PREPARED_IMAGES);
if (preparedPath && !preparedPath.startsWith(path.resolve('artifacts') + path.sep))
  throw Error('Prepared local images must be an artifact.');
const prepared = preparedPath ? JSON.parse(await fs.readFile(preparedPath, 'utf8')) : undefined;
const apiA =
  (process.env.RIVET_OVERLAP_REFRESH_BASELINE === '1' ? undefined : prepared?.baseline.api) ||
  (await publishLocal('rivet-local/api:singleton-overlap-baseline-20261023', 'api', 'baseline'));
const apiB =
  (process.env.RIVET_OVERLAP_REFRESH_IMAGES === '1' || process.env.RIVET_OVERLAP_REFRESH_API === '1'
    ? undefined
    : prepared?.candidate.api) ||
  (await publishLocal('rivet-local/api:singleton-overlap-20261023', 'api', 'candidate'));
assert.notEqual(apiA.digest, apiB.digest);
const web =
  (process.env.RIVET_OVERLAP_REFRESH_IMAGES === '1' ? undefined : prepared?.candidate.web) ||
  (await publishLocal('rivet-local/web:singleton-overlap-20261023', 'web', 'fixture'));
const proxy =
  (process.env.RIVET_OVERLAP_REFRESH_PROXY === '1' ? undefined : prepared?.candidate.proxy) ||
  (await publishLocal('rivet-local/proxy:singleton-overlap-20261023', 'proxy', 'fixture'));
const baseline = { api: apiA, executor: apiA, web, proxy },
  candidate = { api: apiB, executor: apiB, web, proxy };
for (const image of Object.values({ ...baseline, ...candidate })) {
  assert.match(image.repository, /^10\.96\.0\.250:5000\/overlap-[a-f0-9]{8}-[a-z]+$/);
  assert.match(image.digest, /^sha256:[a-f0-9]{64}$/);
}
await fs.writeFile(path.join(folder, 'images.json'), JSON.stringify({ baseline, candidate }));
const config = {
  context: node,
  allowedContext: node,
  namespace: `rivet-runtime-control-overlap-${id}`,
  release: `overlap-${id}`,
  mode: 'smoke',
  runtimeEdgeProfile: 'compact',
  images: baseline,
  managedWorkflowSchema: readManagedWorkflowSchemaReleaseContract(root),
  imagePullPolicy: 'IfNotPresent',
  registry: {
    server: '10.96.0.250:5000',
    username: 'local-fixture',
    password: 'local-fixture',
    secretName: 'rivet-release-gate-registry',
  },
  artifactsDir: folder,
  deploymentTimeoutSeconds: 600,
  keepNamespace: true,
};
class Gate extends RuntimeControlLocalGate {
  overlap = false;
  fixtureSetup = true;
  values(images = this.config.images) {
    const value = super.values(images, true);
    value.ha.controlPlane.mode = this.overlap ? 'singleton-overlap' : 'singleton';
    value.ha.namespaceUid = this.namespaceUid ?? '';
    value.resources.backendOverlap = structuredClone(value.resources.backend); // Local fixture envelope, not production sizing evidence.
    // The generic smoke fixture's 100m request makes normal Node startup look
    // overloaded to the real headroom guard. Budget actual startup capacity;
    // do not fake metrics or weaken the production admission calculation.
    value.resources.execution.requests.cpu = '500m';
    value.metrics = { enabled: true };
    value.autoscaling = {
      ...value.autoscaling,
      execution: { enabled: false, minReplicas: 2, maxReplicas: 3, targetCPUUtilizationPercentage: 75 },
      // Freeze only fixture admission before the deployment acquires its shared
      // journal. The real rollout re-enables cooperative scale-up under its lease.
      executionController: {
        enabled: true,
        suspended: this.fixtureSetup,
        // Local functional timing only. Keep real metrics and the production
        // withdrawal window; do not spend five idle minutes on a unit-tested
        // stabilization duration after the real mixed-image upgrade.
        pollSeconds: 5,
        stabilizationSeconds: 30,
        cooldownSeconds: 5,
      },
    };
    return value;
  }
  async deleteOwnedNamespace() {
    if (!this.namespaceUid) return;
    const current = await this.kubectl(['get', 'namespace', config.namespace, '--ignore-not-found', '-o', 'json'], {
      capture: true,
    });
    if (!current.stdout.trim()) return;
    assert.equal(JSON.parse(current.stdout).metadata.uid, this.namespaceUid);
    assert.equal(JSON.parse(current.stdout).metadata.labels['rivet.release-gate/owned'], 'true');
    const claims = JSON.parse((await this.kube(['get', 'pvc', '-o', 'json'])).stdout).items;
    const volumes = [];
    for (const claim of claims) {
      assert.equal(claim.metadata.labels['app.kubernetes.io/instance'], config.release);
      if (!claim.spec.volumeName) continue;
      const volume = JSON.parse((await this.kube(['get', 'pv', claim.spec.volumeName, '-o', 'json'])).stdout);
      assert.equal(volume.spec.claimRef.uid, claim.metadata.uid);
      assert.equal(volume.spec.claimRef.namespace, config.namespace);
      volumes.push({ name: volume.metadata.name, uid: volume.metadata.uid, claimUid: claim.metadata.uid });
    }
    await fs.writeFile(
      path.join(folder, 'cleanup-targets.json'),
      JSON.stringify({ namespaceUid: this.namespaceUid, volumes }),
    );
    await this.kubectl(['delete', '--raw', `/api/v1/namespaces/${config.namespace}`, '-f', '-'], {
      input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: this.namespaceUid } }),
    });
    await this.kubectl(['wait', '--for=delete', `namespace/${config.namespace}`, '--timeout=180s']);
    for (const volume of volumes) {
      const deadline = Date.now() + 180000;
      while (true) {
        const current = await this.kube(['get', 'pv', volume.name, '--ignore-not-found', '-o', 'json']);
        if (!current.stdout.trim()) break;
        assert.equal(JSON.parse(current.stdout).metadata.uid, volume.uid, 'local volume identity changed');
        if (Date.now() >= deadline) throw Error(`Owned local volume remains: ${volume.name}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await fs.writeFile(
      path.join(folder, 'cleanup.json'),
      JSON.stringify({ namespaceUid: this.namespaceUid, volumes, absent: true }),
    );
  }
}
const gate = new Gate(
  config,
  process.env.RIVET_K8S_KUBECTL_BIN || 'C:/Program Files/Docker/Docker/resources/bin/kubectl.exe',
  resolveHelmBinOrThrow(root),
);
let browser,
  sampler,
  samplerError,
  running = false,
  resumed = false;
try {
  await gate.assertLocalContext();
  await gate.createNamespace();
  await gate.createRegistrySecret();
  await gate.installDependencies();
  await fs.writeFile(
    path.join(folder, 'inventory.json'),
    JSON.stringify({
      local: true,
      namespace: config.namespace,
      namespaceUid: gate.namespaceUid,
      token,
      baseline,
      candidate,
    }),
  );
  await gate.apply(gate.values(), 'serial-bridge.json');
  await gate.prepareLocalRestoreVolume();
  gate.overlap = true;
  const overlapValues = gate.values(),
    resources = await gate.resources(overlapValues, 'overlap-transition');
  await runHaKubernetesControlTopology({
    safety: gate.deploymentSafety('topology', apiA.digest),
    kube: (...args) => gate.kube(...args),
    release: config.release,
    namespace: config.namespace,
    manifestDigest: apiA.digest,
    resources,
    timeoutMs: 180000,
    artifact: (...args) => gate.artifact(...args),
    applyTemplates: (guards) => gate.apply(mergeRuntimeControlGuards(overlapValues, guards), 'enable-overlap.json'),
  });
  const base = await gate.openProxy(),
    state = await gate.exercisePersistence(base);
  await gate.artifact('ha-persisted-state.json', JSON.stringify(state));
  const probes = new HaReleaseProbes(gate, base, root);
  await probes.prepare({ embeddedMaintenance: true });
  browser = await startHaBrowserProbe(gate, base, root, { template: probes.template, label: 'backend-overlap' });
  const before = await gate.pods();
  running = true;
  sampler = (async () => {
    while (running) {
      const pods = await gate.pods();
      assert.ok(
        pods.some(
          (p) =>
            p.metadata.labels?.['app.kubernetes.io/component'] === 'backend' &&
            p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
        ),
        'developer serving capacity disappeared',
      );
      if (!resumed) {
        const pod = pods.find((p) => p.metadata.name === `${config.release}-ha-backend-0`);
        if (pod) {
          const status = JSON.parse(
            (
              await gate.kube([
                'exec',
                pod.metadata.name,
                '-c',
                'backend',
                '--',
                'node',
                '/opt/rivet/retire-backend.mjs',
              ])
            ).stdout,
          );
          if (status.state === 'draining') {
            await browser.resumeAfterFrontendReplacement([]);
            resumed = true;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  sampler.catch((error) => {
    samplerError = error;
  });
  config.images = candidate;
  gate.fixtureSetup = false;
  const values = gate.values(candidate),
    desired = await gate.resources(values, 'candidate');
  await runHaKubernetesRollout({
    safety: gate.deploymentSafety('rolling', apiB.digest),
    kube: (...args) => gate.kube(...args),
    release: config.release,
    namespace: config.namespace,
    manifestDigest: apiB.digest,
    resources: desired,
    timeoutMs: 240000,
    artifact: (...args) => gate.artifact(...args),
    verifyDeveloperReady: async (pod) => {
      const code = `const{createHash}=await import('node:crypto');const{default:WS}=await import('ws');const h={'x-rivet-proxy-auth':createHash('sha256').update(process.env.RIVET_KEY+':proxy-auth').digest('hex'),cookie:'rivet_ui_token='+createHash('sha256').update(process.env.RIVET_KEY+':ui-session').digest('hex')};const base='http://127.0.0.1:'+process.env.PORT;const tree=await fetch(base+'/api/workflows/tree',{headers:h});if(!tree.ok)throw Error('Developer API failed');const c=await(await fetch(base+'/api/config',{headers:h})).json();const u=new URL(c.executorWsUrl);u.host='127.0.0.1:'+process.env.PORT;await new Promise((resolve,reject)=>{const s=new WS(u,['rivet-session-v1'],{headers:h});const t=setTimeout(()=>{s.terminate();reject(Error('Editor session timeout'))},10000);s.on('error',reject);s.on('message',raw=>{if(JSON.parse(raw).message==='executor-session'){clearTimeout(t);s.close();resolve()}})});console.log('accepted')`;
      await gate.kube(['exec', pod.name, '-c', 'backend', '--', 'node', '--input-type=module', '-e', code]);
    },
    beforeRetirement: async (pod) => {
      if (/-ha-execution-\d+$/.test(pod.name)) {
        // A Ready surge can precede its first metrics-server sample. Wait on
        // real observations, not a sleep or an invented zero-CPU sample.
        const end = Date.now() + 120000;
        while (true) {
          const pods = (await gate.pods()).filter(
            (p) => p.metadata.labels['app.kubernetes.io/component'] === 'execution' && !p.metadata.deletionTimestamp,
          );
          const samples = JSON.parse(
            (await gate.kube(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${config.namespace}/pods`]))
              .stdout,
          ).items;
          if (
            pods.every((p) =>
              samples.some(
                (s) =>
                  s.metadata.name === p.metadata.name &&
                  Date.now() - Date.parse(s.timestamp) < 60000 &&
                  s.containers.some((c) => c.name === 'api' && /^\d+(?:\.\d+)?[num]?$/.test(c.usage?.cpu ?? '')),
              ),
            )
          )
            break;
          if (Date.now() >= end) throw Error('Local fixture has no fresh execution CPU observations.');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (/-ha-backend-[01]$/.test(pod.name))
        await probes.startEditor(pod, `${config.release}-ha-backend-${pod.name.endsWith('-0') ? 1 : 0}`);
    },
    applyTemplates: (_work, guards) => gate.apply(mergeRuntimeControlGuards(values, guards), 'candidate-template.json'),
    restoreAutoscalers: (_work, guards) =>
      gate.apply(
        {
          ...mergeRuntimeControlGuards(values, guards),
          workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } },
        },
        'candidate-final.json',
      ),
  });
  await Promise.all(probes.editors.map((p) => p.completed));
  for (const probe of probes.editors) {
    assert.equal(probe.error, null);
    assert.equal(probe.receipt?.phase, 'passed');
  }
  assert.equal(resumed, true);
  const browserReceipt = await browser.finish(before, { frontendReplacement: false });
  await gate.artifact('developer-overlap-browser.json', JSON.stringify(browserReceipt, null, 2));
  running = false;
  await sampler;
  if (samplerError) throw samplerError;
  // Cooperative scale-up may retain an execution surge after the deployment
  // journal completes. Observe the real safe-retirement controller settling;
  // never manually shrink it or equate Helm completion with idle capacity.
  const baselineDeadline = Date.now() + 600000;
  let pods;
  while (true) {
    pods = await gate.pods();
    if (
      pods.length === 7 &&
      pods.every(
        (p) =>
          !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
      )
    )
      break;
    if (Date.now() >= baselineDeadline)
      throw Error('Local autoscaler did not safely settle to seven ready pods within ten minutes.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal(pods.length, 7, 'six application pods plus the independent autoscaler');
  await gate.artifact(
    'developer-overlap-result.json',
    JSON.stringify(
      {
        outcome: 'passed',
        scope: 'local-functional-only',
        baseline,
        candidate,
        namespaceUid: gate.namespaceUid,
        pods: pods.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid })),
        editorProbes: probes.editors.map((p) => p.receipt),
        browser: browserReceipt,
      },
      null,
      2,
    ),
  );
  console.log(`Actual mixed-image backend overlap and retained browser passed: ${folder}`);
} catch (error) {
  await fs.writeFile(path.join(folder, 'failure.json'), JSON.stringify({ error: error.message }));
  console.error(`Local overlap check failed: ${error.message}`);
  throw error;
} finally {
  running = false;
  await sampler?.catch(() => {});
  await browser?.close();
  await gate.capture('terminal').catch(() => {});
  await gate.close();
  await gate.deleteOwnedNamespace();
}
