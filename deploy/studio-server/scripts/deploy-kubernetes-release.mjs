import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
  assertStudioServerReleaseManifest,
  createForwardRollbackHelmValues,
  createProductionHelmValues,
} from './lib/studio-server-release-manifest.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

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
]);

function parseArgs(argv) {
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
    if (key === '--dry-run') {
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

async function assertReleaseManifestMatchesCurrentCheckout(manifest) {
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

async function assertCleanTrackedCheckout() {
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

async function run(program, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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
    child.once('exit', (code) => {
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

async function writeArtifact(artifactsDir, fileName, contents) {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, fileName), contents, 'utf8');
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
  const manifestPath = insideRepository(required(options, '--manifest'), '--manifest');
  const valuesPath = insideRepository(required(options, '--values'), '--values');
  const rollbackManifestPath = options.has('--rollback-to')
    ? insideRepository(required(options, '--rollback-to'), '--rollback-to')
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
  const manifest = await readManifest(manifestPath, { requirePromoted: true });
  await assertReleaseManifestMatchesCurrentCheckout(manifest);
  await assertCleanTrackedCheckout();
  assertReleaseManifestMatchesCurrentChart(manifest, rootDir);
  const generatedValues = rollbackManifestPath
    ? createForwardRollbackHelmValues({
        failedRelease: manifest,
        rollbackRelease: await readManifest(rollbackManifestPath, { requirePromoted: true }),
      })
    : createProductionHelmValues(manifest);
  let generatedValuesDir;
  try {
    generatedValuesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-production-release-'));
    const generatedValuesPath = path.join(generatedValuesDir, 'immutable-release-values.json');
    await fs.writeFile(generatedValuesPath, `${JSON.stringify(generatedValues, null, 2)}\n`, 'utf8');

    const helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName: runnerName });
    const valueArgs = ['--values', productionOverlayPath, '--values', valuesPath, '--values', generatedValuesPath];
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

    if (dryRun) {
      console.log(`[${runnerName}] Preflight passed. No cluster state was changed.`);
      return;
    }

    await captureHelmDiagnostics(helmBin, release, namespace, artifactsDir);
    try {
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

main().catch((error) => {
  console.error(`[${runnerName}] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
