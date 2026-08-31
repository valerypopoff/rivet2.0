import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildPublishedCapacityGateConfig,
  redactPublishedCapacityGateConfig,
} from './lib/kubernetes-published-capacity-gate-config.mjs';
import { imageReference } from './lib/kubernetes-managed-provider-gate-config.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runnerName = 'kubernetes-published-capacity-gate';
const fixturePath = path.join(
  rootDir,
  'deploy',
  'studio-server',
  'scripts',
  'fixtures',
  'managed-release-gate.rivet-project',
);
const fixtureProjectId = '230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b';
const fixtureGraphId = '59701e85-9052-43e1-a71d-af698ef7c1fe';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveKubectlBin(env) {
  return String(env.KUBECTL_BIN ?? '').trim() || (process.platform === 'win32' ? 'kubectl.exe' : 'kubectl');
}

function run(command, args, { cwd = rootDir, input, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(
          new Error(`[${runnerName}] ${command} ${args.join(' ')} failed with ${result.exitCode}: ${stderr || stdout}`),
        );
        return;
      }
      resolve(capture || allowFailure ? result : undefined);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`[${runnerName}] ${description} did not return JSON`);
  }
}

function metricSum(text, metricName) {
  const pattern = new RegExp(
    `^${metricName}(?:\\{[^}]*\\})?\\s+([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)$`,
    'u',
  );
  let matched = false;
  let total = 0;
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(pattern);
    if (!match) continue;
    matched = true;
    total += Number(match[1]);
  }
  return matched ? total : undefined;
}

async function observePrometheus(prometheus) {
  const values = {};
  const errors = [];
  const observations = await Promise.all(
    Object.entries(prometheus.queries).map(async ([name, query]) => {
      try {
        const url = new URL('/api/v1/query', prometheus.baseUrl);
        url.searchParams.set('query', query);
        const response = await fetch(url, {
          headers: prometheus.headers,
          signal: AbortSignal.timeout(15_000),
        });
        const responseBody = await response.json().catch(() => null);
        const result = responseBody?.status === 'success' ? responseBody.data?.result : null;
        if (
          !response.ok ||
          responseBody?.data?.resultType !== 'vector' ||
          !Array.isArray(result) ||
          result.length !== 1 ||
          !Array.isArray(result[0]?.value) ||
          typeof result[0].value[1] !== 'string' ||
          !Number.isFinite(Number(result[0].value[1]))
        ) {
          return { name, value: null };
        }
        return { name, value: Number(result[0].value[1]) };
      } catch {
        return { name, value: null };
      }
    }),
  );
  for (const observation of observations) {
    if (observation.value === null) {
      errors.push(observation.name);
    } else {
      values[observation.name] = observation.value;
    }
  }
  return { available: errors.length === 0, values, errors };
}

function safeRunToken() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

function getBearerSigningKey(headers) {
  const authorization = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+([^\s]+)$/iu) : null;
  if (!match) {
    throw new Error(
      '[kubernetes-published-capacity-gate] protected endpoint capacity testing requires provider requestHeaders.authorization to be the RIVET_KEY bearer value.',
    );
  }
  return match[1];
}

export function createCapacityCapabilityToken({ signingKey, endpoints, nowMs = Date.now(), lifetimeSeconds }) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 10_800) {
    throw new Error('Capacity capability lifetime must be an integer from 1 to 10800 seconds.');
  }
  const iat = Math.floor(nowMs / 1_000);
  const payload = {
    v: 1,
    iat,
    exp: iat + lifetimeSeconds,
    endpoints: [...new Set(endpoints)],
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey)
    .update('rivet-capacity-v1.' + encodedPayload)
    .digest('base64url');
  return 'rivet-capacity-v1.' + encodedPayload + '.' + signature;
}

