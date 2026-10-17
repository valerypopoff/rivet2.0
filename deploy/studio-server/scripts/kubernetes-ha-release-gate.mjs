import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { ManagedReleaseGate, runManagedGateCommand as run } from './kubernetes-managed-release-gate.mjs';
import {
  buildManagedReleaseGateConfig,
  renderManagedReleaseGateValues,
} from './lib/kubernetes-managed-release-gate-config.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { runHaKubernetesRollout } from './lib/ha-kubernetes-rollout.mjs';
import { HaReleaseProbes, haProofTimeoutMs } from './lib/ha-release-probes.mjs';
import {
  assertStudioServerReleaseManifest,
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  assertStudioServerReleasePredecessor,
} from './lib/studio-server-release-manifest.mjs';
import { createHaReleaseEvidence, selectHaBrowserContract, HA_BROWSER_CONTRACT } from './lib/ha-release-evidence.mjs';
import { verifyHaReleaseRecovery } from './lib/ha-release-recovery-probes.mjs';
import { startHaWorkflowTraffic } from './lib/ha-workflow-traffic.mjs';
import { startHaBrowserProbe, publishHaBrowserBaseline, waitForHaFrontendReplacement } from './lib/ha-browser-probe.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const chart = path.join(rootDir, 'deploy/studio-server/helm');
const overlay = path.join(chart, 'overlays/managed-release-gate.yaml');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Certification validates an unpromoted candidate before any fixture mutation.
 * Deployment callers keep the identity helpers' promoted-only default. */
export function validateHaCertificationManifest(manifest, { rootDir, sourceSha, images, previous = null }) {
  const candidate = assertStudioServerReleaseManifest(manifest);
  if (candidate.state !== 'candidate') throw Error('HA certification requires a candidate release manifest.');
  assertReleaseManifestMatchesCurrentSource(candidate, sourceSha, { requirePromoted: false });
  assertReleaseManifestMatchesCurrentChart(candidate, rootDir, { requirePromoted: false });
  if (!isDeepStrictEqual(candidate.images, images)) throw Error('HA images must match the candidate manifest');
  assertStudioServerReleasePredecessor(candidate, previous);
  const mode =
    previous?.evidence?.ha?.protocol === 3 &&
    previous.evidence.ha.browserContract.protocol === HA_BROWSER_CONTRACT &&
    !isDeepStrictEqual(previous.images, candidate.images)
      ? 'mixed'
      : 'bootstrap';
  return { candidate, mode, browserContract: selectHaBrowserContract(candidate, previous) };
}

/** Extends the real managed release fixture; never creates a second importer,
 * storage fixture or public execution engine. */
