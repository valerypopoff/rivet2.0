import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertManagedRestoreDriverReport,
  assertManagedRestoreIntegrityReport,
  buildManagedRestoreDrillConfig,
  releaseImagesForRestore,
} from './lib/kubernetes-managed-restore-drill-config.mjs';
import {
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  createProductionHelmValues,
} from './lib/studio-server-release-manifest.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runnerName = 'kubernetes-managed-restore-drill';
const ownershipLabel = 'rivet.restore-drill/owned';
const roleLabel = 'rivet.restore-drill/role';
const reportMarkers = {
  restore: 'RIVET_RESTORE_DRIVER_REPORT=',
  integrity: 'RIVET_RESTORE_INTEGRITY_REPORT=',
};

function renderRestoreNamespace(namespace) {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    ${ownershipLabel}: "true"
`;
}

function renderRegistrySecret(namespace, registry) {
  const auth = Buffer.from(`${registry.username}:${registry.password}`).toString('base64');
  const dockerConfig = Buffer.from(JSON.stringify({ auths: { [registry.server]: { auth } } })).toString('base64');
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${registry.secretName}
  namespace: ${namespace}
  labels:
    ${ownershipLabel}: "true"
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${dockerConfig}
`;
}

function resolveKubectlBin(env) {
  return String(env.KUBECTL_BIN ?? 'kubectl').trim() || 'kubectl';
}