export function createCapacityFixtureContents(template, { title, delayMs }) {
  if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > 60_000)
    throw new Error('Capacity fixture delay must be an integer from 1 to 60000 milliseconds.');
  const projectId = randomUUID();
  const graphId = randomUUID();
  const content = template
    .replaceAll(fixtureProjectId, projectId)
    .replaceAll(fixtureGraphId, graphId)
    .replace('delay: 300', `delay: ${delayMs}`)
    .replace('title: Managed release gate', `title: ${title}`);
  if (
    content.includes(fixtureProjectId) ||
    content.includes(fixtureGraphId) ||
    !content.includes(`delay: ${delayMs}`) ||
    !content.includes(`title: ${title}`)
  ) {
    throw new Error('Capacity fixture template no longer has the expected isolated main graph shape.');
  }
  return content;
}

export function renderPublishedCapacityJob({
  namespace,
  name,
  image,
  registrySecretName,
  configMapName,
  authorizationSecretName,
  timeoutSeconds,
}) {
  const authorizationEnvironment = authorizationSecretName
    ? [
        '          env:',
        '            - name: RIVET_CAPACITY_BEARER_TOKEN',
        '              valueFrom:',
        '                secretKeyRef:',
        '                  name: ' + authorizationSecretName,
        '                  key: token',
        '',
      ].join('\n')
    : '';
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: ${runnerName}
    app.kubernetes.io/part-of: rivet-published-capacity-gate
spec:
  backoffLimit: 0
  activeDeadlineSeconds: ${timeoutSeconds}
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/part-of: rivet-published-capacity-gate
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      imagePullSecrets:
        - name: ${registrySecretName}
      containers:
        - name: load
          image: ${image}
          imagePullPolicy: Always
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          command: ["node"]
          args: ["/app/packages/studio-server-api/dist/studio-server-api/src/scripts/published-capacity-load.js", "--config", "/config/config.json"]
${authorizationEnvironment}          volumeMounts:
            - name: config
              mountPath: /config
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
      volumes:
        - name: config
          configMap:
            name: ${configMapName}
`;
}

function requestUrl(baseUrl, route) {
  return new URL(route, baseUrl).toString();
}

async function requestJson(baseUrl, route, { method = 'GET', body, headers = {}, timeoutMs = 30_000 } = {}) {
  const response = await fetch(requestUrl(baseUrl, route), {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  if (!response.ok)
    throw new Error(
      `[${runnerName}] ${method} ${route} returned ${response.status}: ${typeof value === 'string' ? value.slice(0, 300) : JSON.stringify(value)}`,
    );
  return value;
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string' ||
    !value.endsWith('.rivet-project') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`[${runnerName}] workflow upload returned an unsafe relative path`);
  }
  return value;
}

export function isTerminalJob(job) {
  const conditions = job.status?.conditions ?? [];
  return conditions.some(
    (condition) => (condition.type === 'Complete' || condition.type === 'Failed') && condition.status === 'True',
  );
}

function jobSucceeded(job) {
  return (job.status?.conditions ?? []).some(
    (condition) => condition.type === 'Complete' && condition.status === 'True',
  );
}

function parseLoadReport(logs) {
  const marker = logs.split(/\r?\n/u).find((line) => line.startsWith('RIVET_CAPACITY_REPORT='));
  if (!marker) throw new Error(`[${runnerName}] load Job did not emit its capacity report marker`);
  try {
    return JSON.parse(Buffer.from(marker.slice('RIVET_CAPACITY_REPORT='.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error(`[${runnerName}] load Job emitted an invalid capacity report`);
  }
}

function validateLoadReport(report, config) {
  const failures = [];
  if (!report || report.version !== 1 || !Array.isArray(report.stages)) {
    return ['load Job emitted an invalid capacity report'];
  }
  if (report.stages.length !== config.capacity.stages.length) {
    return ['load Job report does not contain exactly the configured capacity stages'];
  }
  for (const [index, expected] of config.capacity.stages.entries()) {
    const stage = report.stages[index];
    if (!stage || stage.name !== expected.name || stage.scenario !== expected.scenario) {
      failures.push(`load Job report stage ${index + 1} does not match configured stage ${expected.name}`);
      continue;
    }
    if (stage.requested !== expected.requests || stage.completed !== expected.requests) {
      failures.push(`${expected.name} did not complete exactly ${expected.requests} requests`);
    }
    if (
      !Number.isFinite(stage.requestTimings?.p95Ms) ||
      stage.requestTimings.p95Ms < 0 ||
      stage.requestTimings.count !== expected.requests
    ) {
      failures.push(`${expected.name} is missing complete request timing evidence`);
    }
    const outcomeNames = [
      'succeeded',
      'capacityRejected',
      'serverErrors',
      'clientErrors',
      'networkErrors',
      'timeouts',
      'unexpected',
    ];
    const outcomeValues = outcomeNames.map((name) => stage.outcomes?.[name]);
    if (!outcomeValues.every((value) => Number.isInteger(value) && value >= 0)) {
      failures.push(`${expected.name} has invalid request outcome evidence`);
    } else if (outcomeValues.reduce((total, value) => total + value, 0) !== expected.requests) {
      failures.push(`${expected.name} request outcomes do not account for every requested execution`);
    }
    const expectedCanaries = Math.floor(expected.requests / config.capacity.controlCanaryEveryRequests);
    if (
      !Number.isInteger(stage.controlCanaries?.attempted) ||
      stage.controlCanaries.attempted < 0 ||
      !Number.isInteger(stage.controlCanaries?.succeeded) ||
      stage.controlCanaries.succeeded < 0 ||
      !Number.isInteger(stage.controlCanaries?.failures) ||
      stage.controlCanaries.failures < 0 ||
      stage.controlCanaries.attempted !== expectedCanaries ||
      stage.controlCanaries.succeeded + stage.controlCanaries.failures !== expectedCanaries ||
      stage.controlCanaries.timings?.count !== expectedCanaries
    ) {
      failures.push(`${expected.name} has incomplete control-canary evidence`);
    }
  }
  return failures;
}

export function evaluateCapacityCertificate(report, snapshots, config) {
  const failures = validateLoadReport(report, config);
  if (failures.length > 0) return failures;
  for (const [index, stage] of report.stages.entries()) {
    const expectedStage = config.capacity.stages[index];
    const p95Limit = config.capacity.thresholds.maximumP95Ms[stage.name];
    if (stage.requestTimings.p95Ms > p95Limit)
      failures.push(`${stage.name} p95 ${stage.requestTimings.p95Ms}ms exceeds ${p95Limit}ms`);
    const unexpectedRate = stage.requested === 0 ? 1 : stage.outcomes.unexpected / stage.requested;
    if (unexpectedRate > config.capacity.thresholds.maximumUnexpectedRate)
      failures.push(
        `${stage.name} unexpected-rate ${unexpectedRate.toFixed(4)} exceeds ${config.capacity.thresholds.maximumUnexpectedRate}`,
      );
    const canaryRate =
      stage.controlCanaries.attempted === 0 ? 0 : stage.controlCanaries.failures / stage.controlCanaries.attempted;
    if (canaryRate > config.capacity.thresholds.maximumControlCanaryFailureRate)
      failures.push(
        `${stage.name} control-canary failure-rate ${canaryRate.toFixed(4)} exceeds ${config.capacity.thresholds.maximumControlCanaryFailureRate}`,
      );
    if (expectedStage.expect === 'overload' && stage.outcomes.capacityRejected === 0)
      failures.push(`${stage.name} expected visible admission rejection but observed none`);
  }
  const workloadSnapshots = snapshots.filter((snapshot) => !snapshot.baseline && snapshot.podCount > 0);
  if (config.capacity.requireExecutionMetrics && workloadSnapshots.length === 0)
    failures.push('no execution pod was observed while the capacity Job was running');
  else if (config.capacity.requireExecutionMetrics && workloadSnapshots.some((snapshot) => !snapshot.metricsAvailable))
    failures.push('execution metrics were unavailable for one or more execution-pod samples');
  if (snapshots.some((snapshot) => !snapshot.eventsAvailable))
    failures.push('execution pod events were unavailable for one or more samples');
  const baseline = snapshots[0];
  const baselineRestartCounts = baseline?.restartCountsByPod ?? {};
  if (
    baseline &&
    snapshots
      .slice(1)
      .some((snapshot) =>
        Object.entries(snapshot.restartCountsByPod ?? {}).some(
          ([podName, restartCount]) => Number(restartCount) > Number(baselineRestartCounts[podName] ?? 0),
        ),
      )
  )
    failures.push('execution pod restart observed during capacity run');
  if (
    baseline &&
    snapshots.some((snapshot) => snapshot.oomKilledPods.some((pod) => !baseline.oomKilledPods.includes(pod)))
  )
    failures.push('execution pod OOMKilled during capacity run');
  if (baseline && snapshots.some((snapshot) => snapshot.evictedPods.some((pod) => !baseline.evictedPods.includes(pod))))
    failures.push('execution pod eviction observed during capacity run');
  if (config.capacity.prometheus) {
    const observedSnapshots = snapshots.filter((snapshot) => !snapshot.baseline && snapshot.podCount > 0);
    if (observedSnapshots.length === 0) {
      failures.push('no execution-pod sample was available for Prometheus high-water observations');
    } else if (
      observedSnapshots.some(
        (snapshot) =>
          snapshot.prometheus?.available !== true ||
          !Number.isFinite(snapshot.prometheus.values?.memoryHighWaterBytes) ||
          !Number.isFinite(snapshot.prometheus.values?.nodeEphemeralHighWaterBytes) ||
          !Number.isFinite(snapshot.prometheus.values?.downstreamConcurrency),
      )
    ) {
      failures.push('Prometheus high-water observations were unavailable for one or more execution-pod samples');
    }
  }
  const recordingDropsObserved = snapshots.at(-1)?.recordingDropsObserved ?? 0;
  if (recordingDropsObserved > config.capacity.thresholds.maximumRecordingDrops)
    failures.push(
      `recording drops increased by ${recordingDropsObserved}, above ${config.capacity.thresholds.maximumRecordingDrops}`,
    );
  return failures;
}

export function createCapacityEvidence({
  mode,
  phase,
  completed,
  report,
  snapshots,
  certificate,
  failure,
  cleanupFailure,
}) {
  const evaluated = report !== undefined;
  return {
    version: 1,
    mode,
    status: completed && !failure && !cleanupFailure ? 'completed' : 'failed',
    phase,
    report: report ?? null,
    snapshots,
    certificate: {
      evaluated,
      passed: evaluated && certificate.length === 0,
      failures: certificate,
    },
    failure: failure
      ? {
          phase,
          kind: failure instanceof Error ? failure.name : 'Error',
        }
      : null,
    cleanup: {
      attempted: true,
      succeeded: !cleanupFailure,
      failureKind: cleanupFailure ? (cleanupFailure instanceof Error ? cleanupFailure.name : 'Error') : null,
    },
  };
}

export function createPublishedCapacityLoadJobConfig({ serviceNamePrefix, namespace, jobName, capacity }) {
  const proxyBaseUrl = `http://${serviceNamePrefix}-proxy.${namespace}.svc.cluster.local`;
  const controlBaseUrl = `http://${serviceNamePrefix}-api.${namespace}.svc.cluster.local`;
  return {
    version: 1,
    proxyBaseUrl,
    controlBaseUrl,
    requestTimeoutMs: capacity.requestTimeoutMs,
    controlCanaryEveryRequests: capacity.controlCanaryEveryRequests,
    controlCanaryTimeoutMs: capacity.controlCanaryTimeoutMs,
    scenarios: getCapacityFixtureEndpoints(jobName).map((endpoint, index) => ({
      name: index === 0 ? 'fast' : 'long',
      endpoint,
      body: { input: index === 0 ? 'capacity-fast' : 'capacity-long' },
    })),
    stages: capacity.stages,
  };
}