export class HaReleaseGate extends ManagedReleaseGate {
  async assertLocalContext() {
    if (
      !['rivet-ha-proof', 'kind-rivet-managed-release'].includes(this.config.context) ||
      this.config.context !== this.config.allowedContext
    )
      throw new Error('HA gate is restricted to an explicitly allowed disposable local cluster.');
    const disk = await fs.statfs(rootDir);
    if (disk.bavail * disk.bsize < 20 * 1024 ** 3)
      throw new Error('HA rehearsal requires at least 20 GiB free on the workspace drive before any cluster mutation.');
    await this.kubectl(['cluster-info'], { capture: true });
  }
  values(images = this.config.images) {
    const config = { ...this.config, images };
    return {
      ...renderManagedReleaseGateValues(config),
      ha: { enabled: true, protocol: 1, peerLimit: 4 },
      replicaCount: { backend: 2, execution: 2 },
      hostedEvaluations: { enabled: true, workerConcurrency: 1 },
      // The shared managed gate deliberately uses preStop=0 to interrupt a
      // socket. HA must allow Service endpoint withdrawal before nginx exits.
      lifecycle: { preStopDelaySeconds: 5, shutdownGraceSeconds: 120, terminationGracePeriodSeconds: 150 },
      postgres: { ...renderManagedReleaseGateValues(config).postgres, maxConnections: 250 },
      availability: { topologySpread: { whenUnsatisfiable: 'ScheduleAnyway' } },
      legacyRestore: { enabled: true, size: '8Gi' },
      resources: Object.fromEntries(
        ['api', 'backend', 'execution', 'evaluation'].map((role) => [
          role,
          { requests: { cpu: '100m', memory: '256Mi' } },
        ]),
      ),
    };
  }
  async apply(values, name = 'ha-values.json') {
    const file = path.join(this.config.artifactsDir, name);
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(values));
    await run(this.helmBin, [
      '--kube-context',
      this.config.context,
      'upgrade',
      '--install',
      this.config.release,
      chart,
      '-n',
      this.config.namespace,
      '-f',
      overlay,
      '-f',
      file,
      '--wait',
      '--wait-for-jobs',
      '--timeout',
      '600s',
    ]);
    return file;
  }
  async prepare(images = this.config.images) {
    await this.assertLocalContext();
    const existing = await this.kubectl(
      ['get', 'namespace', this.config.namespace, '--ignore-not-found', '-o', 'name'],
      { capture: true },
    );
    if (existing.stdout.trim())
      throw Error(
        'HA preparation requires a fresh disposable namespace. Existing accepted work and Secrets were not changed.',
      );
    await this.createNamespace();
    await this.createRegistrySecret();
    await this.installDependencies();
    await this.apply(this.values(images));
    const baseUrl = await this.openProxy();
    const state = await this.exercisePersistence(baseUrl);
    await this.artifact('ha-persisted-state.json', JSON.stringify(state, null, 2));
    return { baseUrl, state };
  }
  async openProxy() {
    // A kubectl Service forward is pinned to one chosen pod. Keep that test
    // transport separate from chart-owned proxies so replacing a proxy really
    // tests Service availability, not the lifetime of a port-forward subprocess.
    const name = `${this.config.release}-ha-edge`;
    const labels = { 'rivet-ha-test-edge': name };
    const config =
      'pid /tmp/nginx.pid; events {} http { client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; ' +
      'map $http_x_rivet_ha_probe_id $ha_probe { "" 0; default 1; } ' +
      'log_format ha_probe escape=json \'{"at":"$time_iso8601","requestId":"$http_x_rivet_ha_probe_id","status":"$status","elapsed":"$request_time","upstream":"$upstream_addr","upstreamStatus":"$upstream_status","connect":"$upstream_connect_time","headers":"$upstream_header_time","response":"$upstream_response_time"}\'; ' +
      'access_log /dev/stdout ha_probe if=$ha_probe; error_log /dev/stderr; server { listen 8080; location / { proxy_pass http://' +
      this.config.release +
      '-proxy:80; proxy_http_version 1.1; proxy_set_header Host $http_host; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 600s; } } }';
    const resources = [
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data: { 'nginx.conf': config } },
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, labels },
        spec: {
          containers: [
            {
              name: 'edge',
              image: `${this.config.images.proxy.repository}@${this.config.images.proxy.digest}`,
              imagePullPolicy: this.config.imagePullPolicy,
              command: ['nginx', '-c', '/etc/ha-edge/nginx.conf', '-g', 'daemon off;'],
              volumeMounts: [{ name: 'config', mountPath: '/etc/ha-edge', readOnly: true }],
              readinessProbe: { tcpSocket: { port: 8080 } },
              resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '64Mi' } },
            },
          ],
          imagePullSecrets: [{ name: 'rivet-release-gate-registry' }],
          volumes: [{ name: 'config', configMap: { name } }],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name },
        spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
      },
    ];
    // The test edge is never part of the release's rolling workload inventory.
    const existing = await this.kubectl(
      ['-n', this.config.namespace, 'get', 'pod', name, '--ignore-not-found', '-o', 'name'],
      { capture: true },
    );
    if (!existing.stdout.trim())
      await this.kubectl(['-n', this.config.namespace, 'apply', '-f', '-'], {
        input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }),
      });
    await this.kubectl(['-n', this.config.namespace, 'wait', '--for=condition=Ready', `pod/${name}`, '--timeout=90s']);
    return super.openProxy(`service/${name}`);
  }
  async loadWorkflowKey() {
    const secret = JSON.parse(
      (
        await this.kubectl(['-n', this.config.namespace, 'get', 'secret', 'rivet-release-gate-auth', '-o', 'json'], {
          capture: true,
        })
      ).stdout,
    );
    this.secrets = { rivetKey: Buffer.from(secret.data.RIVET_KEY, 'base64').toString('utf8') };
  }
  async assertProofContext() {
    await this.assertLocalContext();
  }
  async roll(baseUrl, images = this.config.images, browserContract = null) {
    return runHaReleaseRollout(this, baseUrl, images, browserContract);
  }
}

