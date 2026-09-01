import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const DEFAULT_DOCKER_WAIT_TIMEOUT_SECONDS = 1200;

export function run(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;
  const stdio = options.stdio ?? 'inherit';
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0 || allowFailure) {
        resolve(exitCode);
      } else {
        reject(new Error(`Command failed with exit code ${exitCode}: ${command}`));
      }
    });
  });
}

export function runCapture(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0 || allowFailure) {
        resolve({ exitCode, stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${exitCode}: ${command}\n${stderr}`.trim()));
      }
    });
  });
}

export function assertValidPort(value, fallback) {
  const parsed = parseInt(value == null ? '' : value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function ensurePortAvailable(port, options) {
  const { envFileLabel, label } = options;

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(`[${label}] Host port ${port} is already in use. Set RIVET_PORT in ${envFileLabel} to a free port, or stop the process currently listening on ${port}.`));
        return;
      }

      reject(error);
    });

    server.once('listening', () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve();
      });
    });

    server.listen(port, '0.0.0.0');
  });
}

export async function isComposeServiceRunning(service, options) {
  const { composeBase, cwd, env } = options;
  const result = await runCapture(`${composeBase} ps --status running --services ${service}`, env, {
    allowFailure: true,
    cwd,
  });

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(service);
}

function composeConfigFileName(value) {
  return String(value).trim().replaceAll('\\', '/').split('/').pop().toLowerCase();
}

export function composeConfigFilesMatch(configFilesLabel, expectedConfigFiles) {
  if (typeof configFilesLabel !== 'string' || !configFilesLabel.trim()) {
    return false;
  }

  const actual = configFilesLabel
    .split(',')
    .map(composeConfigFileName)
    .filter(Boolean)
    .sort();
  const expected = expectedConfigFiles
    .map(composeConfigFileName)
    .filter(Boolean)
    .sort();

  return actual.length === expected.length && actual.every((file, index) => file === expected[index]);
}

export function composeProjectFingerprintMatches(actualFingerprint, expectedFingerprint) {
  return typeof expectedFingerprint === 'string' && actualFingerprint === expectedFingerprint;
}

export async function composeProjectInputFingerprint(options) {
  const {
    composeConfigFiles,
    cwd = process.cwd(),
  } = options;
  const hash = createHash('sha256');

  for (const configFile of composeConfigFiles) {
    const resolvedConfigFile = path.resolve(cwd, configFile);
    hash.update(`compose:${configFile}\n`);
    hash.update(await readFile(resolvedConfigFile));
  }

  return hash.digest('hex');
}

export async function reconcileComposeProjectConfiguration(options) {
  const {
    composeProject,
    expectedConfigFiles,
    expectedProjectFingerprint,
    cwd = process.cwd(),
    env,
    label = 'docker-launcher',
  } = options;
  const containersResult = await runCapture(
    `docker ps -aq --no-trunc --filter "label=com.docker.compose.project=${composeProject}"`,
    env,
    { allowFailure: true, cwd },
  );
  if (containersResult.exitCode !== 0) {
    return false;
  }

  const containerIds = containersResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containerIds.length === 0) {
    return false;
  }

  const labelsResult = await runCapture(
    `docker inspect --format "{{.Id}}|{{json .Config.Labels}}" ${containerIds.join(' ')}`,
    env,
    { allowFailure: true, cwd },
  );
  if (labelsResult.exitCode !== 0) {
    console.warn(`[${label}] Could not inspect the existing dev Compose containers; continuing with Docker Compose reconciliation.`);
    return false;
  }

  const labelsByContainerId = new Map(
    labelsResult.stdout
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('|');
        if (separator < 0) {
          return undefined;
        }

        try {
          const labels = JSON.parse(line.slice(separator + 1));
          return [line.slice(0, separator).trim(), labels];
        } catch {
          return undefined;
        }
      })
      .filter((entry) => entry != null),
  );
  const hasStaleConfiguration = containerIds.some((containerId) => {
    const labels = labelsByContainerId.get(containerId);
    return !composeConfigFilesMatch(labels?.['com.docker.compose.project.config_files'], expectedConfigFiles)
      || !composeProjectFingerprintMatches(
        labels?.['com.valerypopoff.rivet2.dev-stack-input-fingerprint'],
        expectedProjectFingerprint,
      );
  });
  if (!hasStaleConfiguration) {
    return false;
  }

  console.log(
    `[${label}] Replacing a dev stack created with different Compose inputs. Removing only project containers; named volumes, the project network, and mounted project data are preserved.`,
  );
  await run(`docker rm --force ${containerIds.join(' ')}`, env, { cwd });

  return true;
}

export async function readDockerWaitTimeoutSeconds(options) {
  const { composeBase, cwd, env, label = 'docker-launcher' } = options;

  for (const service of ['api', 'proxy']) {
    const psResult = await runCapture(`${composeBase} ps -q ${service}`, env, {
      allowFailure: true,
      cwd,
    });
    const containerId = psResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!containerId) {
      continue;
    }

    const settingsResult = await runCapture(
      `docker exec ${containerId} cat /data/rivet-app/settings/runtime-limits.json`,
      env,
      {
        allowFailure: true,
        cwd,
      },
    );

    if (settingsResult.exitCode !== 0 || !settingsResult.stdout.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(settingsResult.stdout);
      const timeout = Number(parsed?.dockerWaitTimeoutSeconds);
      if (Number.isInteger(timeout) && timeout > 0) {
        return timeout;
      }

      console.warn(`[${label}] Ignoring invalid saved Docker startup wait timeout; using ${DEFAULT_DOCKER_WAIT_TIMEOUT_SECONDS}s.`);
    } catch {
      console.warn(`[${label}] Could not parse saved runtime limit settings; using ${DEFAULT_DOCKER_WAIT_TIMEOUT_SECONDS}s.`);
    }
  }

  return DEFAULT_DOCKER_WAIT_TIMEOUT_SECONDS;
}

export async function printFailureDiagnostics(options) {
  const { composeBase, cwd, diagnosticServices, env, label } = options;
  console.error(`[${label}] Docker compose reported a failure. Collecting container status and recent logs...`);
  await run(`${composeBase} ps`, env, { allowFailure: true, cwd });
  await run(`${composeBase} logs --tail=120 ${diagnosticServices}`, env, { allowFailure: true, cwd });
}