export function getCapacityFixtureEndpoints(jobName) {
  return [jobName + '-fast', jobName + '-long'];
}
export class PublishedCapacityGate {
  constructor(config, kubectlBin, helmBin) {
    this.config = config;
    this.kubectlBin = kubectlBin;
    this.helmBin = helmBin;
    this.runToken = safeRunToken();
    this.jobName = `rivet-capacity-${this.runToken}`;
    this.configMapName = `${this.jobName}-config`;
    this.authorizationSecretName = `${this.jobName}-authorization`;
    this.capacityBearerToken = null;
    this.fixturePaths = [];
    this.snapshots = [];
    this.baselineRecordingDropsByPod = new Map();
    this.recordingDropsObserved = 0;
    this.tempDir = null;
  }

  kubectl(args, options) {
    return run(this.kubectlBin, ['--context', this.config.context, ...args], options);
  }

  async artifact(name, content) {
    const target = path.join(this.config.artifactsDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  async assertTarget() {
    const current = (await run(this.kubectlBin, ['config', 'current-context'], { capture: true })).stdout.trim();
    if (current !== this.config.context || current !== this.config.allowedContext) {
      throw new Error(
        `[${runnerName}] refusing kube context ${JSON.stringify(current)}; both configured staging contexts must match it`,
      );
    }
    const manifest = await run(
      this.helmBin,
      ['get', 'manifest', this.config.release, '--namespace', this.config.namespace],
      { capture: true },
    );
    for (const [component, image] of Object.entries(this.config.images)) {
      if (!manifest.stdout.includes(imageReference(image)))
        throw new Error(`[${runnerName}] ${component} is not deployed from the configured immutable candidate digest`);
    }
    if (
      this.config.capacity.requireExecutionMetrics &&
      !/name:\s*RIVET_DEPLOYMENT_METRICS_ENABLED\s*\n\s*value:\s*["']true["']/u.test(manifest.stdout)
    ) {
      throw new Error(`[${runnerName}] staging chart must set metrics.enabled=true before capacity certification`);
    }
    const registrySecret = await this.kubectl(
      ['get', 'secret', this.config.registry.secretName, '-n', this.config.namespace],
      { capture: true, allowFailure: true },
    );
    if (registrySecret.exitCode !== 0)
      throw new Error(
        `[${runnerName}] required image pull secret ${this.config.registry.secretName} is unavailable in staging`,
      );
    const endpointAuth = await requestJson(this.config.baseUrl, '/api/app-settings/workflow-endpoint-auth', {
      headers: this.config.requestHeaders,
    });
    if (endpointAuth?.requireBearerAuth !== false) {
      this.capacityBearerToken = createCapacityCapabilityToken({
        signingKey: getBearerSigningKey(this.config.requestHeaders),
        endpoints: getCapacityFixtureEndpoints(this.jobName),
        lifetimeSeconds: Math.min(10_800, this.config.capacity.jobTimeoutSeconds + 600),
      });
    }
  }

  async publishFixtures() {
    const template = await fs.readFile(fixturePath, 'utf8');
    for (const [scenario, delayMs] of [
      ['fast', 75],
      ['long', 1_500],
    ]) {
      const fileName = `${this.jobName}-${scenario}.rivet-project`;
      const endpointName = `${this.jobName}-${scenario}`;
      const upload = await requestJson(this.config.baseUrl, '/api/workflows/projects/upload', {
        method: 'POST',
        headers: this.config.requestHeaders,
        body: {
          folderRelativePath: '',
          fileName,
          contents: createCapacityFixtureContents(template, {
            title: `Capacity ${scenario} ${this.runToken}`,
            delayMs,
          }),
        },
      });
      const relativePath = safeRelativePath(upload?.project?.relativePath);
      this.fixturePaths.push(relativePath);
      await requestJson(this.config.baseUrl, '/api/workflows/projects/publish', {
        method: 'POST',
        headers: this.config.requestHeaders,
        body: { relativePath, settings: { endpointName } },
      });
    }
  }

  async prepareJob({ onBeforeLoadStart } = {}) {
    const loadConfig = createPublishedCapacityLoadJobConfig({
      serviceNamePrefix: this.config.capacity.serviceNamePrefix ?? this.config.release,
      namespace: this.config.namespace,
      jobName: this.jobName,
      capacity: this.config.capacity,
    });
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-capacity-gate-'));
    const configPath = path.join(this.tempDir, 'config.json');
    await fs.writeFile(configPath, `${JSON.stringify(loadConfig, null, 2)}\n`, 'utf8');
    await this.kubectl(
      [
        'create',
        'configmap',
        this.configMapName,
        '-n',
        this.config.namespace,
        `--from-file=config.json=${configPath}`,
        '--dry-run=client',
        '-o',
        'yaml',
      ],
      { capture: true },
    ).then((result) => this.kubectl(['apply', '-f', '-'], { input: result.stdout }));
    if (this.capacityBearerToken) {
      const secretPath = path.join(this.tempDir, 'capacity-bearer-token');
      await fs.writeFile(secretPath, this.capacityBearerToken, { encoding: 'utf8', mode: 0o600 });
      await this.kubectl(
        [
          'create',
          'secret',
          'generic',
          this.authorizationSecretName,
          '-n',
          this.config.namespace,
          '--from-file=token=' + secretPath,
          '--dry-run=client',
          '-o',
          'yaml',
        ],
        { capture: true },
      ).then((result) => this.kubectl(['apply', '-f', '-'], { input: result.stdout }));
    }
    await this.snapshot({ baseline: true });
    // All temporary configuration is ready, while no public-load Job exists
    // yet. A joint certificate uses this exact boundary to prove its durable
    // Evaluation trial is active before any capacity traffic can start.
    await onBeforeLoadStart?.();
    await this.kubectl(['apply', '-f', '-'], {
      input: renderPublishedCapacityJob({
        namespace: this.config.namespace,
        name: this.jobName,
        image: imageReference(this.config.images.api),
        registrySecretName: this.config.registry.secretName,
        configMapName: this.configMapName,
        authorizationSecretName: this.capacityBearerToken ? this.authorizationSecretName : undefined,
        timeoutSeconds: this.config.capacity.jobTimeoutSeconds,
      }),
    });
  }

  async snapshot({ baseline = false } = {}) {
    const pods =
      parseJson(
        (
          await this.kubectl(
            [
              'get',
              'pods',
              '-n',
              this.config.namespace,
              '-l',
              `app.kubernetes.io/instance=${this.config.release},app.kubernetes.io/component=execution`,
              '-o',
              'json',
            ],
            { capture: true },
          )
        ).stdout,
        'execution pod list',
      ).items ?? [];
    const snapshot = {
      at: new Date().toISOString(),
      baseline,
      podCount: pods.length,
      restartCount: 0,
      restartCountsByPod: {},
      oomKilledPods: [],
      evictedPods: [],
      metricsAvailable: true,
      eventsAvailable: true,
      metrics: { activeRuns: 0, admissionLimit: 0, recordingQueueDepth: 0 },
      recordingDropsByPod: {},
      recordingDropsObserved: 0,
      prometheus: null,
      metricErrors: [],
      eventErrors: [],
    };
    for (const pod of pods) {
      let podRestartCount = 0;
      for (const status of pod.status?.containerStatuses ?? []) {
        podRestartCount += Number(status.restartCount ?? 0);
        const reason = status.lastState?.terminated?.reason ?? status.state?.terminated?.reason;
        if (reason === 'OOMKilled') snapshot.oomKilledPods.push(pod.metadata.name);
        if (reason === 'Evicted') snapshot.evictedPods.push(pod.metadata.name);
      }
      snapshot.restartCount += podRestartCount;
      snapshot.restartCountsByPod[pod.metadata.name] = podRestartCount;
      const metric = await this.kubectl(
        ['get', '--raw', `/api/v1/namespaces/${this.config.namespace}/pods/${pod.metadata.name}:8080/proxy/metrics`],
        { capture: true, allowFailure: true },
      );
      if (metric.exitCode !== 0) {
        snapshot.metricsAvailable = false;
        snapshot.metricErrors.push(`metrics unavailable for ${pod.metadata.name}`);
        continue;
      }
      const activeRuns = metricSum(metric.stdout, 'rivet_published_execution_active_runs');
      const admissionLimit = metricSum(metric.stdout, 'rivet_published_execution_admission_limit');
      const recordingDrops = metricSum(metric.stdout, 'rivet_workflow_recording_persistence_dropped_total');
      const recordingQueueDepth = metricSum(metric.stdout, 'rivet_workflow_recording_persistence_queue_depth');
      if (
        activeRuns === undefined ||
        admissionLimit === undefined ||
        recordingDrops === undefined ||
        recordingQueueDepth === undefined
      ) {
        snapshot.metricsAvailable = false;
        snapshot.metricErrors.push(`required metrics missing from ${pod.metadata.name}`);
        continue;
      }
      snapshot.metrics.activeRuns += activeRuns;
      snapshot.metrics.admissionLimit += admissionLimit;
      snapshot.metrics.recordingQueueDepth += recordingQueueDepth;
      snapshot.recordingDropsByPod[pod.metadata.name] = recordingDrops;
    }
    const events = await this.kubectl(['get', 'events', '-n', this.config.namespace, '-o', 'json'], {
      capture: true,
      allowFailure: true,
    });
    if (events.exitCode !== 0) {
      snapshot.eventsAvailable = false;
      snapshot.eventErrors.push('execution pod events are unavailable');
    } else {
      const serviceNamePrefix = this.config.capacity.serviceNamePrefix ?? this.config.release;
      for (const event of parseJson(events.stdout, 'execution pod events').items ?? []) {
        if (
          event.reason === 'Evicted' &&
          String(event.involvedObject?.name ?? '').startsWith(`${serviceNamePrefix}-execution-`)
        )
          snapshot.evictedPods.push(event.involvedObject.name);
      }
    }
    if (pods.length === 0) snapshot.metricsAvailable = false;
    if (this.config.capacity.prometheus) {
      snapshot.prometheus = await observePrometheus(this.config.capacity.prometheus);
    }
    if (baseline) {
      for (const [podName, drops] of Object.entries(snapshot.recordingDropsByPod)) {
        this.baselineRecordingDropsByPod.set(podName, drops);
      }
    } else {
      const dropsSinceBaseline = Object.entries(snapshot.recordingDropsByPod).reduce(
        (total, [podName, drops]) => total + Math.max(0, drops - (this.baselineRecordingDropsByPod.get(podName) ?? 0)),
        0,
      );
      this.recordingDropsObserved = Math.max(this.recordingDropsObserved, dropsSinceBaseline);
    }
    snapshot.recordingDropsObserved = this.recordingDropsObserved;
    this.snapshots.push(snapshot);
  }

  async waitForJob() {
    const deadline = Date.now() + this.config.capacity.jobTimeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      await this.snapshot();
      const job = parseJson(
        (await this.kubectl(['get', 'job', this.jobName, '-n', this.config.namespace, '-o', 'json'], { capture: true }))
          .stdout,
        'capacity Job',
      );
      if (isTerminalJob(job)) {
        if (!jobSucceeded(job))
          throw new Error(`[${runnerName}] load Job failed: ${JSON.stringify(job.status?.conditions ?? [])}`);
        return;
      }
      await sleep(this.config.capacity.sampleIntervalMs);
    }
    throw new Error(`[${runnerName}] capacity Job did not complete within ${this.config.capacity.jobTimeoutSeconds}s`);
  }

  async collectReport() {
    const logs = await this.kubectl(['logs', this.jobName, '-n', this.config.namespace], { capture: true });
    await this.artifact('load-job.log', logs.stdout);
    return parseLoadReport(logs.stdout);
  }

  async captureDiagnostics(stage) {
    for (const [index, args] of [
      ['get', 'pods', '-n', this.config.namespace, '-o', 'wide'],
      ['get', 'events', '-n', this.config.namespace, '--sort-by=.metadata.creationTimestamp'],
      ['describe', 'job', this.jobName, '-n', this.config.namespace],
    ].entries()) {
      const result = await this.kubectl(args, { capture: true, allowFailure: true });
      await this.artifact(`${stage}/kubectl-${index}.log`, `${result.stdout}\n${result.stderr}`);
    }
  }

  async cleanup() {
    const results = await Promise.allSettled([
      this.kubectl(['delete', 'job', this.jobName, '-n', this.config.namespace, '--ignore-not-found=true']),
      this.kubectl(['delete', 'configmap', this.configMapName, '-n', this.config.namespace, '--ignore-not-found=true']),
      this.kubectl([
        'delete',
        'secret',
        this.authorizationSecretName,
        '-n',
        this.config.namespace,
        '--ignore-not-found=true',
      ]),
      ...this.fixturePaths.map((relativePath) =>
        requestJson(this.config.baseUrl, '/api/workflows/projects', {
          method: 'DELETE',
          headers: this.config.requestHeaders,
          body: { relativePath },
        }),
      ),
    ]);
    if (this.tempDir) await fs.rm(this.tempDir, { recursive: true, force: true });
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new Error(
        `[${runnerName}] cleanup failed for ${failures.length} temporary staging resource(s): ${failures.map((failure) => String(failure.reason)).join('; ')}`,
      );
    }
  }
}

/**
 * Run one isolated published-endpoint capacity experiment. The hosted
 * Evaluation certificate imports this operation instead of copying its
 * publish/job/cleanup sequence, so both certificates apply exactly the same
 * target, admission, metric, and evidence rules.
 */
export async function runPublishedCapacityGate({
  config,
  kubectlBin = resolveKubectlBin(process.env),
  helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName }),
  onBeforeLoadStart,
  onLoadCompleted,
} = {}) {
  if (!config) throw new Error(`[${runnerName}] config is required`);
  const gate = new PublishedCapacityGate(config, kubectlBin, helmBin);
  await fs.mkdir(config.artifactsDir, { recursive: true });
  await gate.artifact('config.json', `${JSON.stringify(redactPublishedCapacityGateConfig(config), null, 2)}\n`);
  let report;
  let certificate = [];
  let phase = 'assert-target';
  let completed = false;
  let failure;
  try {
    await gate.assertTarget();
    phase = 'publish-fixtures';
    await gate.publishFixtures();
    phase = 'prepare-job';
    await gate.prepareJob({ onBeforeLoadStart });
    phase = 'wait-for-job';
    await gate.waitForJob();
    // This is the precise end of public load. Keep a joint caller's liveness
    // proof here, before report parsing, diagnostics, or cleanup can consume
    // the Evaluation trial's deliberately bounded duration.
    await onLoadCompleted?.();
    phase = 'collect-report';
    report = await gate.collectReport();
    phase = 'evaluate-certificate';
    certificate = evaluateCapacityCertificate(report, gate.snapshots, config);
    phase = 'capture-diagnostics';
    await gate.captureDiagnostics(certificate.length === 0 ? 'success' : 'threshold-failure');
    if (config.mode === 'certify' && certificate.length > 0)
      throw new Error(`[${runnerName}] capacity certificate failed: ${certificate.join('; ')}`);
    completed = true;
    console.log(
      `[${runnerName}] ${config.mode === 'certify' ? 'capacity certificate passed' : 'capacity observations completed'}`,
    );
  } catch (error) {
    failure = error;
    await gate
      .captureDiagnostics('failure')
      .catch((captureError) => console.error(`[${runnerName}] diagnostic capture failed:`, captureError));
  } finally {
    let cleanupFailure;
    try {
      await gate.cleanup();
    } catch (error) {
      cleanupFailure = error;
    }
    let evidenceFailure;
    try {
      await gate.artifact(
        'capacity-report.json',
        `${JSON.stringify(
          createCapacityEvidence({
            mode: config.mode,
            phase,
            completed,
            report,
            snapshots: gate.snapshots,
            certificate,
            failure,
            cleanupFailure,
          }),
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      evidenceFailure = error;
    }
    const evidence = createCapacityEvidence({
      mode: config.mode,
      phase,
      completed,
      report,
      snapshots: gate.snapshots,
      certificate,
      failure,
      cleanupFailure,
    });
    const finalFailures = [failure, cleanupFailure, evidenceFailure].filter(Boolean);
    if (finalFailures.length === 1) throw finalFailures[0];
    if (finalFailures.length > 1)
      throw new AggregateError(finalFailures, `[${runnerName}] capacity gate failed during execution or finalization`);
    return evidence;
  }
}

async function main() {
  const config = buildPublishedCapacityGateConfig({ rootDir });
  await runPublishedCapacityGate({ config });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
