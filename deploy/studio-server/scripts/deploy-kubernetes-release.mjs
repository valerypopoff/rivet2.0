import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { assertHaUpgradeEvidence } from './lib/ha-release-evidence.mjs';
import { runHaKubernetesRollout } from './lib/ha-kubernetes-rollout.mjs';
import { releaseOperationJournalName, journalForReleaseOperation } from './lib/release-operation-journal.mjs';
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
  '--resume-cutover',
  '--single-machine',
  '--env-file',
  '--context',
  '--resume-ha',
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
    if (key === '--dry-run' || key === '--maintenance-cutover' || key === '--single-machine') {
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

function duration(value) {
  if (!/^\d+(s|m|h)$/u.test(value)) {
    throw new Error('--timeout must be a Helm duration such as 10m or 1h');
  }
  return value;
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

async function writeArtifact(artifactsDir, fileName, contents) {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, fileName), contents, 'utf8');
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
    await verifyCheckout(manifest);
    await verifyClean();
    assertReleaseManifestMatchesCurrentChart(manifest, rootDir);
    const generatedValues = rollbackManifestPath
      ? createForwardRollbackHelmValues({
          failedRelease: manifest,
          rollbackRelease: await readManifest(rollbackManifestPath, { requirePromoted: true }),
        })
      : createProductionHelmValues(manifest);
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
    return { manifest, manifestPath, rollbackManifestPath, generatedValues };
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
  if (options.has('--env-file') && options.has('--values'))
    throw new Error('Use either --env-file or --values, not both.');
  if (singleMachine && options.has('--values')) throw new Error('--single-machine uses --env-file, not --values.');
  selectedContext = required(options, '--context');
  const valuesPath = options.has('--env-file')
    ? insideRepository(required(options, '--env-file'), '--env-file')
    : insideRepository(required(options, '--values'), '--values');
  if (options.has('--env-file') && !(await fs.lstat(valuesPath)).isFile())
    throw new Error('--env-file must be a regular file, not a symlink.');
  const localConfig = singleMachine
    ? singleMachineConfig(parseEnvFile(valuesPath), { release, namespace, context: selectedContext })
    : null;
  const productionConfig =
    !singleMachine && options.has('--env-file')
      ? productionEnvironment(parseEnvFile(valuesPath), { release, namespace, context: selectedContext })
      : null;
  const dryRun = options.get('--dry-run') === true;
  const timeout = duration(options.get('--timeout') ?? '15m');
  const artifactsDir = insideRepository(
    options.get('--artifacts') ?? `artifacts/kubernetes-production-release/${release}`,
    '--artifacts',
  );

  if (!dryRun && required(options, '--confirm') !== release) {
    throw new Error(`--confirm must equal the release name (${release}) before a cluster upgrade is allowed`);
  }

  // A forward rollback is still a production operation. Its failed release
  // must have passed the same CI gates as an ordinary deployment; only the
  // image set and migration-Job behavior differ.
  const { manifest, manifestPath, rollbackManifestPath, generatedValues } = await resolveDeploymentRelease(
    options,
    artifactsDir,
  );
  let generatedValuesDir;
  try {
    generatedValuesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-production-release-'));
    const generatedValuesPath = path.join(generatedValuesDir, 'immutable-release-values.json');
    await fs.writeFile(generatedValuesPath, `${JSON.stringify(generatedValues, null, 2)}\n`, 'utf8');

    const helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName });
    selectedHelm = helmBin;
    let effectiveValuesPath = valuesPath;
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
    await writeArtifact(artifactsDir, 'immutable-release-values.json', `${JSON.stringify(generatedValues, null, 2)}\n`);
    await run(helmBin, ['lint', chartPath, ...valueArgs]);
    const rendered = await run(helmBin, ['template', release, chartPath, '--namespace', namespace, ...valueArgs], {
      capture: true,
    });
    await writeArtifact(artifactsDir, 'rendered.yaml', rendered.stdout);
    const renderedResources = parseAllDocuments(rendered.stdout).map(document => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON();
    }).filter(Boolean);
    const haRequested = renderedResources.some(resource => resource.kind === 'StatefulSet' &&
      resource.metadata.labels?.['app.kubernetes.io/component'] === 'backend' && resource.spec.updateStrategy.type === 'OnDelete');
    if (haRequested && rollbackManifestPath)
      throw new Error('HA reverse-image replacement is not certified by a forward mixed-version certificate. Repair forward; no automatic image/schema rollback was attempted.');
    if (haRequested) assertHaUpgradeEvidence(manifest, null);

    if (dryRun) {
      console.log(`[${runnerName}] Preflight passed. No cluster state was changed.`);
      return;
    }

    selectedKubectl = findExecutableOnPath(process.env.RIVET_K8S_KUBECTL_BIN ?? 'kubectl');
    if (!selectedKubectl) throw new Error('kubectl is required to inspect release ownership.');

    await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
    const installedResult = await run(
      helmBin,
      ['list', '--namespace', namespace, '--filter', `^${release}$`, '--output', 'json'],
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
    const savedJournal = await run(
      kubectl,
      [
        '--namespace',
        namespace,
        '--request-timeout=30s',
        'get',
        'configmap',
        journalName,
        '--ignore-not-found',
        '-o',
        'json',
      ],
      { capture: true },
    );
    const journalResource = savedJournal.stdout.trim() ? JSON.parse(savedJournal.stdout) : null;
    const sharedJournal = journalResource
      ? { ...JSON.parse(journalResource.data.record), resourceVersion: journalResource.metadata.resourceVersion }
      : null;
    const operationKind = haRequested && !options.has('--maintenance-cutover') && !options.has('--resume-cutover') ? 'ha' : 'cutover';
    const pendingJournal = journalForReleaseOperation(sharedJournal, operationKind, { release, namespace });
    if (operationKind === 'cutover') {
      assertCutoverJournal(pendingJournal, { release, namespace });
      if (!options.has('--resume-cutover')) assertOrdinaryReleaseAllowed(pendingJournal, { release, namespace });
    }
    const installedDigest = installed?.release?.production?.manifestDigest;
    const candidateDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    if (
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
    if (options.has('--resume-ha') && (!haRollout || options.has('--resume-cutover')))
      throw new Error('--resume-ha requires an installed HA release and cannot be combined with maintenance cutover.');
    if (haRequested && !cutover) assertHaUpgradeEvidence(manifest, installed);
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
    if (productionConfig && haRollout) await prepareProductionSecrets(productionConfig,
      (args, extra = {}) => run(selectedKubectl, args, { capture: true, ...extra }), { verifyOnly: true });
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
        ...(rollbackManifestPath ? ['--atomic'] : []),
        '--wait',
        '--wait-for-jobs',
        '--timeout',
        timeout,
      ]);
    try {
      if (haRollout) {
        const kube = (args, extra = {}) => run(kubectl, ['--namespace', namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
        const preservePath = path.join(generatedValuesDir, 'ha-preserved-capacity.json');
        const frozenPath = path.join(generatedValuesDir, 'ha-frozen-autoscalers.json');
        const preserve = async (workloads) => {
          // Helm must not scale down HPA-created owners before retirement.
          await fs.writeFile(preservePath, JSON.stringify({ replicaCount: Object.fromEntries(workloads.filter(w => w.role !== 'maintenance').map(w => [w.role, w.replicas])) }));
        };
        await fs.writeFile(frozenPath, JSON.stringify({ autoscaling: { execution: { enabled: false }, backend: { enabled: false } } }));
        await runHaKubernetesRollout({ kube, release, namespace, manifestDigest: candidateDigest, resources: renderedResources,
          resumeToken: options.get('--resume-ha'), timeoutMs: Number.parseInt(timeout, 10) * (timeout.endsWith('h') ? 3600000 : timeout.endsWith('m') ? 60000 : 1000),
          artifact: (name, value) => writeArtifact(artifactsDir, name, value),
          applyTemplates: async workloads => {
            await preserve(workloads);
            await upgrade(['--values', preservePath, '--values', frozenPath]);
          },
          restoreAutoscalers: async workloads => { await preserve(workloads); await upgrade(['--values', preservePath, '--set', 'workflowSchema.migrationJob.enabled=false']); },
        });
      } else if (cutover) {
        const kube = async (args, extra = {}) =>
          run(kubectl, ['--namespace', namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
        const name = journalName;
        const selector = `app.kubernetes.io/instance=${release}`;
        const inventory = async () => {
          const resources = JSON.parse(
            (await kube(['get', 'deployment,statefulset,hpa', '-l', selector, '-o', 'json'])).stdout,
          ).items;
          return {
            workloads: resources
              .filter((item) => item.kind !== 'HorizontalPodAutoscaler')
              .map((item) => ({
                kind: item.kind.toLowerCase(),
                name: item.metadata.name,
                component: item.metadata.labels?.['app.kubernetes.io/component'],
                replicas: item.spec.replicas ?? 1,
              })),
            autoscalers: resources
              .filter((item) => item.kind === 'HorizontalPodAutoscaler')
              .map((item) => item.metadata.name),
          };
        };
        const readJournal = async () => {
          const result = await kube(['get', 'configmap', name, '--ignore-not-found', '-o', 'json']);
          if (!result.stdout.trim()) return null;
          const resource = JSON.parse(result.stdout);
          return journalForReleaseOperation({ ...JSON.parse(resource.data.record), resourceVersion: resource.metadata.resourceVersion }, 'cutover', { release, namespace });
        };
        const saveJournal = async (record, resourceVersion) => {
          const { resourceVersion: _discard, ...data } = record;
          const resource = {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name, namespace, ...(resourceVersion ? { resourceVersion } : {}) },
            data: { record: JSON.stringify(data) },
          };
          const saved = JSON.parse(
            (
              await kube([resourceVersion ? 'replace' : 'create', '-f', '-', '-o', 'json'], {
                input: JSON.stringify(resource),
              })
            ).stdout,
          );
          return { ...data, resourceVersion: saved.metadata.resourceVersion };
        };
        const maintenancePath = path.join(generatedValuesDir, 'maintenance-validation.json');
        await fs.writeFile(maintenancePath, JSON.stringify({ ...maintenanceValidationValues, ...(haRequested ? { ha: { enabled: false }, replicaCount: { ...maintenanceValidationValues.replicaCount, backend: 1 } } : {}) }), 'utf8');
        await runManagedReleaseCutover({
          release,
          namespace,
          manifestDigest: getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }),
          resumeToken: options.get('--resume-cutover'),
          inventory,
          readJournal,
          createJournal: (record) => saveJournal(record, sharedJournal?.resourceVersion),
          replaceJournal: saveJournal,
          scale: (item, replicas) => kube(['scale', `${item.kind}/${item.name}`, `--replicas=${replicas}`]),
          removeAutoscaler: (hpa) => kube(['delete', 'hpa', hpa, '--ignore-not-found']),
          waitForStopped: async () => {
            const amount =
              Number.parseInt(timeout, 10) *
              (timeout.endsWith('h') ? 3_600_000 : timeout.endsWith('m') ? 60_000 : 1000);
            const deadline = Date.now() + amount;
            while (true) {
              const pods = JSON.parse((await kube(['get', 'pods', '-l', selector, '-o', 'json'])).stdout).items;
              if (!pods.some(blocksCutoverStop)) break;
              if (Date.now() >= deadline)
                throw new Error('Old pods have not stopped. No forced deletion was attempted.');
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          },
          installValidation: async () => {
            // A cutover must own the shared CAS journal and stop old readers
            // before its environment-file preparation can rotate Secrets.
            if (localConfig) await prepareSingleMachine(localConfig, (args, extra = {}) =>
              run(selectedKubectl, args, { capture: true, ...extra }));
            if (productionConfig) await prepareProductionSecrets(productionConfig, (args, extra = {}) =>
              run(selectedKubectl, args, { capture: true, ...extra }));
            await upgrade(['--values', maintenancePath]);
          },
          validate: async () => {
            const pods = JSON.parse(
              (await kube(['get', 'pods', '-l', `${selector},app.kubernetes.io/component=backend`, '-o', 'json']))
                .stdout,
            ).items;
            if (pods.length !== 1) throw new Error('Expected one validation backend.');
            await kube([
              'exec',
              pods[0].metadata.name,
              '-c',
              'backend',
              '--',
              'node',
              '-e',
              'const base=`http://127.0.0.1:${process.env.RIVET_BACKEND_API_PORT || 80}`; Promise.all([fetch(`${base}/readyz`,{signal:AbortSignal.timeout(10000)}),fetch(`${base}/api/workflows/tree`,{signal:AbortSignal.timeout(10000)})]).then(async([health,traffic])=>{if(!health.ok||traffic.status!==503||(await traffic.json()).code!=="release_maintenance")throw Error("Validation readiness or maintenance admission failed")}).catch(e=>{console.error(e.message);process.exitCode=1})',
            ]);
          },
          resume: () => upgrade(),
        });
      } else
        await run(helmBin, [
          'upgrade',
          '--install',
          release,
          chartPath,
          '--namespace',
          namespace,
          ...valueArgs,
          // A candidate migration is not reversible. Do not let Helm silently
          // restore the previous workloads after its migration Job has already
          // advanced PostgreSQL; recovery must use the explicit forward
          // rollback path below. A forward rollback itself does not mutate the
          // schema, so Helm may safely make that one operation atomic.
          ...(rollbackManifestPath ? ['--atomic'] : []),
          '--wait',
          '--wait-for-jobs',
          '--timeout',
          timeout,
        ]);
    } catch (error) {
      await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
      const recoveryGuidance = rollbackManifestPath
        ? 'The forward rollback was atomic because it does not run a schema migration.'
        : 'The candidate was intentionally not rolled back automatically because its schema migration may already have committed. Inspect the saved diagnostics, then repair forward or run the documented forward rollback; do not use helm rollback.';
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n[${runnerName}] ${recoveryGuidance} Inspect ${path.relative(rootDir, artifactsDir)} before taking the next recovery action.`,
      );
    }
    await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
    console.log(
      `[${runnerName}] ${rollbackManifestPath ? 'Forward rollback' : 'Production release'} completed. Diagnostics: ${path.relative(rootDir, artifactsDir)}.`,
    );
  } finally {
    if (generatedValuesDir) {
      await fs.rm(generatedValuesDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[${runnerName}] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
