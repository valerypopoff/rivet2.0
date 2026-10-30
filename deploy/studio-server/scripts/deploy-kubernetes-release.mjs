import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import {
  assertHaUpgradeEvidence,
  assertRuntimeControlEvidence,
  assertCooperativeAutoscalingEvidence,
  assertOrdinaryRuntimeResources,
} from './lib/ha-release-evidence.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  readAvailableReleaseJournal,
  parseReleaseResources,
  assertInstalledReleaseManifest,
  assertInstalledExecutionSettings,
  verifyRetainedCutoverCheckpoint,
  assertCutoverVerificationInventory,
  assertCutoverVerificationTarget,
  assertNoExecutionStartupFences,
} from './lib/deployment-readiness.mjs';
import {
  runHaKubernetesRollout,
  haRolloutAutoscalingValues,
  getHaConfigurationDigest,
} from './lib/ha-kubernetes-rollout.mjs';
import {
  assertContinuityUpgrade,
  assertContinuityConfiguration,
  assertContinuityAcceptance,
  continuityFromResources,
  requestContinuityProfile,
  continuityRecoveryLayout,
} from './lib/request-continuity.mjs';
import { createKubernetesProxyContinuity } from './lib/proxy-continuity-kubernetes.mjs';
import { runHaKubernetesControlTopology } from './lib/ha-kubernetes-control-topology.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
import {
  readMaintenancePlan,
  assertMaintenanceBaseline,
  captureMaintenanceCheckpoint,
  preflightMaintenanceMigration,
} from './lib/maintenance-deployment-plan.mjs';
import {
  waitForReleaseSettlement,
  assertReleaseSettlementCurrent,
  releaseSettlementResourceTypes,
  waitForExecutionAutoscalerActivation,
} from './lib/kubernetes-release-settlement.mjs';
import { createMaintenanceValidationValues, getMaintenanceValidationTargets } from './lib/maintenance-validation.mjs';
import { readDeploymentPolicy, runDeploymentStage, executeDeploymentWorkflow } from './lib/deployment-workflow.mjs';
import { planInstalledUpgrade } from './lib/installed-upgrade-plan.mjs';
import {
  overlapAdoptionAuthority,
  assertOverlapAdoptionInstalled,
  assertOverlapAdoptionResources,
} from './lib/overlap-adoption.mjs';
import { preserveDeploymentFailure } from './lib/deployment-operation.mjs';
import { deploymentFailureDetails } from './lib/deployment-diagnostics.mjs';
import {
  createDeploymentSafety,
  deploymentRecoveryIdentity,
  assertDeploymentBaseline,
  retainedTopologyExecution,
} from './lib/deployment-safety.mjs';
import { randomUUID } from 'node:crypto';
import { parseEnvFile } from './lib/env.mjs';
import { singleMachineConfig, singleMachineValues, prepareSingleMachine } from './lib/single-machine-kubernetes.mjs';
import { productionEnvironment, prepareProductionSecrets } from './lib/server-launch-mode.mjs';
import { renderKubernetesLauncherValuesYaml } from './lib/kubernetes-launcher-config.mjs';
import { pullReleaseManifestArtifact, PRODUCTION_RELEASE_MANIFEST_REFERENCE } from './release-manifest-oci.mjs';

import {
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  assertStudioServerReleaseManifest,
  createForwardRollbackHelmValues,
  createProductionHelmValues,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import { resolveHelmBinOrThrow, findExecutableOnPath } from './lib/k8s-tools.mjs';
import {
  maintenanceValidationValues,
  assertCutoverJournal,
  assertOrdinaryReleaseAllowed,
  blocksCutoverStop,
  requiresMaintenanceCutover,
  runManagedReleaseCutover,
} from './lib/managed-release-cutover.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const chartPath = path.join(rootDir, 'deploy', 'studio-server', 'helm');
const productionOverlayPath = path.join(chartPath, 'overlays', 'prod.yaml');
const runnerName = 'deploy-kubernetes-release';
const supportedOptions = new Set([
  '--release',
  '--namespace',
  '--manifest',
  '--rollback-to',
  '--values',
  '--confirm',
  '--dry-run',
  '--timeout',
  '--artifacts',
  '--maintenance-cutover',
  '--maintenance-plan',
  '--deployment-policy',
  '--plan-only',
  '--acceptance-only',
  '--preflight-only',
  '--verify-only',
  '--resume-cutover',
  '--single-machine',
  '--env-file',
  '--context',
  '--resume-ha',
  '--ha-control-plane-transition',
  '--overlap-adoption-certificate',
  '--overlap-adoption-stage',
]);

export function parseArgs(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument "${key}"`);
    }
    if (!supportedOptions.has(key)) {
      throw new Error(`Unknown option "${key}"`);
    }
    if (options.has(key)) {
      throw new Error(`${key} may only be supplied once`);
    }
    if (
      key === '--dry-run' ||
      key === '--plan-only' ||
      key === '--acceptance-only' ||
      key === '--preflight-only' ||
      key === '--verify-only' ||
      key === '--maintenance-cutover' ||
      key === '--single-machine' ||
      key === '--ha-control-plane-transition'
    ) {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${key} requires a value`);
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function dnsLabel(value, name) {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(value) || value.length > 63) {
    throw new Error(`${name} must be a Kubernetes DNS label of at most 63 characters`);
  }
  return value;
}

export function parseDeploymentTimeout(value) {
  const match = typeof value === 'string' && /^(\d+)(s|m|h)$/u.exec(value);
  const timeoutMs = match ? Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]] : NaN;
  // The same duration reaches Helm, observation loops and the backup timer.
  // Node timers overflow beyond this bound and otherwise fire almost at once.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error(
      '--timeout must be a positive whole-second duration such as 10m or 1h, within the supported timer range.',
    );
  return { timeout: value, timeoutMs };
}

/** Per-operation CAS versions are not reusable installation configuration. */
export function assertNoOperatorRolloutGuards(bytes, options) {
  if (
    ['--env-file', '--plan-only', '--acceptance-only', '--resume-ha', '--resume-cutover'].some((key) =>
      options.has(key),
    )
  )
    return;
  const documents = parseAllDocuments(String(bytes));
  for (const document of documents) {
    if (document.errors.length) throw document.errors[0];
    const versions = document.toJSON()?.ha?.rolloutResourceVersions;
    if (versions && Object.keys(versions).length)
      throw Error(
        'ha.rolloutResourceVersions contains private guards from another operation. Remove them from fresh reviewed operator inputs before deployment; never edit inputs for an unfinished operation. Inspect exact-token recovery instead.',
      );
  }
}

