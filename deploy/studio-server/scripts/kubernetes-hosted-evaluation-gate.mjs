import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildManagedProviderGateConfig, imageReference } from './lib/kubernetes-managed-provider-gate-config.mjs';
import { buildPublishedCapacityGateConfig } from './lib/kubernetes-published-capacity-gate-config.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { runPublishedCapacityGate } from './kubernetes-published-capacity-gate.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runnerName = 'kubernetes-hosted-evaluation-gate';
const fixturePath = path.join(
  rootDir,
  'deploy',
  'studio-server',
  'scripts',
  'fixtures',
  'managed-release-gate.rivet-project',
);
const fixtureProjectId = '230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b';
const longGraphId = 'd6d3c1cf-670d-4b8d-bf64-617be4e3df81';
const jointCapacityConfirmation = 'certify-joint-public-evaluation-capacity';

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
        reject(new Error('[' + runnerName + '] ' + command + ' failed with ' + result.exitCode));
        return;
      }
      resolve(capture || allowFailure ? result : undefined);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function assertObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('[' + runnerName + '] ' + name + ' must be an object');
  }
  return value;
}

function parsePositiveInteger(value, name, { minimum, maximum }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('[' + runnerName + '] ' + name + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return value;
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('[' + runnerName + '] ' + name + ' did not return JSON');
  }
}

function readHostedEvaluationGateConfig(configFile) {
  const rawConfig = assertObject(JSON.parse(fsSync.readFileSync(configFile, 'utf8')), 'provider gate config');
  const value = assertObject(rawConfig.hostedEvaluationGate, 'provider gate hostedEvaluationGate');
  const jointCapacity =
    value.jointCapacity == null ? null : assertObject(value.jointCapacity, 'hostedEvaluationGate.jointCapacity');
  return {
    waitSeconds: parsePositiveInteger(value.waitSeconds ?? 240, 'hostedEvaluationGate.waitSeconds', {
      minimum: 60,
      maximum: 1_200,
    }),
    publicProbeRequests: parsePositiveInteger(
      value.publicProbeRequests ?? 8,
      'hostedEvaluationGate.publicProbeRequests',
      {
        minimum: 1,
        maximum: 64,
      },
    ),
    jointCapacity: jointCapacity
      ? {
          trialDelayMs: parsePositiveInteger(
            jointCapacity.trialDelayMs,
            'hostedEvaluationGate.jointCapacity.trialDelayMs',
            {
              minimum: 90_000,
              maximum: 900_000,
            },
          ),
        }
      : null,
  };
}

export function buildHostedEvaluationGateConfig({ rootDir: configuredRootDir, env = process.env } = {}) {
  if (String(env.RIVET_K8S_EVALUATION_GATE_CONFIRM ?? '') !== 'disrupt-staging-evaluations') {
    throw new Error('[' + runnerName + '] RIVET_K8S_EVALUATION_GATE_CONFIRM must equal disrupt-staging-evaluations');
  }
  const provider = buildManagedProviderGateConfig({ rootDir: configuredRootDir, env });
  const hostedEvaluation = readHostedEvaluationGateConfig(provider.configFile);
  const jointRequested = String(env.RIVET_K8S_EVALUATION_JOINT_CAPACITY_CONFIRM ?? '').trim();
  if (jointRequested && jointRequested !== jointCapacityConfirmation) {
    throw new Error(
      '[' + runnerName + '] RIVET_K8S_EVALUATION_JOINT_CAPACITY_CONFIRM must equal ' + jointCapacityConfirmation,
    );
  }
  let jointCapacity = null;
  if (jointRequested) {
    if (!hostedEvaluation.jointCapacity) {
      throw new Error(
        '[' + runnerName + '] hostedEvaluationGate.jointCapacity must be configured for a joint certificate',
      );
    }
    const capacityConfig = buildPublishedCapacityGateConfig({
      rootDir: configuredRootDir,
      env: {
        ...env,
        RIVET_K8S_CAPACITY_GATE_CONFIRM: 'certify-staging',
        RIVET_K8S_CAPACITY_GATE_MODE: 'certify',
      },
    });
    if (capacityConfig.capacity.jobTimeoutSeconds > 840) {
      throw new Error(
        '[' +
          runnerName +
          '] joint capacity certificates require capacity.jobTimeoutSeconds at most 840 so the dedicated Evaluation trial can remain active',
      );
    }
    const requiredTrialDelayMs = capacityConfig.capacity.jobTimeoutSeconds * 1_000 + 60_000;
    if (hostedEvaluation.jointCapacity.trialDelayMs < requiredTrialDelayMs) {
      throw new Error(
        '[' +
          runnerName +
          '] hostedEvaluationGate.jointCapacity.trialDelayMs must be at least capacity.jobTimeoutSeconds plus 60 seconds',
      );
    }
    jointCapacity = { ...hostedEvaluation.jointCapacity, capacityConfig };
  }
  const artifactsDir = path.resolve(provider.artifactsDir, 'hosted-evaluations');
  const relative = path.relative(configuredRootDir, artifactsDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('[' + runnerName + '] hosted Evaluation artifacts must remain inside the repository');
  }
  return { ...provider, hostedEvaluation: { ...hostedEvaluation, jointCapacity }, artifactsDir };
}