function commandLine(command, args) {
  return [command, ...args].map((value) => (/\s|"/u.test(value) ? JSON.stringify(value) : value)).join(' ');
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, { cwd = rootDir, input, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(
          new Error(
            `[${runnerName}] ${commandLine(command, args)} failed with ${result.exitCode}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(capture || allowFailure ? result : undefined);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function parseRestoreDriverJsonMarker(logs, marker, description) {
  const value = logs
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(marker))
    .at(-1)
    ?.slice(marker.length);
  if (!value) throw new Error(`[${runnerName}] ${description} did not emit ${marker}<JSON>`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`[${runnerName}] ${description} emitted invalid JSON after ${marker}`);
  }
}

export function assertRestoreDriverManifest(resources, { namespace, driver }) {
  const items = resources?.kind === 'List' ? resources.items ?? [] : [resources];
  if (items.length !== 1) {
    throw new Error(`[${runnerName}] ${driver.role} driver manifest must contain exactly one Job`);
  }
  const job = items[0];
  if (
    job?.apiVersion !== 'batch/v1' ||
    job?.kind !== 'Job' ||
    job?.metadata?.namespace !== namespace ||
    job?.metadata?.name !== driver.jobName ||
    job?.metadata?.labels?.[ownershipLabel] !== 'true' ||
    job?.metadata?.labels?.[roleLabel] !== driver.role ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.template?.spec?.restartPolicy !== 'Never'
  ) {
    throw new Error(
      `[${runnerName}] ${driver.role} driver must be one batch/v1 Job in ${namespace}, named ${driver.jobName}, labelled for this drill, with backoffLimit 0 and restartPolicy Never`,
    );
  }
}

export function getRestoreDriverJobState(job) {
  const status = job?.status;
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const completed = conditions.find((condition) => condition?.type === 'Complete' && condition?.status === 'True');
  if (completed || Number(status?.succeeded) > 0) return { state: 'completed' };

  const failed = conditions.find((condition) => condition?.type === 'Failed' && condition?.status === 'True');
  if (failed || Number(status?.failed) > 0) {
    return {
      state: 'failed',
      reason: String(failed?.message ?? failed?.reason ?? 'Job reported one or more failed Pods'),
    };
  }
  return { state: 'running' };
}

export function measureRestoreObjectives({
  startedAtMs,
  completedAtMs,
  databaseRecoveryPointAt,
  objectStorageRecoveryPointAt,
}) {
  return {
    achievedRpoSeconds: Math.max(
      0,
      Math.floor(
        (startedAtMs - Math.min(Date.parse(databaseRecoveryPointAt), Date.parse(objectStorageRecoveryPointAt))) / 1_000,
      ),
    ),
    achievedRtoSeconds: Math.max(0, Math.ceil((completedAtMs - startedAtMs) / 1_000)),
  };
}

export function createRestoreFailureReport({ startedAt, target, failureStage, failedAt = new Date().toISOString() }) {
  return {
    formatVersion: 1,
    status: 'failed',
    startedAt,
    failedAt,
    failureStage,
    message: `Restore drill failed during ${failureStage}. Inspect protected operator logs for details.`,
    target,
  };
}

export function createRestoreProbeRequest({ baseUrl, requestHeaders, probe }) {
  return {
    url: new URL(probe.path, baseUrl),
    init: {
      method: probe.method,
      // A restore probe must prove the declared disposable host itself. Following
      // a redirect could otherwise make a misrouted target appear healthy.
      redirect: 'error',
      headers: {
        accept: 'application/json, text/html;q=0.9',
        ...requestHeaders,
        ...(probe.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
      signal: AbortSignal.timeout(45_000),
    },
  };
}

function redactConfig(config) {
  return {
    backup: config.backup,
    target: config.target,
    objectives: config.objectives,
    probes: Object.fromEntries(
      Object.entries(config.probes).map(([name, probe]) => [
        name,
        { ...probe, body: probe.body === undefined ? undefined : '<redacted request body>' },
      ]),
    ),
    drivers: {
      restore: { jobName: config.restoreDriver.jobName, timeoutSeconds: config.restoreDriver.timeoutSeconds },
      integrity: { jobName: config.integrityDriver.jobName, timeoutSeconds: config.integrityDriver.timeoutSeconds },
      cleanup: { jobName: config.cleanupDriver.jobName, timeoutSeconds: config.cleanupDriver.timeoutSeconds },
    },
    registrySecretName: config.registry.secretName,
  };
}

class ManagedRestoreDrill {
  constructor(config, { kubectlBin, helmBin }) {
    this.config = config;
    this.kubectlBin = kubectlBin;
    this.helmBin = helmBin;
    this.tempDir = null;
    this.releaseValuesFile = null;
    this.namespaceCreated = false;
    this.restoreDriverStarted = false;
  }

  kubectl(args, options) {
    return run(this.kubectlBin, ['--context', this.config.context, ...args], options);
  }

  async artifact(name, content) {
    const filePath = path.join(this.config.artifactsDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  async assertContext() {
    const current = (await run(this.kubectlBin, ['config', 'current-context'], { capture: true })).stdout.trim();
    if (current !== this.config.context || current !== this.config.allowedContext) {
      throw new Error(
        `[${runnerName}] refusing kube context ${JSON.stringify(current)}; both restore-drill context values must match it`,
      );
    }
  }

  async assertReleaseIdentity() {
    const workingTree = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { capture: true });
    if (workingTree.stdout.trim()) {
      throw new Error(
        `[${runnerName}] refusing a dirty checkout; run the restore drill only from the clean promoted checkout named by the backup manifest`,
      );
    }
    const currentSourceSha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
    assertReleaseManifestMatchesCurrentChart(this.config.backup.release, rootDir);
    assertReleaseManifestMatchesCurrentSource(this.config.backup.release, currentSourceSha);
  }

  async prepareValues() {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-restore-drill-'));
    this.releaseValuesFile = path.join(this.tempDir, 'restore-release-values.json');
    const values = createProductionHelmValues(this.config.backup.release);
    values.images = releaseImagesForRestore(this.config.backup.release);
    values.imagePullSecrets = [{ name: this.config.registry.secretName }];
    await fs.writeFile(this.releaseValuesFile, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  }

  async createFreshNamespace() {
    const existing = await this.kubectl(['get', 'namespace', this.config.target.namespace, '-o', 'json'], {
      capture: true,
      allowFailure: true,
    });
    if (existing.exitCode === 0) {
      throw new Error(
        `[${runnerName}] refusing to reuse restore namespace ${this.config.target.namespace}; the target must be fresh`,
      );
    }
    if (!/NotFound|not found/iu.test(`${existing.stdout}\n${existing.stderr}`)) {
      throw new Error(
        `[${runnerName}] could not determine whether restore namespace ${this.config.target.namespace} is fresh`,
      );
    }
    // Set the ownership label in the create request. A separate create-then-label
    // sequence leaves a window where teardown cannot safely establish ownership.
    this.namespaceCreated = true;
    await this.kubectl(['create', '-f', '-'], { input: renderRestoreNamespace(this.config.target.namespace) });
  }

  async createRegistrySecret() {
    await this.kubectl(['apply', '-f', '-'], {
      input: renderRegistrySecret(this.config.target.namespace, this.config.registry),
    });
  }

  async validateDriver(driver, manifest) {
    const result = await this.kubectl(['create', '--dry-run=client', '--output', 'json', '-f', '-'], {
      capture: true,
      input: manifest,
    });
    let resources;
    try {
      resources = JSON.parse(result.stdout);
    } catch {
      throw new Error(`[${runnerName}] ${driver.role} driver manifest did not produce Kubernetes JSON`);
    }
    assertRestoreDriverManifest(resources, { namespace: this.config.target.namespace, driver });
  }

  async runDriver(driver, { marker, startedAt } = {}) {
    const manifest = await fs.readFile(driver.applyFile, 'utf8');
    await this.validateDriver(driver, manifest);
    if (driver.role === 'restore') this.restoreDriverStarted = true;
    await this.kubectl(['apply', '-f', '-'], { input: manifest });
    await this.waitForDriver(driver);
    if (!marker) return undefined;
    const logs = await this.kubectl(
      ['logs', '-n', this.config.target.namespace, `job/${driver.jobName}`, '--all-containers=true'],
      { capture: true },
    );
    const rawReport = parseRestoreDriverJsonMarker(logs.stdout, marker, `${driver.role} driver Job ${driver.jobName}`);
    return driver.role === 'restore'
      ? assertManagedRestoreDriverReport(rawReport, {
          backup: this.config.backup,
          target: this.config.target,
          startedAt,
        })
      : assertManagedRestoreIntegrityReport(rawReport);
  }

  async waitForDriver(driver) {
    const deadline = Date.now() + driver.timeoutSeconds * 1_000;
    let lastStatus = 'Job is still pending';
    while (Date.now() <= deadline) {
      const result = await this.kubectl(
        ['get', 'job', driver.jobName, '-n', this.config.target.namespace, '--output', 'json'],
        { capture: true, allowFailure: true },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `[${runnerName}] could not read ${driver.role} driver Job ${driver.jobName}: ${result.stderr || result.stdout}`,
        );
      }
      let job;
      try {
        job = JSON.parse(result.stdout);
      } catch {
        throw new Error(`[${runnerName}] ${driver.role} driver Job ${driver.jobName} did not return Kubernetes JSON`);
      }
      const state = getRestoreDriverJobState(job);
      if (state.state === 'completed') return;
      if (state.state === 'failed') {
        throw new Error(`[${runnerName}] ${driver.role} driver Job ${driver.jobName} failed: ${state.reason}`);
      }
      lastStatus = 'Job is still pending or running';
      await pause(Math.min(5_000, Math.max(250, deadline - Date.now())));
    }
    throw new Error(`[${runnerName}] ${driver.role} driver Job ${driver.jobName} timed out: ${lastStatus}`);
  }

  async deployRelease() {
    await run(this.helmBin, [
      'upgrade',
      '--install',
      this.config.target.release,
      'deploy/studio-server/helm',
      '--namespace',
      this.config.target.namespace,
      '--values',
      this.config.valuesFile,
      '--values',
      this.releaseValuesFile,
      '--atomic',
      '--wait',
      '--wait-for-jobs',
      '--timeout',
      '15m',
    ]);
  }

  async request(name, probe) {
    const { url, init } = createRestoreProbeRequest({
      baseUrl: this.config.target.baseUrl,
      requestHeaders: this.config.requestHeaders,
      probe,
    });
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.status !== probe.expectedStatus) {
      throw new Error(`[${runnerName}] ${name} probe returned ${response.status}, expected ${probe.expectedStatus}`);
    }
    if (!text.includes(probe.contains)) {
      throw new Error(`[${runnerName}] ${name} probe did not include its required non-secret marker`);
    }
  }

  async verifyDurableSurfaces() {
    await this.request('readiness', { path: '/readyz', method: 'GET', expectedStatus: 200, contains: 'ready' });
    for (const [name, probe] of Object.entries(this.config.probes)) await this.request(name, probe);
  }

  async capture(stage) {
    if (!this.namespaceCreated) return;
    const commands = [
      ['get', 'all', '-n', this.config.target.namespace, '-o', 'wide'],
      ['get', 'events', '-n', this.config.target.namespace, '--sort-by=.metadata.creationTimestamp'],
      ['describe', 'pods', '-n', this.config.target.namespace],
      ['get', 'ingress', '-n', this.config.target.namespace, '-o', 'yaml'],
    ];
    for (const [index, args] of commands.entries()) {
      const result = await this.kubectl(args, { capture: true, allowFailure: true });
      await this.artifact(`${stage}/kubectl-${index}.log`, `${result.stdout}\n${result.stderr}`);
    }
    // Driver logs may contain provider diagnostics. Keep only their parsed,
    // non-secret reports in the uploaded artifact set.
  }

  async cleanup() {
    if (!this.namespaceCreated) return;
    const namespace = await this.kubectl(['get', 'namespace', this.config.target.namespace, '--output', 'json'], {
      capture: true,
      allowFailure: true,
    });
    if (namespace.exitCode !== 0) {
      if (/NotFound|not found/iu.test(`${namespace.stdout}\n${namespace.stderr}`)) return;
      throw new Error(
        `[${runnerName}] could not confirm restore namespace ownership during cleanup: ${namespace.stderr || namespace.stdout}`,
      );
    }
    let labels;
    try {
      labels = JSON.parse(namespace.stdout)?.metadata?.labels;
    } catch {
      throw new Error(`[${runnerName}] restore namespace ownership check did not return Kubernetes JSON`);
    }
    if (labels?.[ownershipLabel] !== 'true') {
      throw new Error(
        `[${runnerName}] refusing cleanup because namespace ${this.config.target.namespace} is no longer marked as restore-drill owned`,
      );
    }
    const errors = [];
    const uninstall = await run(
      this.helmBin,
      [
        'uninstall',
        this.config.target.release,
        '--namespace',
        this.config.target.namespace,
        '--wait',
        '--timeout',
        '5m',
      ],
      { capture: true, allowFailure: true },
    );
    if (uninstall.exitCode !== 0 && !/release: not found/iu.test(`${uninstall.stdout}\n${uninstall.stderr}`)) {
      errors.push(`Helm uninstall failed: ${uninstall.stderr || uninstall.stdout}`);
    }
    if (this.restoreDriverStarted) {
      try {
        await this.runDriver(this.config.cleanupDriver);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const deletion = await this.kubectl(['delete', 'namespace', this.config.target.namespace, '--wait=false'], {
      capture: true,
      allowFailure: true,
    });
    const namespaceMissing = /NotFound|not found/iu.test(`${deletion.stdout}\n${deletion.stderr}`);
    if (deletion.exitCode !== 0 && !namespaceMissing) {
      errors.push(`namespace deletion failed: ${deletion.stderr || deletion.stdout}`);
    }
    if (!namespaceMissing) {
      const deletionWait = await this.kubectl(
        ['wait', '--for=delete', `namespace/${this.config.target.namespace}`, '--timeout=300s'],
        { capture: true, allowFailure: true },
      );
      if (
        deletionWait.exitCode !== 0 &&
        !/NotFound|not found/iu.test(`${deletionWait.stdout}\n${deletionWait.stderr}`)
      ) {
        errors.push(`namespace deletion did not finish: ${deletionWait.stderr || deletionWait.stdout}`);
      }
    }
    if (errors.length > 0) throw new Error(`[${runnerName}] cleanup did not complete: ${errors.join('\n')}`);
  }

  async close() {
    if (this.tempDir) await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const config = buildManagedRestoreDrillConfig({ rootDir });
  const drill = new ManagedRestoreDrill(config, {
    kubectlBin: resolveKubectlBin(process.env),
    helmBin: resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName }),
  });
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let report;
  let primaryError;
  let failureStage = 'prepare restore drill';
  await fs.mkdir(config.artifactsDir, { recursive: true });
  await drill.artifact('input.json', `${JSON.stringify(redactConfig(config), null, 2)}\n`);
  try {
    failureStage = 'verify Kubernetes context';
    await drill.assertContext();
    failureStage = 'verify promoted release identity';
    await drill.assertReleaseIdentity();
    failureStage = 'prepare restore release values';
    await drill.prepareValues();
    failureStage = 'create fresh restore target';
    await drill.createFreshNamespace();
    await drill.createRegistrySecret();
    failureStage = 'restore provider backup';
    const restore = await drill.runDriver(config.restoreDriver, { marker: reportMarkers.restore, startedAt });
    failureStage = 'deploy restored release';
    await drill.deployRelease();
    failureStage = 'verify restored durable surfaces';
    await drill.verifyDurableSurfaces();
    failureStage = 'verify cross-store integrity';
    const integrity = await drill.runDriver(config.integrityDriver, { marker: reportMarkers.integrity });
    const finishedAt = new Date().toISOString();
    const { achievedRpoSeconds, achievedRtoSeconds } = measureRestoreObjectives({
      startedAtMs,
      completedAtMs: Date.now(),
      databaseRecoveryPointAt: config.backup.database.recoveryPointAt,
      objectStorageRecoveryPointAt: config.backup.objectStorage.recoveryPointAt,
    });
    failureStage = 'evaluate recovery objectives';
    if (achievedRpoSeconds > config.objectives.maximumRpoSeconds) {
      throw new Error(
        `[${runnerName}] achieved RPO ${achievedRpoSeconds}s exceeds the configured maximum ${config.objectives.maximumRpoSeconds}s`,
      );
    }
    if (achievedRtoSeconds > config.objectives.maximumRtoSeconds) {
      throw new Error(
        `[${runnerName}] achieved RTO ${achievedRtoSeconds}s exceeds the configured maximum ${config.objectives.maximumRtoSeconds}s`,
      );
    }
    report = {
      formatVersion: 1,
      status: 'passed',
      startedAt,
      finishedAt,
      achievedRpoSeconds,
      achievedRtoSeconds,
      objectives: config.objectives,
      source: {
        namespace: config.backup.source.namespace,
        release: config.backup.release,
        databaseRecoveryPointId: config.backup.database.recoveryPointId,
        objectStorageRecoveryPointId: config.backup.objectStorage.recoveryPointId,
        encryptionKeyIds: config.backup.appSettings.encryptionKeyIds,
      },
      target: config.target,
      restore,
      integrity,
    };
    await drill.capture('success');
  } catch (error) {
    primaryError = error;
    report = createRestoreFailureReport({ startedAt, target: config.target, failureStage });
    try {
      await drill.capture('failure');
    } catch (captureError) {
      console.error(`[${runnerName}] artifact capture failed:`, captureError);
    }
  } finally {
    let cleanupStatus = drill.namespaceCreated ? 'pending' : 'not-required';
    try {
      await drill.cleanup();
      if (drill.namespaceCreated) cleanupStatus = 'completed';
    } catch (cleanupError) {
      cleanupStatus = 'failed';
      console.error(cleanupError);
      if (!primaryError) {
        primaryError = cleanupError;
        report = createRestoreFailureReport({
          startedAt,
          target: config.target,
          failureStage: 'clean up restore target',
        });
      }
    }
    if (report) {
      report.cleanup = { status: cleanupStatus };
      try {
        await drill.artifact('restore-report.json', `${JSON.stringify(report, null, 2)}\n`);
      } catch (reportError) {
        console.error(`[${runnerName}] restore report write failed:`, reportError);
        if (!primaryError) primaryError = reportError;
      }
    }
    try {
      await drill.close();
    } catch (closeError) {
      console.error(`[${runnerName}] temporary-file cleanup failed:`, closeError);
      if (!primaryError) primaryError = closeError;
    }
  }
  if (primaryError) throw primaryError;
  console.log(
    `[${runnerName}] restore drill passed: RPO ${report.achievedRpoSeconds}s, RTO ${report.achievedRtoSeconds}s`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