/** Force actual template replacement even when a bootstrap proof reuses images.
 * Preserve operator annotations; this marker belongs only to disposable proofs. */
export function withHaProofGeneration(values) {
  const generation = randomUUID();
  return {
    ...values,
    podAnnotations: {
      ...values.podAnnotations,
      ...Object.fromEntries(
        ['web', 'proxy', 'backend', 'execution'].map((role) => [
          role,
          { ...values.podAnnotations?.[role], 'rivet.dev/ha-proof-generation': generation },
        ]),
      ),
    },
  };
}

/** The same rollout observations for local and explicitly protected provider fixtures. */
export async function runHaReleaseRollout(gate, baseUrl, images = gate.config.images, browserContract = null) {
  await gate.assertProofContext();
  await gate.loadWorkflowKey();
  const values = withHaProofGeneration(gate.values(images)),
    file = path.join(gate.config.artifactsDir, 'ha-candidate.json');
  const before = JSON.parse(
    (
      await gate.kubectl(
        [
          '-n',
          gate.config.namespace,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/instance=${gate.config.release}`,
          '-o',
          'json',
        ],
        { capture: true },
      )
    ).stdout,
  ).items;
  await gate.artifact('ha-original-pods.json', JSON.stringify(before, null, 2));
  await fs.writeFile(file, JSON.stringify(values));
  const rendered = await run(
    gate.helmBin,
    [
      '--kube-context',
      gate.config.context,
      'template',
      gate.config.release,
      chart,
      '-n',
      gate.config.namespace,
      ...(gate.config.proofValuesFiles ?? [overlay]).flatMap((file) => ['-f', file]),
      '-f',
      file,
    ],
    { capture: true },
  );
  const resources = parseAllDocuments(rendered.stdout)
    .map((d) => {
      if (d.errors.length) throw d.errors[0];
      return d.toJSON();
    })
    .filter(Boolean);
  const probes = new HaReleaseProbes(gate, baseUrl, rootDir);
  await probes.prepare();
  const baselineReference = before
    .find((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'web')
    ?.spec.containers.find((c) => c.name === 'web')?.image;
  const [repository, digest] = baselineReference?.split('@') ?? [];
  const baselineImage = browserContract?.baseline.image ?? { repository, digest };
  const baseline = await publishHaBrowserBaseline(gate, baselineImage);
  const browser = await startHaBrowserProbe(gate, baseUrl, rootDir, { template: probes.template });
  let oldestBrowser;
  try {
    oldestBrowser = await startHaBrowserProbe(gate, baseUrl, rootDir, {
      template: probes.template,
      build: baseline.build,
      label: 'oldest',
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
  let running = true;
  const traffic = startHaWorkflowTraffic(gate, baseUrl);
  const { failures } = traffic.report;
  const readiness = [];
  const readySampler = (async () => {
    while (running) {
      try {
        const pods = JSON.parse(
          (
            await gate.kubectl(
              [
                '-n',
                gate.config.namespace,
                'get',
                'pods',
                '-l',
                `app.kubernetes.io/instance=${gate.config.release},app.kubernetes.io/component=backend`,
                '-o',
                'json',
              ],
              { capture: true },
            )
          ).stdout,
        ).items;
        const count = pods.filter(
          (p) =>
            !p.metadata.deletionTimestamp &&
            p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
        ).length;
        readiness.push({ at: new Date().toISOString(), ready: count });
        if (count < 2) failures.push(`Only ${count} ordinary backends ready`);
      } catch (error) {
        failures.push(`Readiness observation failed: ${error}`);
      }
      await pause(1000);
    }
  })();
  let rollout, workloadReport;
  let frontendReplaced = false;
  try {
    const kubectl = (args, extra = {}) =>
      gate.kubectl(['-n', gate.config.namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
    rollout = await runHaKubernetesRollout({
      kube: kubectl,
      release: gate.config.release,
      namespace: gate.config.namespace,
      manifestDigest: images.api.digest,
      resources,
      timeoutMs: haProofTimeoutMs(gate.config),
      artifact: (name, value) => gate.artifact(name, value),
      beforeRetirement: async (pod) => {
        if (!frontendReplaced) {
          await waitForHaFrontendReplacement(gate, before, haProofTimeoutMs(gate.config));
          await browser.resumeAfterFrontendReplacement();
          await oldestBrowser.resumeAfterFrontendReplacement();
          frontendReplaced = true;
        }
        await probes.beforeRetirement(pod);
      },
      afterWithdrawal: (pod) => probes.afterWithdrawal(pod),
      applyTemplates: async (_workloads, guardedValues) => {
        await gate.apply(
          {
            ...values,
            ...guardedValues,
            ha: { ...values.ha, ...guardedValues.ha },
            autoscaling: { execution: { enabled: false } },
          },
          'ha-rollout-values.json',
        );
      },
      restoreAutoscalers: async (_workloads, guardedValues) =>
        gate.apply(
          {
            ...values,
            ...guardedValues,
            ha: { ...values.ha, ...guardedValues.ha },
            workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } },
          },
          'ha-completed-values.json',
        ),
    });
    workloadReport = await probes.finish();
    workloadReport.browser = await browser.finish(before);
    workloadReport.oldestBrowser = { ...(await oldestBrowser.finish(before)), image: baselineImage };
    while (traffic.report.samples < 100 && !failures.length) await pause(25);
  } finally {
    running = false;
    await Promise.all([traffic.stop(), readySampler]);
    await browser.close();
    await oldestBrowser.close();
    await gate.artifact('ha-traffic.json', JSON.stringify({ ...traffic.report, readiness }, null, 2));
    await gate.artifact('ha-workload-probes.json', JSON.stringify(probes.snapshot(), null, 2));
  }
  if (failures.length) throw new Error(`HA traffic had ${failures.length} failures: ${failures[0]}`);
  const after = JSON.parse(
    (
      await gate.kubectl(
        [
          '-n',
          gate.config.namespace,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/instance=${gate.config.release}`,
          '-o',
          'json',
        ],
        { capture: true },
      )
    ).stdout,
  ).items;
  const report = { ...traffic.report, readiness, workloads: workloadReport, rollout, before, after, browserContract };
  await gate.artifact('ha-report.json', JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const config = buildManagedReleaseGateConfig({ rootDir, mode: 'smoke' });
  config.keepNamespace = true;
  const gate = new HaReleaseGate(
    config,
    process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl',
    resolveHelmBinOrThrow(rootDir),
  );
  let completed = false;
  try {
    if (process.argv[2] === 'prepare') {
      await gate.prepare();
      await gate.capture('ha-prepared');
    } else if (process.argv[2] === 'roll') {
      await gate.assertLocalContext();
      const baseUrl = await gate.openProxy();
      await gate.roll(baseUrl);
      await gate.capture('ha-completed');
    } else if (process.argv[2] === 'recovery') {
      await gate.assertLocalContext();
      await gate.loadWorkflowKey();
      const baseUrl = await gate.openProxy();
      await verifyHaReleaseRecovery(gate, baseUrl, rootDir);
      await gate.capture('ha-recovery-completed');
    } else if (process.argv[2] === 'certify') {
      const manifest = JSON.parse(await fs.readFile(process.env.RIVET_HA_CANDIDATE_MANIFEST, 'utf8'));
      const sha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
      await run('git', ['diff', '--quiet', 'HEAD', '--']);
      const previous = process.env.RIVET_HA_PREDECESSOR_MANIFEST
        ? assertStudioServerReleaseManifest(
            JSON.parse(await fs.readFile(process.env.RIVET_HA_PREDECESSOR_MANIFEST, 'utf8')),
            { requirePromoted: true },
          )
        : null;
      const { candidate, mode, browserContract } = validateHaCertificationManifest(manifest, {
        rootDir,
        sourceSha: sha,
        images: config.images,
        previous,
      });
      const prepared = await gate.prepare(mode === 'mixed' ? previous.images : candidate.images);
      const report = await gate.roll(prepared.baseUrl, config.images, browserContract);
      report.recovery = await verifyHaReleaseRecovery(gate, prepared.baseUrl, rootDir);
      await gate.artifact('ha-report.json', JSON.stringify(report, null, 2));
      const evidence = createHaReleaseEvidence(report, candidate, mode);
      await gate.artifact('ha-evidence.json', JSON.stringify(evidence, null, 2));
      await gate.capture('ha-certified');
    } else
      throw new Error(
        'Choose prepare, roll, recovery or certify explicitly. Mixed certification requires exact manifests.',
      );
    completed = true;
  } catch (error) {
    await gate.capture('ha-failure').catch(() => {});
    throw error;
  } finally {
    await gate.close();
    if (completed) console.log('[ha-release-gate] Phase passed. Proof namespace retained for inspection.');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