export function createHostedEvaluationSubmission({ runId, label }) {
  const datasetId = 'dataset-' + runId;
  const suiteId = 'suite-' + runId;
  return {
    projectContents: null,
    projectPath: '__kubernetes_gate__/' + label + '.rivet-project',
    evaluationData: {
      version: 1,
      suites: [
        {
          id: suiteId,
          name: 'Kubernetes hosted Evaluation gate ' + label,
          targetGraphId: longGraphId,
          datasetId,
          inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
          // This certificate measures durable execution only. A benchmark must
          // not smuggle in a dormant quality requirement.
          assertions: [],
          evaluators: [],
          configuration: { trialCount: 1 },
          thresholds: [],
        },
      ],
      baselines: [],
    },
    dataset: {
      id: datasetId,
      projectId: fixtureProjectId,
      name: 'Kubernetes hosted Evaluation gate dataset ' + label,
      fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true }],
      cases: [{ id: 'case-1', name: 'Case 1', values: { input: 'capacity gate' } }],
    },
    suiteId,
    purpose: 'execution-benchmark',
    runId,
  };
}

export function createHostedEvaluationFixtureContents(template, { trialDelayMs } = {}) {
  if (trialDelayMs == null) return template;
  const marker = 'delay: 60000';
  const occurrences = template.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error('[' + runnerName + '] fixture must contain exactly one immutable long-trial delay marker');
  }
  return template.replace(marker, 'delay: ' + trialDelayMs);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(error) {
  return error instanceof Error ? error.name : 'Error';
}

export function createHostedEvaluationEvidence({
  phase,
  completed,
  runs,
  publicProbe,
  jointCapacity,
  failure,
  cleanupFailure,
}) {
  return {
    version: 1,
    status: completed && !failure && !cleanupFailure ? 'completed' : 'failed',
    phase,
    runs: runs.map(({ id, state }) => ({
      id,
      status: state?.status ?? null,
      jobs: Array.isArray(state?.jobs)
        ? state.jobs.map((job) => ({
            jobId: job.jobId,
            status: job.status,
            attempt: job.attempt,
            acceptedAt: job.acceptedAt ?? null,
            settledAt: job.settledAt ?? null,
          }))
        : [],
    })),
    publicProbe,
    jointCapacity:
      jointCapacity?.requested === true
        ? {
            requested: true,
            status: jointCapacity.status,
            phase: jointCapacity.phase,
            certificatePassed: jointCapacity.certificatePassed,
          }
        : { requested: false },
    failure: failure ? { phase, kind: safeError(failure) } : null,
    cleanup: {
      attempted: true,
      succeeded: !cleanupFailure,
      failureKind: cleanupFailure ? safeError(cleanupFailure) : null,
    },
  };
}

class HostedEvaluationGate {
  constructor(config, kubectlBin, helmBin) {
    this.config = config;
    this.kubectlBin = kubectlBin;
    this.helmBin = helmBin;
    this.runToken = randomUUID().replaceAll('-', '').slice(0, 12);
    this.runs = [];
  }