function insideRepository(candidate, name) {
  const resolved = path.resolve(rootDir, candidate);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} must remain inside this repository`);
  }
  return resolved;
}

async function readManifest(manifestPath, { requirePromoted = false } = {}) {
  try {
    return assertStudioServerReleaseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), { requirePromoted });
  } catch (error) {
    throw new Error(
      `Could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertReleaseManifestMatchesCurrentCheckout(manifest) {
  let result;
  try {
    result = await run('git', ['rev-parse', '--verify', 'HEAD'], { capture: true });
  } catch (error) {
    throw new Error(
      `Could not resolve the current Git checkout for release verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertReleaseManifestMatchesCurrentSource(manifest, result.stdout.trim());
}

export async function assertCleanTrackedCheckout() {
  const checks = [
    {
      label: 'unstaged tracked changes',
      args: ['diff', '--quiet', '--exit-code', '--'],
    },
    {
      label: 'staged tracked changes',
      args: ['diff', '--cached', '--quiet', '--exit-code', '--'],
    },
  ];
  for (const check of checks) {
    let result;
    try {
      result = await run('git', check.args, { capture: true, allowFailure: true });
    } catch (error) {
      throw new Error(
        `Could not verify the current Git checkout is clean: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.exitCode === 1) {
      throw new Error(
        `The current checkout has ${check.label}. Production deployment requires the manifest source revision with no tracked local modifications. Commit, stash, or discard those changes before deploying.`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not verify the current Git checkout is clean: git ${check.args.join(' ')} exited with ${result.exitCode}.`,
      );
    }
  }
}

function commandLine(program, args) {
  return [program, ...args].map((value) => (/\s|"/u.test(value) ? JSON.stringify(value) : value)).join(' ');
}

async function run(program, args, { capture = false, allowFailure = false, input } = {}) {
  // Pin every operation, including diagnostics and maintenance cutover, to the
  // selected context. Never change the operator's current kubeconfig context.
  const context = selectedContext;
  if (context && (program === selectedKubectl || program === selectedHelm)) {
    args = [program === selectedHelm ? '--kube-context' : '--context', context, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true,
      stdio: capture ? [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let inputError;
    if (input != null) {
      child.stdin.on('error', (error) => {
        inputError = error;
      });
      child.stdin.end(input);
    }
    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }
    child.once('error', reject);
    // Wait for pipes as well as process exit: journal JSON is an acknowledgement,
    // and truncated output or a broken stdin pipe must not count as success.
    child.once('close', (code) => {
      if (inputError) {
        reject(new Error(`Command input acknowledgement failed: ${commandLine(program, args)}`, { cause: inputError }));
        return;
      }
      const exitCode = code ?? 1;
      const result = { exitCode, stdout, stderr };
      if (exitCode === 0 || allowFailure) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `Command failed with exit code ${exitCode}: ${commandLine(program, args)}${stderr ? `\n${stderr}` : ''}`,
        ),
      );
    });
  });
}

let selectedContext;
let selectedKubectl;
let selectedHelm;
let failureArtifactsDirectory;

async function writeArtifact(artifactsDir, fileName, contents) {
  await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(artifactsDir, fileName), contents, { encoding: 'utf8', mode: 0o600 });
}

/** Release selection is a preflight-only boundary: it has no cluster mutation capabilities. */
export async function resolveDeploymentRelease(
  options,
  artifactsDir,
  {
    pullArtifact = pullReleaseManifestArtifact,
    verifyCheckout = assertReleaseManifestMatchesCurrentCheckout,
    verifyClean = assertCleanTrackedCheckout,
  } = {},
) {
  if (options.has('--rollback-to') && !options.has('--manifest'))
    throw new Error(
      '--rollback-to requires an explicit --manifest for the failed release; the production pointer cannot identify it.',
    );
  const rollbackManifestPath = options.has('--rollback-to')
    ? insideRepository(required(options, '--rollback-to'), '--rollback-to')
    : null;
  let temporaryDirectory;
  try {
    let manifest;
    let identity;
    const manifestPath = options.has('--manifest')
      ? insideRepository(required(options, '--manifest'), '--manifest')
      : path.join(artifactsDir, 'release-manifest.json');
    if (options.has('--manifest')) {
      manifest = await readManifest(manifestPath, { requirePromoted: true });
      identity = { mode: 'explicit', path: path.relative(rootDir, manifestPath) };
    } else {
      await fs.mkdir(artifactsDir, { recursive: true });
      temporaryDirectory = await fs.mkdtemp(path.join(artifactsDir, '.manifest-selection-'));
      const artifact = await pullArtifact(
        PRODUCTION_RELEASE_MANIFEST_REFERENCE,
        path.join(temporaryDirectory, 'manifest.json'),
      );
      manifest = assertStudioServerReleaseManifest(artifact.manifest, { requirePromoted: true });
      identity = { mode: 'production', ...artifact.identity };
    }
    const manifestDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    console.log(`[${runnerName}] Selected source commit ${manifest.source.sha}; manifest digest ${manifestDigest}.`);
    const adoptionCertificate = options.has('--overlap-adoption-certificate')
      ? await readManifest(
          insideRepository(required(options, '--overlap-adoption-certificate'), '--overlap-adoption-certificate'),
          { requirePromoted: true },
        )
      : null;
    const adoption = adoptionCertificate
      ? overlapAdoptionAuthority(manifest, adoptionCertificate, required(options, '--overlap-adoption-stage'))
      : null;
    if (
      options.has('--overlap-adoption-stage') !== Boolean(adoption) ||
      (adoption &&
        (!options.has('--manifest') ||
          options.has('--rollback-to') ||
          options.has('--maintenance-plan') ||
          options.has('--maintenance-cutover') ||
          options.has('--resume-cutover') ||
          options.has('--single-machine') ||
          options.has('--ha-control-plane-transition') !== (adoption.stage === 'ownership')))
    )
      throw Error(
        'Overlap adoption requires an explicit installed manifest, candidate certificate and matching same-image stage only.',
      );
    await verifyCheckout(adoptionCertificate ?? manifest);
    await verifyClean();
    assertReleaseManifestMatchesCurrentChart(manifest, rootDir);
    const generatedValues = rollbackManifestPath
      ? createForwardRollbackHelmValues({
          failedRelease: manifest,
          rollbackRelease: await readManifest(rollbackManifestPath, { requirePromoted: true }),
        })
      : createProductionHelmValues(manifest);
    if (adoption?.stage === 'sizing') generatedValues.workflowSchema.migrationJob.enabled = false;
    // An explicit pin may itself be the retained diagnostic file. Do not rewrite it.
    const inputIsArtifact = (fileName) =>
      options.has('--manifest') && path.relative(manifestPath, path.join(artifactsDir, fileName)) === '';
    if (!inputIsArtifact('release-manifest.json'))
      await writeArtifact(artifactsDir, 'release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await writeArtifact(
      artifactsDir,
      inputIsArtifact('release-selection.json') ? 'release-selection-metadata.json' : 'release-selection.json',
      `${JSON.stringify(
        {
          ...identity,
          sourceSha: manifest.source.sha,
          manifestDigest,
        },
        null,
        2,
      )}\n`,
    );
    return { manifest, manifestPath, rollbackManifestPath, generatedValues, adoption, adoptionCertificate };
  } finally {
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function captureHelmDiagnostics(helmBin, release, namespace, artifactsDir) {
  const diagnostics = [
    ['history.json', ['history', release, '--namespace', namespace, '--output', 'json']],
    ['status.txt', ['status', release, '--namespace', namespace]],
  ];
  for (const [fileName, args] of diagnostics) {
    const result = await run(helmBin, args, { capture: true, allowFailure: true });
    await writeArtifact(artifactsDir, fileName, `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`);
  }
}

function createOperationRecord({
  release,
  namespace,
  valuesPath,
  manifestPath,
  rollbackManifestPath,
  dryRun,
  timeout,
}) {
  return {
    formatVersion: 1,
    release,
    namespace,
    valuesPath: path.relative(rootDir, valuesPath),
    manifestPath: path.relative(rootDir, manifestPath),
    ...(rollbackManifestPath ? { rollbackManifestPath: path.relative(rootDir, rollbackManifestPath) } : {}),
    dryRun,
    timeout,
    startedAt: new Date().toISOString(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const release = dnsLabel(required(options, '--release'), '--release');
  const namespace = dnsLabel(required(options, '--namespace'), '--namespace');
  if (options.has('--rollback-to') && !options.has('--manifest'))
    throw new Error(
      '--rollback-to requires an explicit --manifest for the failed release; the production pointer cannot identify it.',
    );
  const singleMachine = options.get('--single-machine') === true;
  if (
    options.has('--verify-only') &&
    (!options.has('--resume-cutover') ||
      options.has('--resume-ha') ||
      [
        '--acceptance-only',
        '--preflight-only',
        '--dry-run',
        '--plan-only',
        '--single-machine',
        '--ha-control-plane-transition',
        '--rollback-to',
      ].some((key) => options.has(key)))
  )
    throw Error('--verify-only requires exact --resume-cutover recovery, not another verification/deployment mode.');
  if (
    options.has('--preflight-only') &&
    ['--acceptance-only', '--plan-only', '--dry-run', '--resume-cutover', '--resume-ha'].some((key) => options.has(key))
  )
    throw Error('--preflight-only is a fresh non-disruptive readiness check, not recovery or another inspection mode.');
  const { timeout, timeoutMs } = parseDeploymentTimeout(options.get('--timeout') ?? '15m');
  if (
    options.has('--maintenance-plan') &&
    (!(options.has('--maintenance-cutover') || options.has('--resume-cutover')) ||
      singleMachine ||
      options.has('--rollback-to') ||
      options.has('--ha-control-plane-transition') ||
      options.has('--resume-ha'))
  )
    throw new Error(
      '--maintenance-plan requires an explicit maintenance cutover/recovery, not single-machine, rollback or rolling transfer.',
    );
  if (options.has('--env-file') && options.has('--values'))
    throw new Error('Use either --env-file or --values, not both.');
  if (singleMachine && options.has('--values')) throw new Error('--single-machine uses --env-file, not --values.');
  selectedContext = required(options, '--context');
  const valuesPath = options.has('--env-file')
    ? insideRepository(required(options, '--env-file'), '--env-file')
    : insideRepository(required(options, '--values'), '--values');
  if (options.has('--env-file') && !(await fs.lstat(valuesPath)).isFile())
    throw new Error('--env-file must be a regular file, not a symlink.');
  // Every lint/template/upgrade must consume the same settings bytes, even if an
  // operator edits the input while the release is waiting for a drain.
  const operatorValues = await fs.readFile(valuesPath);
  assertNoOperatorRolloutGuards(operatorValues, options);
  const valuesDigest = `sha256:${createHash('sha256').update(operatorValues).digest('hex')}`;
  const dryRun = options.get('--dry-run') === true;
  const artifactsDir = insideRepository(
    options.get('--artifacts') ?? `artifacts/kubernetes-production-release/${release}`,
    '--artifacts',
  );
  failureArtifactsDirectory = artifactsDir;

  if (
    !dryRun &&
    !options.has('--plan-only') &&
    !options.has('--acceptance-only') &&
    !options.has('--preflight-only') &&
    required(options, '--confirm') !== release
  ) {
    throw new Error(`--confirm must equal the release name (${release}) before a cluster upgrade is allowed`);
  }

  // A forward rollback is still a production operation. Its failed release
  // must have passed the same CI gates as an ordinary deployment; only the
  // image set and migration-Job behavior differ.
  const { manifest, manifestPath, rollbackManifestPath, generatedValues, adoption, adoptionCertificate } =
    await resolveDeploymentRelease(options, artifactsDir);
  const candidateDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
  const qualificationManifest = adoptionCertificate ?? manifest;
  const deploymentPolicy = options.has('--deployment-policy')
    ? await readDeploymentPolicy(required(options, '--deployment-policy'), rootDir, {
        release,
        namespace,
        context: selectedContext,
      })
    : null;
  const maintenance = options.has('--maintenance-plan')
    ? await readMaintenancePlan(required(options, '--maintenance-plan'), rootDir, {
        release,
        namespace,
        context: selectedContext,
        candidateDigest,
        valuesDigest,
        manifest,
        allowExpiredForRecovery: options.has('--resume-cutover'),
      })
    : null;
  let generatedValuesDir, primaryFailure;
  try {
    generatedValuesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-production-release-'));
    const frozenInput = path.join(
      generatedValuesDir,
      options.has('--env-file') ? 'operator.env' : 'operator-values.yaml',
    );
    await fs.writeFile(frozenInput, operatorValues, { mode: 0o600 });
    const localConfig = singleMachine
      ? singleMachineConfig(parseEnvFile(frozenInput), { release, namespace, context: selectedContext })
      : null;
    const productionConfig =
      !singleMachine && options.has('--env-file')
        ? productionEnvironment(parseEnvFile(frozenInput), { release, namespace, context: selectedContext })
        : null;
    const generatedValuesPath = path.join(generatedValuesDir, 'immutable-release-values.json');
    await fs.writeFile(generatedValuesPath, `${JSON.stringify(generatedValues, null, 2)}\n`, 'utf8');

    const helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName });
    selectedHelm = helmBin;
    let effectiveValuesPath = frozenInput;
    if (localConfig) {
      effectiveValuesPath = path.join(generatedValuesDir, 'single-machine.yaml');
      await fs.writeFile(effectiveValuesPath, singleMachineValues(localConfig), { mode: 0o600 });
    }
    if (productionConfig) {
      effectiveValuesPath = path.join(generatedValuesDir, 'production-environment.yaml');
      await fs.writeFile(effectiveValuesPath, renderKubernetesLauncherValuesYaml(productionConfig), { mode: 0o600 });
    }
    const valueArgs = [
      '--values',
      productionOverlayPath,
      ...(localConfig ? ['--values', path.join(chartPath, 'overlays/single-machine.yaml')] : []),
      '--values',
      effectiveValuesPath,
      '--values',
      generatedValuesPath,
    ];
    const record = createOperationRecord({
      release,
      namespace,
      valuesPath,
      manifestPath,
      rollbackManifestPath,
      dryRun,
      timeout,
    });
    await writeArtifact(artifactsDir, 'operation.json', `${JSON.stringify(record, null, 2)}\n`);
    if (maintenance)
      await writeArtifact(
        artifactsDir,
        'maintenance-plan-binding.json',
        JSON.stringify({
          formatVersion: 1,
          operationPlanDigest: maintenance.digest,
          qualification: 'waived',
          zeroDowntimeClaimed: false,
          baselineManifestDigest: maintenance.plan.installedManifestDigest,
          candidateDigest,
        }),
      );
    await writeArtifact(artifactsDir, 'immutable-release-values.json', `${JSON.stringify(generatedValues, null, 2)}\n`);
    await run(helmBin, ['lint', chartPath, ...valueArgs]);
    const rendered = await run(helmBin, ['template', release, chartPath, '--namespace', namespace, ...valueArgs], {
      capture: true,
    });
    await writeArtifact(artifactsDir, 'rendered.yaml', rendered.stdout);
    const renderedResources = parseAllDocuments(rendered.stdout)
      .map((document) => {
        if (document.errors.length) throw document.errors[0];
        return document.toJSON();
      })
      .filter(Boolean);
    const haRequested = renderedResources.some(
      (resource) =>
        resource.kind === 'StatefulSet' &&
        resource.metadata.labels?.['app.kubernetes.io/component'] === 'backend' &&
        resource.spec.updateStrategy.type === 'OnDelete',
    );
    const singletonControlRequested = renderedResources.some(
      (resource) =>
        resource.kind === 'StatefulSet' &&
        resource.metadata.labels?.['app.kubernetes.io/component'] === 'backend' &&
        resource.spec.template.spec.containers.some((c) =>
          c.env?.some(
            (e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE' && ['singleton', 'singleton-overlap'].includes(e.value),
          ),
        ),
    );
    const edgeProfile =
      renderedResources.find(
        (resource) =>
          resource.kind === 'Deployment' && resource.metadata.labels?.['app.kubernetes.io/component'] === 'proxy',
      )?.metadata.annotations?.['rivet.studio/gke-edge-profile'] ?? 'regional';
    if (
      !maintenance &&
      !options.has('--plan-only') &&
      !options.has('--acceptance-only') &&
      (singletonControlRequested || options.has('--ha-control-plane-transition') || edgeProfile === 'compact')
    )
      assertRuntimeControlEvidence(
        qualificationManifest.evidence.runtimeControl,
        qualificationManifest,
        edgeProfile,
        renderedResources.some(
          (r) =>
            r.kind === 'StatefulSet' &&
            r.spec.template.spec.containers.some((c) =>
              c.env?.some((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE' && e.value === 'singleton-overlap'),
            ),
        ),
      );
    if (haRequested && rollbackManifestPath)
      throw new Error(
        'HA reverse-image replacement is not certified by a forward mixed-version certificate. Repair forward; no automatic image/schema rollback was attempted.',
      );
    if (haRequested && !maintenance && !options.has('--plan-only') && !options.has('--acceptance-only'))
      assertHaUpgradeEvidence(qualificationManifest, null);
    const autoscalerResource = renderedResources.find(
      (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === 'autoscaler',
    );
    if (adoption) assertOverlapAdoptionResources(adoption, renderedResources, adoptionCertificate);
    else if (!maintenance) assertOrdinaryRuntimeResources(manifest.evidence.runtimeControl, renderedResources);
    let deploymentAutoscalingPolicyDigest;
    if (autoscalerResource) {
      if (options.has('--ha-control-plane-transition') && adoption?.stage !== 'ownership')
        throw new Error(
          'Disable automatic execution scaling in a separate settled release before changing control topology.',
        );
      const config = JSON.parse(
        autoscalerResource.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
      );
      deploymentAutoscalingPolicyDigest = autoscalerPolicyDigest(config.policy);
      if (!maintenance && !options.has('--plan-only') && !options.has('--acceptance-only'))
        assertCooperativeAutoscalingEvidence(
          qualificationManifest.evidence.runtimeAutoscaling,
          qualificationManifest,
          autoscalerPolicyDigest(config.policy),
        );
      if (
        !options.has('--plan-only') &&
        renderedResources.some(
          (r) =>
            r.kind === 'HorizontalPodAutoscaler' &&
            r.metadata.labels?.['app.kubernetes.io/component'] === 'proxy' &&
            r.spec.behavior?.scaleDown?.selectPolicy === 'Disabled',
        )
      )
        throw Error(
          'Final installation values must restore proxy scale-down; scaleDownPaused is an upgrade-only overlay.',
        );
    }

    if (dryRun) {
      console.log(
        `[${runnerName}] Offline render preflight passed. Live ownership, installed baseline, recovery backup and capacity have not been checked. No cluster state was changed.`,
      );
      return;
    }

    selectedKubectl = findExecutableOnPath(process.env.RIVET_K8S_KUBECTL_BIN ?? 'kubectl');
    if (!selectedKubectl) throw new Error('kubectl is required to inspect release ownership.');

    await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
    const installedResult = await run(
      helmBin,
      ['list', '--all', '--namespace', namespace, '--filter', `^${release}$`, '--output', 'json'],
      { capture: true },
    );
    const exists = JSON.parse(installedResult.stdout).length > 0;
    const installed = exists
      ? JSON.parse(
          (
            await run(helmBin, ['get', 'values', release, '--namespace', namespace, '--all', '--output', 'json'], {
              capture: true,
            })
          ).stdout,
        )
      : null;
    const kubectl = selectedKubectl;
    if (!kubectl) throw new Error('kubectl is required to inspect release cutover ownership.');
    const journalName = releaseOperationJournalName(release);
    const operationKind =
      haRequested && !options.has('--maintenance-cutover') && !options.has('--resume-cutover') ? 'ha' : 'cutover';
    const { resource: preparedJournalResource, record: pendingJournal } = await readAvailableReleaseJournal({
      kube: (args) => run(kubectl, ['--namespace', namespace, '--request-timeout=30s', ...args], { capture: true }),
      name: journalName,
      kind: operationKind,
      release,
      namespace,
      timeoutMs,
    });
    if (operationKind === 'cutover') {
      assertCutoverJournal(pendingJournal, { release, namespace });
      if (!options.has('--resume-cutover')) assertOrdinaryReleaseAllowed(pendingJournal, { release, namespace });
    }
    const installedDigest = installed?.release?.production?.manifestDigest;
    let workflowContext;
    if (
      !maintenance &&
      !adoption &&
      !options.has('--acceptance-only') &&
      exists &&
      (deploymentPolicy ||
        options.has('--plan-only') ||
        (installedDigest &&
          installedDigest !== candidateDigest &&
          installedDigest !== manifest.lineage?.predecessor?.manifestDigest))
    ) {
      const plan = await planInstalledUpgrade({
        candidate: manifest,
        installed,
        haRequested,
        autoscalingPolicyDigest: deploymentAutoscalingPolicyDigest,
        fetchManifest: async (digest) => {
          const output = path.join(artifactsDir, `predecessor-${digest.slice(7)}.json`);
          await pullReleaseManifestArtifact(
            PRODUCTION_RELEASE_MANIFEST_REFERENCE.replace(/:production$/, `:manifest-${digest.slice(7)}`),
            output,
          );
          return readManifest(output, { requirePromoted: true });
        },
      });
      await writeArtifact(artifactsDir, 'upgrade-plan.json', JSON.stringify(plan, null, 2));
      if (options.has('--plan-only')) {
        console.log(
          `[${runnerName}] Installed-version plan: ${plan.status}; ${plan.steps.length} qualified hop(s). Inspect ${path.relative(rootDir, artifactsDir)}/upgrade-plan.json.`,
        );
        return;
      }
      if (!maintenance && (!['qualified-route', 'already-installed'].includes(plan.status) || plan.steps.length > 1))
        throw Error(
          'The installed version needs a qualified multi-hop route. Review upgrade-plan.json and use each pinned source/chart in order; no workloads were changed.',
        );
    }
    if (adoption) {
      assertOverlapAdoptionInstalled(adoption, adoptionCertificate, installed, {
        journal: pendingJournal,
        resumeToken: options.get('--resume-ha'),
      });
      await writeArtifact(artifactsDir, 'overlap-adoption.json', JSON.stringify(adoption, null, 2));
      if (options.has('--plan-only')) return;
    } else if (options.has('--plan-only')) throw Error('An installed release is required for --plan-only.');
    if (exists && !singleMachine && !deploymentPolicy)
      throw Error(
        'Production upgrades require --deployment-policy with reviewed recovery and application acceptance adapters. Run --plan-only to inspect the version route first.',
      );
    if (deploymentPolicy && exists) {
      const ns = JSON.parse(
        (await run(kubectl, ['get', 'namespace', namespace, '--request-timeout=30s', '-o', 'json'], { capture: true }))
          .stdout,
      );
      const recovery = deploymentRecoveryIdentity(pendingJournal, {
        resumeToken: options.get('--resume-ha') ?? options.get('--resume-cutover'),
        policyDigest: deploymentPolicy.digest,
        valuesDigest,
        authorizationManifestDigest: adoption?.authorizationManifestDigest,
        adoptionStage: adoption?.stage,
      });
      workflowContext = {
        operationId: recovery?.operationId ?? randomUUID(),
        recovering: Boolean(recovery),
        release,
        namespace,
        context: selectedContext,
        namespaceUid: ns.metadata.uid,
        installedManifestDigest: recovery?.installedManifestDigest ?? installedDigest,
        candidateManifestDigest: candidateDigest,
        valuesDigest,
        ...(adoption
          ? { authorizationManifestDigest: adoption.authorizationManifestDigest, adoptionStage: adoption.stage }
          : {}),
      };
      if (ns.metadata.uid !== deploymentPolicy.policy.namespaceUid)
        throw Error('Deployment policy namespace identity changed.');
    }
    const kubeForRelease = (args, extra = {}) =>
      run(kubectl, ['--namespace', namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
    const kubeWithDocument = async (args, document) => {
      // A fast-exiting Windows child can close its pipe before the parent
      // observes stdin completion. Do not turn that into an accepted write or
      // retry it: avoid the pipe altogether, keeping UID/RV and JSON checks.
      const file = path.join(generatedValuesDir, `kubernetes-input-${randomUUID()}.json`);
      await fs.writeFile(file, JSON.stringify(document), { flag: 'wx', mode: 0o600 });
      return kubeForRelease([...args, '-f', file]);
    };
    const continuityTarget = continuityFromResources(renderedResources);
    const inspectContinuity = async (stage) => {
      if (!continuityTarget) return;
      const continuity = createKubernetesProxyContinuity({
        kube: kubeForRelease,
        config: {
          ...continuityTarget,
          release,
          namespace,
          hpaSpec: renderedResources.find(
            (r) => r.kind === 'HorizontalPodAutoscaler' && r.spec.scaleTargetRef.name === continuityTarget.proxyName,
          )?.spec,
        },
        timeoutMs,
      });
      const receipt = { observedAt: new Date().toISOString(), ...(await continuity.inspect()) };
      if (stage === 'acceptance' || requestContinuityProfile(installed ?? {}))
        assertContinuityAcceptance(receipt, continuityTarget.profile);
      await writeArtifact(artifactsDir, `request-continuity-${stage}.json`, JSON.stringify(receipt, null, 2));
      return receipt;
    };
    // Both non-replaying recovery routes must prove the same final settings,
    // not just match image digests or trust Helm's release identity metadata.
    const assertFinalCandidateConfiguration = async (settlement, retainedExecution = []) => {
      const status = JSON.parse(
        (
          await run(
            helmBin,
            ['list', '--all', '--namespace', namespace, '--filter', `^${release}$`, '--output', 'json'],
            { capture: true },
          )
        ).stdout,
      );
      if (status.length !== 1 || status[0].status !== 'deployed')
        throw Error('Final Helm apply is not deployed; no verification completion is allowed.');
      const stored = parseReleaseResources(
        (await run(helmBin, ['get', 'manifest', release, '--namespace', namespace], { capture: true })).stdout,
      );
      assertInstalledReleaseManifest(renderedResources, stored, { release, namespace });
      const items = JSON.parse(
        (await kubeForRelease(['get', releaseSettlementResourceTypes, '-o', 'json'])).stdout,
      ).items;
      assertInstalledExecutionSettings(renderedResources, items);
      assertNoExecutionStartupFences(
        items.filter((item) => item.metadata.labels?.['app.kubernetes.io/instance'] === release),
      );
      if (settlement)
        assertReleaseSettlementCurrent({
          settlement,
          resources: renderedResources,
          items,
          release,
          namespace,
          retainedExecution,
        });
      if (settlement) await inspectContinuity('acceptance');
    };
    if (options.has('--acceptance-only')) {
      if (
        !workflowContext ||
        installedDigest !== candidateDigest ||
        installed?.release?.production?.database?.managedWorkflowSchemaVersion !==
          manifest.database.managedWorkflowSchema.version ||
        options.has('--resume-ha') ||
        options.has('--resume-cutover') ||
        options.has('--maintenance-cutover') ||
        options.has('--ha-control-plane-transition') ||
        maintenance ||
        (pendingJournal && (pendingJournal.phase !== 'complete' || pendingJournal.leaseExpiresAt > Date.now()))
      )
        throw Error(
          'Acceptance-only verification requires the installed exact candidate, a deployment policy and no unfinished operation.',
        );
      const kube = kubeForRelease;
      const retainedExecution = retainedTopologyExecution(pendingJournal, workflowContext, deploymentPolicy.digest);
      await executeDeploymentWorkflow({
        approval: deploymentPolicy,
        context: { ...workflowContext, recovering: true },
        verificationOnly: true,
        artifactsDir,
        timeoutMs,
        artifact: (name, value) => writeArtifact(artifactsDir, name, value),
        prepareSafety: () =>
          createDeploymentSafety({
            mode: 'verification',
            context: { ...workflowContext, recovering: true },
            policyDigest: deploymentPolicy.digest,
            checkBaseline: async () => {
              const ns = JSON.parse((await kube(['get', 'namespace', namespace, '-o', 'json'])).stdout);
              const current = JSON.parse(
                (
                  await run(
                    helmBin,
                    ['get', 'values', release, '--namespace', namespace, '--all', '--output', 'json'],
                    { capture: true },
                  )
                ).stdout,
              );
              assertDeploymentBaseline(
                { installedManifestDigest: installedDigest, namespace, namespaceUid: workflowContext.namespaceUid },
                current,
                ns,
              );
            },
          }),
        run: async (safety) => {
          await safety.checkBaseline();
          await assertFinalCandidateConfiguration();
          const settlement = await waitForReleaseSettlement({
            kube,
            resources: renderedResources,
            release,
            namespace,
            timeoutMs,
            retainedExecution,
            artifact: (name, value) => writeArtifact(artifactsDir, name, value),
          });
          await safety.checkBaseline();
          await assertFinalCandidateConfiguration(settlement, retainedExecution);
          safety.confirmSettlement(settlement);
          return settlement;
        },
        verifyActivation: async () => {
          const activation = await waitForExecutionAutoscalerActivation({
            kube,
            resources: renderedResources,
            release,
            namespace,
            timeoutMs,
            artifact: (name, value) => writeArtifact(artifactsDir, name, value),
          });
          if (!activation.activated) throw Error('Automatic execution scaling is not verified active.');
          return activation;
        },
      });
      console.log(
        `[${runnerName}] Application acceptance passed. No release templates, migration or Secrets were applied.`,
      );
      return;
    }
    let maintenanceSchema;
    if (maintenance) {
      const ns = JSON.parse(
        (await run(kubectl, ['--request-timeout=30s', 'get', 'namespace', namespace, '-o', 'json'], { capture: true }))
          .stdout,
      );
      maintenanceSchema = assertMaintenanceBaseline(maintenance, {
        installed,
        manifest,
        namespaceUid: ns.metadata.uid,
        recoveryJournal: pendingJournal,
        resumeToken: options.get('--resume-cutover'),
        recovering:
          pendingJournal?.phase !== 'complete' &&
          pendingJournal?.token === options.get('--resume-cutover') &&
          pendingJournal?.operationPlanDigest === maintenance.digest &&
          pendingJournal?.manifestDigest === candidateDigest,
      });
    }
    if (
      !maintenance &&
      exists &&
      installedDigest &&
      installedDigest !== candidateDigest &&
      installedDigest !== manifest.lineage?.predecessor?.manifestDigest
    )
      throw new Error(
        'The installed release does not match the candidate or its certified predecessor. Refuse a stale or sibling rollout.',
      );
    const cutover = options.has('--maintenance-cutover') || options.has('--resume-cutover');
    const haRollout = haRequested && exists && installed?.ha?.enabled && !cutover;
    const controlTransition = options.has('--ha-control-plane-transition');
    const targetControlMode =
      renderedResources
        .find((r) => r.kind === 'StatefulSet' && r.metadata.labels?.['app.kubernetes.io/component'] === 'backend')
        ?.spec.template.spec.containers.find((c) => c.name === 'backend')
        ?.env?.find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE')?.value ?? 'replicated';
    if (haRollout && !controlTransition && (installed.ha.controlPlane?.mode ?? 'replicated') !== targetControlMode)
      throw Error(
        'Control topology changed: finish the separately certified same-image adoption before an ordinary image upgrade.',
      );
    if (controlTransition && (!haRollout || installedDigest !== candidateDigest || rollbackManifestPath))
      throw new Error(
        'Control topology transfer requires the already installed same-image bridge manifest, HA, and no cutover/rollback.',
      );
    if (options.has('--resume-ha') && (!haRollout || options.has('--resume-cutover')))
      throw new Error('--resume-ha requires an installed HA release and cannot be combined with maintenance cutover.');
    if (cutover) {
      const configuration = assertContinuityConfiguration(installed, continuityTarget ?? {});
      if (configuration.profile && !configuration.sourceProfile)
        throw Error('First request continuity adoption requires its qualified ordinary HA transition.');
    } else assertContinuityUpgrade(qualificationManifest, installed, continuityTarget ?? {});
    if (continuityTarget && !haRollout && !cutover)
      throw Error('Request continuity activation requires the ordinary installed HA rolling path.');
    if (haRequested && !cutover)
      assertHaUpgradeEvidence(
        qualificationManifest,
        continuityRecoveryLayout(installed, continuityTarget, {
          journal: pendingJournal,
          resumeToken: options.get('--resume-ha'),
          configurationDigest: getHaConfigurationDigest(renderedResources),
          manifestDigest: candidateDigest,
          release,
          namespace,
        }),
      );
    if (continuityTarget && !options.has('--resume-ha') && !workflowContext?.recovering)
      await inspectContinuity('preflight');
    if (installed?.ha?.enabled && !haRequested && !cutover)
      throw new Error('Disabling HA requires maintenance; ordinary Helm must not delete accepted owners.');
    if (exists && !installedDigest && !cutover)
      throw new Error(
        'The installed release identity is unknown. Use an explicitly owned maintenance cutover, not an unverified rolling rollout.',
      );
    if (requiresMaintenanceCutover(manifest, installed) && !cutover)
      throw new Error(
        'This release is incompatible with older readers. Use --maintenance-cutover after draining accepted runs, pausing external controllers, and confirming this release owns every database consumer.',
      );
    if (cutover && rollbackManifestPath)
      throw new Error('Maintenance cutover cannot be combined with forward rollback.');
    if (cutover && !exists)
      throw new Error('Maintenance cutover requires an installed release. Bootstrap with the normal install path.');
    // This is the combined route decision, made before application journeys,
    // backups, journal acquisition or any workload/Secret mutation.
    await writeArtifact(
      artifactsDir,
      'deployment-route.json',
      JSON.stringify(
        {
          formatVersion: 1,
          release,
          namespace,
          candidateManifestDigest: candidateDigest,
          installedManifestDigest: installedDigest ?? null,
          route: cutover ? 'maintenance' : haRollout ? 'rolling' : exists ? 'direct' : 'bootstrap',
          qualification: maintenance ? 'waived' : 'required',
          installedSchemaVersion: installed?.release?.production?.database?.managedWorkflowSchemaVersion ?? null,
          targetSchemaVersion: manifest.database.managedWorkflowSchema.version,
          schemaMigration: maintenanceSchema ?? null,
          dataSafetyWaived: false,
        },
        null,
        2,
      ),
    );
    const assertInstalledBaseline = async () => {
      if (!exists) return;
      const current = JSON.parse(
        (
          await run(helmBin, ['get', 'values', release, '--namespace', namespace, '--all', '--output', 'json'], {
            capture: true,
          })
        ).stdout,
      );
      const liveNamespace = workflowContext
        ? JSON.parse(
            (
              await run(kubectl, ['get', 'namespace', namespace, '--request-timeout=30s', '-o', 'json'], {
                capture: true,
              })
            ).stdout,
          )
        : null;
      assertDeploymentBaseline(
        { installedManifestDigest: installedDigest, namespace, namespaceUid: workflowContext?.namespaceUid },
        current,
        liveNamespace,
      );
    };
    if (options.has('--verify-only') && !workflowContext)
      throw Error('Verification-only cutover recovery requires the original production deployment policy.');
    if (workflowContext && !workflowContext.recovering) {
      // Run against the installed release, not candidate images that are not
      // running yet. No journal, workload, Secret or fixture request is written.
      const status = JSON.parse(
        (
          await run(
            helmBin,
            ['list', '--all', '--namespace', namespace, '--filter', `^${release}$`, '--output', 'json'],
            { capture: true },
          )
        ).stdout,
      );
      if (status.length !== 1 || status[0].status !== 'deployed')
        throw Error('Installed Helm release is not deployed; inspect its exact operation before maintenance.');
      const currentResources = parseReleaseResources(
        (await run(helmBin, ['get', 'manifest', release, '--namespace', namespace], { capture: true })).stdout,
      );
      await waitForReleaseSettlement({
        kube: kubeForRelease,
        resources: currentResources,
        release,
        namespace,
        timeoutMs: Math.min(timeoutMs, 30_000),
        stableMs: 0,
        artifact: (_name, value) => writeArtifact(artifactsDir, 'installed-preflight-settlement.json', value),
      });
      assertNoExecutionStartupFences(
        JSON.parse(
          (
            await kubeForRelease([
              'get',
              'statefulset,pod',
              '-l',
              `app.kubernetes.io/instance=${release}`,
              '-o',
              'json',
            ])
          ).stdout,
        ).items,
      );
      for (const script of new Set([
        ...Object.values(deploymentPolicy.scripts),
        ...(maintenance ? [maintenance.scriptPath] : []),
        ...(maintenance?.migrationScriptPath ? [maintenance.migrationScriptPath] : []),
      ])) {
        try {
          await run(process.execPath, ['--check', script], { capture: true });
        } catch (error) {
          // Node syntax diagnostics quote source lines, which may contain local
          // credentials. Keep those bytes private rather than printing them.
          await writeArtifact(artifactsDir, 'adapter-syntax-private.log', String(error));
          throw Error(
            'Deployment adapter syntax check failed. Inspect the private adapter-syntax log; maintenance has not started.',
          );
        }
      }
      const preflightApproval = maintenance
        ? { ...deploymentPolicy, policy: { ...deploymentPolicy.policy, backup: maintenance.plan.backup } }
        : deploymentPolicy;
      const prerequisites = await runDeploymentStage(preflightApproval, 'preflight', workflowContext, {
        artifactsDir,
        timeoutMs: Math.min(timeoutMs, 60_000),
      });
      const migrationPrerequisites = maintenance
        ? await preflightMaintenanceMigration(maintenance, {
            artifactsDir,
            timeoutMs: Math.min(timeoutMs, 60_000),
          })
        : null;
      await assertInstalledBaseline();
      await writeArtifact(
        artifactsDir,
        'deployment-preflight.json',
        JSON.stringify(
          {
            formatVersion: 1,
            passed: true,
            observedAt: new Date().toISOString(),
            ...workflowContext,
            policyDigest: deploymentPolicy.digest,
            prerequisites,
            migrationPrerequisites,
            scope: 'installed-state-and-local-readiness',
            qualification: 'not-established-by-preflight',
            workloadMutations: false,
            applicationJourneysRun: false,
          },
          null,
          2,
        ),
      );
    }
    if (options.has('--preflight-only')) {
      if (!workflowContext || workflowContext.recovering)
        throw Error('Preflight requires an installed production release and policy.');
      console.log(
        `[${runnerName}] Installed-state and local-readiness preflight passed. No maintenance, backup, application journey or deployment was started.`,
      );
      return;
    }
    const outcome = await executeDeploymentWorkflow({
      approval: deploymentPolicy,
      context: workflowContext,
      maintenance: Boolean(cutover),
      verificationOnly: options.has('--verify-only'),
      artifactsDir,
      timeoutMs,
      artifact: (name, value) => writeArtifact(artifactsDir, name, value),
      prepareSafety: ({ before, backup }) =>
        createDeploymentSafety({
          mode: cutover ? 'maintenance' : controlTransition ? 'topology' : haRollout ? 'rolling' : 'direct',
          scope: workflowContext ? 'production' : singleMachine ? 'local' : 'bootstrap',
          context: workflowContext,
          localIdentity: { release, namespace, context: selectedContext, candidateManifestDigest: candidateDigest },
          policyDigest: deploymentPolicy?.digest,
          before,
          backup,
          checkBaseline: assertInstalledBaseline,
          captureRecovery: maintenance
            ? (context) => captureMaintenanceCheckpoint(maintenance, context, { artifactsDir, timeoutMs })
            : workflowContext
              ? (context) =>
                  runDeploymentStage(
                    deploymentPolicy,
                    'backup',
                    {
                      ...workflowContext,
                      consistency: 'quiesced',
                      phase: context.phase,
                      journalToken: context.token,
                      leaseExpiresAt: context.leaseExpiresAt,
                    },
                    { artifactsDir, timeoutMs },
                  )
              : async () => ({ local: true }),
        }),
      verifyActivation: async () => {
        await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
        await inspectContinuity('acceptance');
        // This is post-deployment verification, not part of workload mutation.
        // An error must never re-enter retirement or imply Helm needs replay.
        const activation = await waitForExecutionAutoscalerActivation({
          kube: kubeForRelease,
          resources: renderedResources,
          release,
          namespace,
          timeoutMs,
          after: Date.now(),
          artifact: (name, value) => writeArtifact(artifactsDir, name, value),
        });
        if (!activation.activated)
          throw new Error(
            'Automatic execution scaling has not been verified active; inspect execution-autoscaler-activation.json.',
          );
        return activation;
      },
      run: async (safety) => {
        await safety.checkBaseline();
        if (localConfig && !haRollout && !cutover) {
          await prepareSingleMachine(localConfig, (args, extra = {}) =>
            run(selectedKubectl, args, { capture: true, ...extra }),
          );
        }
        if (productionConfig && !haRollout && !cutover) {
          await prepareProductionSecrets(productionConfig, (args, extra = {}) =>
            run(selectedKubectl, args, { capture: true, ...extra }),
          );
        }
        if (productionConfig && haRollout)
          await prepareProductionSecrets(
            productionConfig,
            (args, extra = {}) => run(selectedKubectl, args, { capture: true, ...extra }),
            { verifyOnly: true },
          );
        const upgrade = (extra = []) =>
          run(helmBin, [
            'upgrade',
            '--install',
            release,
            chartPath,
            '--namespace',
            namespace,
            ...valueArgs,
            ...extra,
            // Candidate migrations may commit irreversibly. Atomic rollback is
            // reserved for the explicit forward-rollback path, which skips them.
            ...(rollbackManifestPath ? ['--atomic'] : []),
            '--wait',
            '--wait-for-jobs',
            '--timeout',
            timeout,
          ]);
        const settle = (resources = renderedResources, options = {}) =>
          waitForReleaseSettlement({
            kube: kubeForRelease,
            resources,
            release,
            namespace,
            timeoutMs,
            ...options,
            artifact: (name, value) => writeArtifact(artifactsDir, name, value),
          });
        try {
          if (haRollout) {
            const kube = kubeForRelease;
            const preservePath = path.join(generatedValuesDir, 'ha-preserved-capacity.json');
            const frozenPath = path.join(generatedValuesDir, 'ha-frozen-autoscalers.json');
            const preserve = async (guardedValues) => {
              // Capacity and its API-server preconditions travel in the same Helm update.
              await fs.writeFile(preservePath, JSON.stringify(guardedValues));
            };
            await fs.writeFile(frozenPath, JSON.stringify(haRolloutAutoscalingValues(renderedResources)));
            const rollout = controlTransition ? runHaKubernetesControlTopology : runHaKubernetesRollout;
            return await rollout({
              kube,
              release,
              namespace,
              manifestDigest: candidateDigest,
              resources: renderedResources,
              safety,
              previousManifestDigest: installedDigest,
              ...(adoption?.stage === 'sizing'
                ? { ownerPoolTransition: { from: adoption.sourcePool, to: adoption.profile.poolMaxPerApiPod } }
                : {}),
              resumeToken: options.get('--resume-ha'),
              timeoutMs,
              artifact: (name, value) => writeArtifact(artifactsDir, name, value),
              applyTemplates: async (_workloads, guardedValues) => {
                if (controlTransition) {
                  await preserve(_workloads);
                  await upgrade(['--values', preservePath, '--set', 'workflowSchema.migrationJob.enabled=false']);
                  return;
                }
                await preserve(guardedValues);
                await upgrade(['--values', preservePath, '--values', frozenPath]);
              },
              restoreAutoscalers: async (_workloads, guardedValues) => {
                await preserve(guardedValues);
                await upgrade(['--values', preservePath, '--set', 'workflowSchema.migrationJob.enabled=false']);
              },
              settle: controlTransition ? (options) => settle(renderedResources, options) : settle,
              verifyDeveloperReady: async (backendCandidate) => {
                if (!deploymentPolicy || !workflowContext)
                  throw Error('Developer overlap requires an installation acceptance policy.');
                await runDeploymentStage(
                  deploymentPolicy,
                  'backend',
                  { ...workflowContext, backendCandidate },
                  { artifactsDir, timeoutMs },
                );
              },
            });
          } else if (cutover) {
            const kube = kubeForRelease;
            const name = journalName;
            const selector = `app.kubernetes.io/instance=${release}`;
            const inventory = async () => {
              const resources = JSON.parse(
                (
                  await kube([
                    'get',
                    'deployment,statefulset,hpa,pvc,daemonset,cronjob,replicationcontroller,job',
                    '-l',
                    selector,
                    '-o',
                    'json',
                  ])
                ).stdout,
              ).items;
              if (
                resources.some(
                  (item) =>
                    ['DaemonSet', 'CronJob', 'ReplicationController'].includes(item.kind) ||
                    (item.kind === 'Job' &&
                      !(
                        item.metadata.labels?.['app.kubernetes.io/component'] === 'workflow-schema-migration' &&
                        item.status?.conditions?.some(
                          (condition) => ['Complete', 'Failed'].includes(condition.type) && condition.status === 'True',
                        )
                      )),
                )
              )
                throw Error('Maintenance cannot prove ownership of every database reader controller.');
              return {
                workloads: resources
                  .filter((item) => ['Deployment', 'StatefulSet'].includes(item.kind))
                  .map((item) => ({
                    kind: item.kind.toLowerCase(),
                    name: item.metadata.name,
                    uid: item.metadata.uid,
                    resourceVersion: item.metadata.resourceVersion,
                    component: item.metadata.labels?.['app.kubernetes.io/component'],
                    replicas: item.spec.replicas ?? 1,
                  })),
                autoscalers: resources
                  .filter((item) => item.kind === 'HorizontalPodAutoscaler')
                  .map((item) => ({
                    name: item.metadata.name,
                    uid: item.metadata.uid,
                    resourceVersion: item.metadata.resourceVersion,
                  })),
                claims: resources
                  .filter((item) => item.kind === 'PersistentVolumeClaim')
                  .map((item) => ({ name: item.metadata.name, uid: item.metadata.uid })),
              };
            };
            // A completed foreign-kind journal is returned as null by the
            // strategy, but its freshly observed CAS version must be retained.
            // The autoscaler may update it during baseline checks or inventory.
            let observedJournalResource;
            const readJournal = async () => {
              const { resource, record } = await readAvailableReleaseJournal({
                kube,
                name,
                kind: 'cutover',
                release,
                namespace,
                timeoutMs,
                previousResource: observedJournalResource ?? preparedJournalResource,
              });
              observedJournalResource = resource;
              return record;
            };
            const saveJournal = async (record, resourceVersion) => {
              const { resourceVersion: _discard, ...data } = record;
              const resource = {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                  name,
                  namespace,
                  ...(resourceVersion
                    ? {
                        resourceVersion,
                        uid: observedJournalResource?.metadata.uid,
                        labels: observedJournalResource?.metadata.labels,
                        annotations: observedJournalResource?.metadata.annotations,
                      }
                    : {}),
                },
                data: { record: JSON.stringify(data) },
              };
              const saved = JSON.parse(
                (await kubeWithDocument([resourceVersion ? 'replace' : 'create', '-o', 'json'], resource)).stdout,
              );
              observedJournalResource = saved;
              return { ...data, resourceVersion: saved.metadata.resourceVersion };
            };
            const maintenancePath = path.join(generatedValuesDir, 'maintenance-validation.json');
            const sameLayout = Boolean(haRequested && installed?.ha?.enabled);
            const validationValues = createMaintenanceValidationValues(maintenanceValidationValues, {
              sameLayout,
              haRequested,
            });
            await fs.writeFile(maintenancePath, JSON.stringify(validationValues), { mode: 0o600 });
            await run(helmBin, ['lint', chartPath, ...valueArgs, '--values', maintenancePath]);
            const validationRender = await run(
              helmBin,
              ['template', release, chartPath, '--namespace', namespace, ...valueArgs, '--values', maintenancePath],
              { capture: true },
            );
            const validationResources = parseAllDocuments(validationRender.stdout)
              .map((document) => {
                if (document.errors.length) throw document.errors[0];
                return document.toJSON();
              })
              .filter(Boolean);
            const waitForStopped = async () => {
              const deadline = Date.now() + timeoutMs;
              while (true) {
                const pods = JSON.parse((await kube(['get', 'pods', '-l', selector, '-o', 'json'])).stdout).items;
                if (!pods.some(blocksCutoverStop)) return;
                if (Date.now() >= deadline)
                  throw new Error('Old pods have not stopped. No forced deletion was attempted.');
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
            };
            return await runManagedReleaseCutover({
              release,
              namespace,
              manifestDigest: getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }),
              operationPlanDigest: maintenance?.digest,
              admissionExpiresAt: maintenance ? Date.parse(maintenance.plan.expiresAt) : undefined,
              safety,
              resumeToken: options.get('--resume-cutover'),
              inventory,
              readJournal,
              createJournal: (record) => saveJournal(record, observedJournalResource?.metadata.resourceVersion),
              replaceJournal: saveJournal,
              scale: async (item, replicas) => {
                const live = JSON.parse((await kube(['get', item.kind, item.name, '-o', 'json'])).stdout);
                if (!item.uid || live.metadata.uid !== item.uid)
                  throw Error('Maintenance workload identity changed before quiescing.');
                return kube([
                  'patch',
                  item.kind,
                  item.name,
                  '--type=json',
                  '-p',
                  JSON.stringify([
                    { op: 'test', path: '/metadata/uid', value: item.uid },
                    { op: 'test', path: '/metadata/resourceVersion', value: live.metadata.resourceVersion },
                    { op: 'test', path: '/spec/replicas', value: live.spec.replicas },
                    { op: 'replace', path: '/spec/replicas', value: replicas },
                  ]),
                ]);
              },
              removeAutoscaler: async (hpa) => {
                const raw = (await kube(['get', 'hpa', hpa.name, '--ignore-not-found', '-o', 'json'])).stdout;
                if (!raw.trim()) return;
                const live = JSON.parse(raw);
                if (!hpa.uid || live.metadata.uid !== hpa.uid)
                  throw Error('Maintenance HPA identity changed before quiescing.');
                return kubeWithDocument(
                  [
                    'delete',
                    '--raw',
                    `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers/${hpa.name}`,
                  ],
                  {
                    apiVersion: 'v1',
                    kind: 'DeleteOptions',
                    preconditions: { uid: hpa.uid, resourceVersion: live.metadata.resourceVersion },
                  },
                );
              },
              waitForStopped,
              installValidation: async () => {
                // A cutover must own the shared CAS journal and stop old readers
                // before its environment-file preparation can rotate Secrets.
                if (localConfig)
                  await prepareSingleMachine(localConfig, (args, extra = {}) =>
                    run(selectedKubectl, args, { capture: true, ...extra }),
                  );
                if (productionConfig)
                  await prepareProductionSecrets(productionConfig, (args, extra = {}) =>
                    run(selectedKubectl, args, { capture: true, ...extra }),
                  );
                await upgrade(['--values', maintenancePath]);
              },
              validate: async () => {
                await waitForReleaseSettlement({
                  kube,
                  resources: validationResources,
                  release,
                  namespace,
                  timeoutMs,
                  stableMs: 0,
                  artifact: (_name, value) =>
                    writeArtifact(artifactsDir, 'maintenance-validation-settlement.json', value),
                });
                const pods = JSON.parse((await kube(['get', 'pods', '-l', selector, '-o', 'json'])).stdout).items;
                for (const target of getMaintenanceValidationTargets(validationResources, pods))
                  await kube([
                    'exec',
                    target.podName,
                    '-c',
                    target.container,
                    '--',
                    'node',
                    '-e',
                    `const base='http://127.0.0.1:${target.port}'; Promise.all([fetch(base+'/readyz',{signal:AbortSignal.timeout(10000)}),fetch(base+'/api/workflows/tree',{signal:AbortSignal.timeout(10000)})]).then(async([health,traffic])=>{if(!health.ok||traffic.status!==503||(await traffic.json()).code!=='release_maintenance')throw Error('Validation readiness or maintenance admission failed')}).catch(e=>{console.error(e.message);process.exitCode=1})`,
                  ]);
              },
              stopValidationBeforeResume: sameLayout,
              // Validation already ran and verified this exact schema migration.
              resume: () => upgrade(['--set', 'workflowSchema.migrationJob.enabled=false']),
              settle: () => settle(),
              verificationOnly: options.has('--verify-only'),
              verifyExisting: async (record) => {
                await verifyRetainedCutoverCheckpoint(
                  rootDir,
                  record.recoveryCheckpoint?.directory,
                  workflowContext,
                  record.token,
                  maintenance?.digest ?? deploymentPolicy.digest,
                  maintenance,
                );
                const observed = await inventory();
                const expectedInventory =
                  record.finalApply?.inventory ??
                  assertCutoverVerificationTarget(renderedResources, observed, record.claims);
                assertCutoverVerificationInventory(expectedInventory, observed);
                await assertFinalCandidateConfiguration();
                const result = await settle();
                assertCutoverVerificationInventory(expectedInventory, await inventory());
                await assertInstalledBaseline();
                await assertFinalCandidateConfiguration(result);
                return result;
              },
            });
          } else {
            safety.assertReadyForTemplates();
            await upgrade();
            const settlement = await settle();
            safety.confirmSettlement(settlement);
            return settlement;
          }
        } catch (error) {
          let cause = error;
          try {
            await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
          } catch (diagnosticError) {
            cause = preserveDeploymentFailure(error, diagnosticError);
          }
          const recoveryGuidance = rollbackManifestPath
            ? 'The forward rollback was atomic because it does not run a schema migration.'
            : 'The candidate was intentionally not rolled back automatically because its schema migration may already have committed. Inspect the saved diagnostics, then repair forward or run the documented forward rollback; do not use helm rollback.';
          const failure = new Error(
            `${cause instanceof Error ? cause.message : String(cause)}\n[${runnerName}] ${recoveryGuidance} Inspect ${path.relative(rootDir, artifactsDir)} before taking the next recovery action.`,
            { cause },
          );
          if (error?.deploymentOperation) failure.deploymentOperation = error.deploymentOperation;
          throw failure;
        }
      },
    });
    console.log(
      `[${runnerName}] ${outcome.state === 'complete' ? (rollbackManifestPath ? 'Forward rollback' : 'Production release') + ' completed with application acceptance' : 'Infrastructure completed; application acceptance is not configured'}. Diagnostics: ${path.relative(rootDir, artifactsDir)}.`,
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (generatedValuesDir) {
      try {
        await fs.rm(generatedValuesDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (cleanupError) {
        throw primaryFailure ? preserveDeploymentFailure(primaryFailure, cleanupError) : cleanupError;
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    if (failureArtifactsDirectory) {
      try {
        await fs.mkdir(failureArtifactsDirectory, { recursive: true, mode: 0o700 });
        const file = path.join(failureArtifactsDirectory, `deployment-failure-${randomUUID()}.private.json`);
        await fs.writeFile(file, JSON.stringify(deploymentFailureDetails(error), null, 2), { flag: 'wx', mode: 0o600 });
        console.error(`[${runnerName}] Private failure details: ${file}`);
      } catch {
        console.error(`[${runnerName}] Private failure diagnostics could not be saved; original failure follows.`);
      }
    }
    console.error(`[${runnerName}] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