  kubectl(args, options) {
    return run(this.kubectlBin, ['--context', this.config.context, ...args], options);
  }

  async artifact(name, content) {
    const filePath = path.join(this.config.artifactsDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  async request(route, { method = 'GET', body } = {}) {
    const response = await fetch(new URL(route, this.config.baseUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...this.config.requestHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    return { status: response.status, value, text };
  }

  async requireSuccess(route, options) {
    const result = await this.request(route, options);
    if (result.status < 200 || result.status >= 300) {
      throw new Error('[' + runnerName + '] control request failed with HTTP ' + result.status);
    }
    return result.value;
  }

  async assertTarget() {
    const current = (await run(this.kubectlBin, ['config', 'current-context'], { capture: true })).stdout.trim();
    if (current !== this.config.context || current !== this.config.allowedContext) {
      throw new Error('[' + runnerName + '] refusing unapproved kube context');
    }
    const manifest = await run(
      this.helmBin,
      ['get', 'manifest', this.config.release, '--namespace', this.config.namespace],
      { capture: true },
    );
    if (!manifest.stdout.includes(imageReference(this.config.images.api))) {
      throw new Error('[' + runnerName + '] staging release does not use the configured immutable API digest');
    }
    if (!/app\.kubernetes\.io\/component:\s*evaluation/u.test(manifest.stdout)) {
      throw new Error('[' + runnerName + '] hostedEvaluations.enabled must be enabled in the staged release');
    }
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
              'app.kubernetes.io/instance=' + this.config.release + ',app.kubernetes.io/component=evaluation',
              '-o',
              'json',
            ],
            { capture: true },
          )
        ).stdout,
        'evaluation pod list',
      ).items ?? [];
    if (pods.length !== 1) {
      throw new Error('[' + runnerName + '] disruption certificate requires exactly one evaluation worker replica');
    }
  }

  async submit(label, { trialDelayMs } = {}) {
    const id = 'k8s-evaluation-' + this.runToken + '-' + label;
    const submission = createHostedEvaluationSubmission({ runId: id, label });
    submission.projectContents = createHostedEvaluationFixtureContents(await fs.readFile(fixturePath, 'utf8'), {
      trialDelayMs,
    });
    await this.requireSuccess('/api/workflows/evaluation-runs/hosted', { method: 'POST', body: submission });
    const duplicate = await this.request('/api/workflows/evaluation-runs/hosted', { method: 'POST', body: submission });
    if (duplicate.status !== 409) {
      throw new Error('[' + runnerName + '] duplicate hosted submission was not rejected');
    }
    const run = { id, state: null };
    this.runs.push(run);
    return run;
  }

  async state(run) {
    const value = await this.requireSuccess(
      '/api/workflows/evaluation-runs/' + encodeURIComponent(run.id) + '/hosted-state?projectId=' + fixtureProjectId,
    );
    run.state = value;
    return value;
  }

  async requireAccepted(run, description) {
    const state = await this.state(run);
    if (!state.jobs?.some((job) => job.status === 'accepted')) {
      throw new Error('[' + runnerName + '] joint Evaluation trial was not accepted ' + description);
    }
  }

  async waitFor(run, predicate, description) {
    const deadline = Date.now() + this.config.hostedEvaluation.waitSeconds * 1_000;
    while (Date.now() < deadline) {
      const state = await this.state(run);
      if (predicate(state)) return state;
      await sleep(1_000);
    }
    throw new Error('[' + runnerName + '] timed out waiting for ' + description);
  }

  async deleteAcceptedWorker() {
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
              'app.kubernetes.io/instance=' + this.config.release + ',app.kubernetes.io/component=evaluation',
              '-o',
              'json',
            ],
            { capture: true },
          )
        ).stdout,
        'evaluation pod list',
      ).items ?? [];
    const podName = pods[0]?.metadata?.name;
    if (typeof podName !== 'string' || !podName)
      throw new Error('[' + runnerName + '] evaluation worker pod disappeared before disruption');
    // A regular deletion can honor the pod grace period long enough for the
    // deliberately slow certificate trial to settle successfully. This runner
    // is already protected, requires exactly one Evaluation worker, and owns
    // only generated runs, so force the one selected worker loss we intend to
    // certify. The durable lease/fencing contract must then record
    // interruption rather than allowing an accidental successful completion.
    await this.kubectl([
      'delete',
      'pod',
      podName,
      '-n',
      this.config.namespace,
      '--wait=false',
      '--grace-period=0',
      '--force',
    ]);
  }

  async publicProbe() {
    const samples = [];
    for (let index = 0; index < this.config.hostedEvaluation.publicProbeRequests; index += 1) {
      const response = await this.request(this.config.workflowProbe.path, {
        method: this.config.workflowProbe.method,
        body: this.config.workflowProbe.body,
      });
      samples.push(response.status);
      if (response.status !== this.config.workflowProbe.expectedStatus) {
        throw new Error('[' + runnerName + '] published workflow probe failed during hosted Evaluation work');
      }
      if (!response.text.includes(this.config.workflowProbe.contains)) {
        throw new Error(
          '[' +
            runnerName +
            '] published workflow probe lost its expected response marker during hosted Evaluation work',
        );
      }
    }
    const statusCounts = {};
    for (const status of samples) statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;
    return { requested: samples.length, statusCounts };
  }

  async capture(stage) {
    for (const [index, args] of [
      ['get', 'pods', '-n', this.config.namespace, '-o', 'wide'],
      ['get', 'events', '-n', this.config.namespace, '--sort-by=.metadata.creationTimestamp'],
    ].entries()) {
      const result = await this.kubectl(args, { capture: true, allowFailure: true });
      await this.artifact(stage + '/kubectl-' + index + '.log', result.stdout + '\n' + result.stderr);
    }
  }

  async cleanup() {
    const results = await Promise.allSettled(
      this.runs.map((run) =>
        this.requireSuccess('/api/workflows/evaluation-runs/' + encodeURIComponent(run.id), {
          method: 'DELETE',
          body: { projectId: fixtureProjectId, runId: run.id },
        }),
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new Error('[' + runnerName + '] cleanup could not remove ' + failures.length + ' owned hosted run(s)');
  }
}

async function main() {
  const config = buildHostedEvaluationGateConfig({ rootDir });
  const gate = new HostedEvaluationGate(
    config,
    resolveKubectlBin(process.env),
    resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName }),
  );
  await fs.mkdir(config.artifactsDir, { recursive: true });
  let phase = 'assert-target';
  let completed = false;
  let publicProbe = null;
  let jointCapacity = null;
  let failure;
  try {
    await gate.assertTarget();
    if (config.hostedEvaluation.jointCapacity) {
      phase = 'submit-joint-capacity-run';
      const jointRun = await gate.submit('joint-capacity', {
        trialDelayMs: config.hostedEvaluation.jointCapacity.trialDelayMs,
      });
      await gate.waitFor(
        jointRun,
        (state) => state.jobs?.some((job) => job.status === 'accepted'),
        'joint capacity worker acceptance',
      );
      phase = 'run-joint-published-capacity';
      jointCapacity = { requested: true, status: 'running', phase, certificatePassed: false };
      try {
        const capacityEvidence = await runPublishedCapacityGate({
          config: config.hostedEvaluation.jointCapacity.capacityConfig,
          kubectlBin: gate.kubectlBin,
          helmBin: gate.helmBin,
          onBeforeLoadStart: () => gate.requireAccepted(jointRun, 'immediately before public load began'),
          onLoadCompleted: () => gate.requireAccepted(jointRun, 'when public load completed'),
        });
        jointCapacity = {
          requested: true,
          status: capacityEvidence.status,
          phase: capacityEvidence.phase,
          certificatePassed: capacityEvidence.certificate.evaluated && capacityEvidence.certificate.passed,
        };
      } catch (error) {
        // The capacity runner writes its own sanitized report on every
        // finalization path. Keep this parent report truthful too: it must
        // never imply a still-running or successful joint certificate when
        // its child operation failed before returning evidence.
        jointCapacity = { requested: true, status: 'failed', phase, certificatePassed: false };
        throw error;
      }
      if (!jointCapacity.certificatePassed) {
        throw new Error('[' + runnerName + '] joint published capacity certificate did not pass');
      }
      // The certificate intentionally supports a singleton Evaluation worker.
      // Cancel only the generated joint run after the public experiment so it
      // releases that worker before the independent interruption scenario.
      phase = 'cancel-joint-capacity-run';
      await gate.requireSuccess(
        '/api/workflows/evaluation-runs/' + encodeURIComponent(jointRun.id) + '/cancel-hosted',
        {
          method: 'POST',
          body: { projectId: fixtureProjectId, runId: jointRun.id },
        },
      );
      await gate.waitFor(
        jointRun,
        (state) => state.status === 'canceled' && state.jobs?.length === 1 && state.jobs[0]?.status === 'canceled',
        'joint capacity cancellation',
      );
    }
    phase = 'submit-disruption-run';
    const interrupted = await gate.submit('interruption');
    // The initiating browser can disappear immediately after this durable 202.
    phase = 'wait-for-acceptance';
    await gate.waitFor(
      interrupted,
      (state) => state.jobs?.some((job) => job.status === 'accepted'),
      'durable worker acceptance',
    );
    phase = 'public-probe';
    publicProbe = await gate.publicProbe();
    phase = 'delete-accepted-worker';
    await gate.deleteAcceptedWorker();
    phase = 'wait-for-interruption';
    const interruptedState = await gate.waitFor(
      interrupted,
      (state) => state.status === 'interrupted',
      'accepted worker interruption',
    );
    const interruptedJobIds = interruptedState.jobs
      .filter((job) => job.status === 'interrupted')
      .map((job) => job.jobId);
    if (interruptedJobIds.length !== 1)
      throw new Error('[' + runnerName + '] accepted worker loss did not produce one explicit interrupted trial');
    phase = 'retry-interrupted';
    await gate.requireSuccess(
      '/api/workflows/evaluation-runs/' + encodeURIComponent(interrupted.id) + '/retry-interrupted',
      {
        method: 'POST',
        body: { projectId: fixtureProjectId, runId: interrupted.id, jobIds: interruptedJobIds },
      },
    );
    const completedState = await gate.waitFor(
      interrupted,
      (state) =>
        state.status === 'completed' &&
        state.jobs?.length === 1 &&
        state.jobs[0]?.status === 'settled' &&
        state.jobs[0]?.attempt === 2,
      'one settled second attempt after the selected retry',
    );
    if (completedState.cancelRequested) {
      throw new Error('[' + runnerName + '] selected retry unexpectedly inherited a cancellation request');
    }

    phase = 'submit-cancellation-run';
    const canceled = await gate.submit('cancellation');
    await gate.waitFor(
      canceled,
      (state) => state.jobs?.some((job) => job.status === 'accepted'),
      'cancellation worker acceptance',
    );
    phase = 'cancel-hosted-run';
    await gate.requireSuccess('/api/workflows/evaluation-runs/' + encodeURIComponent(canceled.id) + '/cancel-hosted', {
      method: 'POST',
      body: { projectId: fixtureProjectId, runId: canceled.id },
    });
    const canceledState = await gate.waitFor(
      canceled,
      (state) => state.status === 'canceled' && state.jobs?.length === 1 && state.jobs[0]?.status === 'canceled',
      'durable cancellation without a second trial',
    );
    if (!canceledState.cancelRequested) {
      throw new Error('[' + runnerName + '] canceled hosted run did not retain its cancellation request');
    }
    completed = true;
    await gate.capture('success');
    console.log('[' + runnerName + '] hosted Evaluation disruption certificate passed');
  } catch (error) {
    failure = error;
    await gate.capture('failure').catch(() => undefined);
  } finally {
    let cleanupFailure;
    try {
      await gate.cleanup();
    } catch (error) {
      cleanupFailure = error;
    }
    await gate.artifact(
      'hosted-evaluation-report.json',
      JSON.stringify(
        createHostedEvaluationEvidence({
          phase,
          completed,
          runs: gate.runs,
          publicProbe,
          jointCapacity,
          failure,
          cleanupFailure,
        }),
        null,
        2,
      ) + '\n',
    );
    const failures = [failure, cleanupFailure].filter(Boolean);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, '[' + runnerName + '] hosted Evaluation gate failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
