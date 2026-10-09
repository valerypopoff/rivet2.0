import path from 'node:path';
import { loadDevEnv, developmentFrontendEnv } from './lib/dev-env.mjs';
import {
  assertValidPort,
  composeProjectInputFingerprint,
  reconcileComposeProjectConfiguration,
  ensurePortAvailable,
  hasBindMountInputOutputError,
  isComposeServiceRunning,
  printFailureDiagnostics,
  readDockerWaitTimeoutSeconds,
  run,
  runCapture,
} from './lib/docker-launcher.mjs';
import { assertNoRetiredEnv, dropAmbientNodeOptionsForDocker } from './lib/docker-launcher-env.mjs';
import { withLauncherProgress } from './lib/launcher-progress.mjs';
const rootDir = process.cwd();
const composeProject = 'rivet-studio-server-dev';
const composeConfigFiles = [
  'deploy/studio-server/compose/docker-compose.managed-services.yml',
  'deploy/studio-server/compose/docker-compose.dev.yml',
];
let composeBase = `docker compose -p ${composeProject} -f ${composeConfigFiles[0]} -f ${composeConfigFiles[1]}`;
const diagnosticServices = 'api web proxy';
const progress = (step, operation) => withLauncherProgress('dev-docker', step, operation);
let envFileLabel = '.env';

const devDependencyMarkerChecks = {
  web: [
    'test -f /workspace/node_modules/.studio-server-yarn-install-ok',
    'test -f /workspace/node_modules/.yarn.lock',
    'cmp -s /workspace/yarn.lock /workspace/node_modules/.yarn.lock',
  ].join(' && '),
  api: [
    'test -f /workspace/node_modules/.studio-server-yarn-install-ok',
    'test -f /workspace/node_modules/.yarn.lock',
    'cmp -s /workspace/yarn.lock /workspace/node_modules/.yarn.lock',
  ].join(' && '),
};

const workspaceSourceProbe = "find /workspace/packages/core/src -type f -name '*.ts' -exec cat {} + >/dev/null";

async function runningServiceDependenciesNeedRefresh(service, env) {
  const result = await runCapture(
    `${composeBase} exec -T ${service} sh -lc "${devDependencyMarkerChecks[service]}"`,
    env,
    {
      allowFailure: true,
      cwd: rootDir,
    },
  );

  return result.exitCode !== 0;
}

async function runningServiceHasBrokenWorkspaceBindMount(service, env) {
  const result = await runCapture(`${composeBase} exec -T ${service} sh -lc \"${workspaceSourceProbe}\"`, env, {
    allowFailure: true,
    cwd: rootDir,
  });
  return hasBindMountInputOutputError(`${result.stdout}\n${result.stderr}`);
}

async function runningWorkspaceBindMountNeedsRecovery(env) {
  return (
    (await isComposeServiceRunning('api', { composeBase, cwd: rootDir, env })) &&
    (await runningServiceHasBrokenWorkspaceBindMount('api', env))
  );
}

async function assertWorkspaceBindMountReadable(env) {
  const result = await runCapture(
    `${composeBase} run --rm --no-deps --entrypoint sh api -lc \"${workspaceSourceProbe}\"`,
    env,
    { allowFailure: true, cwd: rootDir, streamOutput: true },
  );
  if (!hasBindMountInputOutputError(`${result.stdout}\n${result.stderr}`)) {
    return;
  }

  throw new Error(
    '[dev-docker] Docker Desktop cannot read the mounted workspace source (input/output error). The repository files and imports are not missing. Restore Docker Desktop access to this checkout (for example, restart Docker Desktop or use a checkout on the WSL filesystem), then run yarn studio-server:dev again.',
  );
}

async function devStackHasBindMountInputOutputError(env) {
  const result = await runCapture(`${composeBase} logs --tail=200 api web`, env, {
    allowFailure: true,
    cwd: rootDir,
  });
  return hasBindMountInputOutputError(`${result.stdout}\n${result.stderr}`);
}

async function runCommandsWithBindMountRecovery(commands, env, waitTimeoutSeconds) {
  try {
    for (const { step, command } of commands) {
      await progress(step, () => run(command, env, { cwd: rootDir }));
    }
  } catch (error) {
    if ((await devStackHasBindMountInputOutputError(env)) === false) {
      throw error;
    }

    console.warn(
      '[dev-docker] Docker Desktop lost access to the mounted workspace during startup. Recreating this dev stack once to refresh the bind mount; named volumes and mounted project data are preserved.',
    );
    await progress('Stopping services for bind-mount recovery', () =>
      run(`${composeBase} down --remove-orphans --timeout 20`, env, { allowFailure: true, cwd: rootDir }),
    );
    try {
      await progress('Retrying development startup; waiting for readiness', () =>
        run(`${composeBase} up -d --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`, env, {
          cwd: rootDir,
        }),
      );
    } catch (retryError) {
      await run(`${composeBase} down --remove-orphans --timeout 20`, env, { allowFailure: true, cwd: rootDir });
      throw new Error(
        '[dev-docker] Docker Desktop still cannot read the mounted workspace after one remount retry. The repository files and imports are not missing. Restore Docker Desktop access to this checkout (for example, restart Docker Desktop or use a checkout on the WSL filesystem), then run yarn studio-server:dev again.',
        { cause: retryError },
      );
    }
  }
}

async function main() {
  const action = process.argv[2] == null ? 'dev' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile, fileEnv } = loadDevEnv(rootDir);
  const frontendMode = process.argv[3] ?? 'live';
  Object.assign(mergedEnv, developmentFrontendEnv(frontendMode));
  dropAmbientNodeOptionsForDocker(mergedEnv, fileEnv);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    mergedEnv.RIVET_RUNTIME_ENV_FILE = envPath;
    composeConfigFiles.push('deploy/studio-server/compose/docker-compose.runtime-env.yml');
    composeBase = `docker compose -p ${composeProject} --env-file "${relativeEnvPath}" -f ${composeConfigFiles[0]} -f ${composeConfigFiles[1]} -f ${composeConfigFiles[2]}`;
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  // Keep local Node and endpoint execution off a configured outbound proxy.
  // Compose maps this hostname to Docker's supported host-gateway address.
  mergedEnv.RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS = 'host.docker.internal';

  assertNoRetiredEnv(mergedEnv, { launcherName: 'dev-docker', envFileLabel });
  const starting = ['dev', 'up', 'recreate', 'build'].includes(action);
  const phase = (step, operation) => (starting ? progress(step, operation) : operation());
  const projectInputFingerprint = await phase('Checking development Compose inputs', () =>
    composeProjectInputFingerprint({
      composeConfigFiles,
      cwd: rootDir,
    }),
  );
  mergedEnv.RIVET_DEV_STACK_INPUT_FINGERPRINT = projectInputFingerprint;

  const waitTimeoutSeconds = await phase('Reading startup readiness limits', () =>
    readDockerWaitTimeoutSeconds({
      composeBase,
      cwd: rootDir,
      env: mergedEnv,
      label: 'dev-docker',
    }),
  );
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);
  if (action === 'dev')
    console.log(
      `[dev-docker] Frontend: ${frontendMode === 'tunnel' ? 'watched bundles with safe full refresh' : 'Vite hot reload'}. Local URL: http://localhost:${proxyPort}/; API/executor watching is unchanged.`,
    );
  if (action === 'dev' && frontendMode === 'tunnel')
    console.log(
      '[dev-docker] Building the initial frontend; readiness waits for a complete bundle. Build progress/errors: yarn studio-server:dev:docker:logs (web service).',
    );
  const staleDependencyServices = [];

  const composeStep = (step, args) => ({ step, command: `${composeBase} ${args}` });
  const stopStep = composeStep('Stopping development services', 'down --remove-orphans --timeout 20');
  const startStep = composeStep(
    'Starting development services; waiting for readiness',
    `up -d --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
  );
  const buildStartStep = composeStep(
    'Building and starting development services; waiting for readiness',
    `up -d --build --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
  );
  const commandsByAction = {
    build: [composeStep('Building development images', 'build api')],
    up: [composeStep(null, 'up --build --remove-orphans')],
    down: [composeStep(null, 'down --remove-orphans')],
    config: [composeStep(null, 'config --no-interpolate --no-env-resolution --no-path-resolution')],
    services: [composeStep(null, 'config --services')],
    ps: [composeStep(null, 'ps')],
    logs: [composeStep(null, `logs -f --tail=120 ${diagnosticServices}`)],
    dev: [startStep],
    recreate: [stopStep, buildStartStep],
  };

  let commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: yarn studio-server:dev[:docker:*]');
    process.exit(1);
  }

  try {
    if (action === 'dev' || action === 'up') {
      await phase('Reconciling the development stack configuration', () =>
        reconcileComposeProjectConfiguration({
          composeProject,
          expectedConfigFiles: composeConfigFiles,
          expectedProjectFingerprint: projectInputFingerprint,
          cwd: rootDir,
          env: mergedEnv,
          label: 'dev-docker',
        }),
      );
    }

    if (action === 'dev' || action === 'up') {
      await phase('Checking published ports', async () => {
        const proxyAlreadyRunning = await isComposeServiceRunning('proxy', {
          composeBase,
          cwd: rootDir,
          env: mergedEnv,
        });
        if (!proxyAlreadyRunning) {
          await ensurePortAvailable(proxyPort, {
            envFileLabel,
            label: 'dev-docker',
          });
        }
      });

      await phase('Checking workspace access inside Docker', () => assertWorkspaceBindMountReadable(mergedEnv));
    }

    if (action === 'dev') {
      await phase('Checking workspace health and dependency markers', async () => {
        if (await runningWorkspaceBindMountNeedsRecovery(mergedEnv)) {
          console.warn(
            '[dev-docker] Docker Desktop returned an input/output error while reading the mounted Core source. Recreating only this dev stack to refresh the bind mount; named volumes and mounted project data are preserved.',
          );
          commands = [stopStep, startStep];
        }

        for (const service of ['web', 'api']) {
          const alreadyRunning = await isComposeServiceRunning(service, {
            composeBase,
            cwd: rootDir,
            env: mergedEnv,
          });

          if (alreadyRunning && (await runningServiceDependenciesNeedRefresh(service, mergedEnv))) {
            staleDependencyServices.push(service);
          }
        }

        if (staleDependencyServices.length > 0) {
          console.log(
            `[dev-docker] Restarting the dev stack because dependency markers changed for ${staleDependencyServices.join(', ')}.`,
          );
          commands = [stopStep, buildStartStep];
        }
      });
    }

    if (action === 'dev') {
      await runCommandsWithBindMountRecovery(commands, mergedEnv, waitTimeoutSeconds);
    } else {
      for (const { step, command } of commands) {
        // Attached `up` stays alive to stream service logs; it is not a finite
        // readiness phase. Do not print perpetual "starting" heartbeats.
        if (action === 'up') {
          console.log('[dev-docker] Starting services in attached mode; streaming Docker output.');
          await run(command, mergedEnv, { cwd: rootDir });
          continue;
        }
        await phase(step, () => run(command, mergedEnv, { cwd: rootDir }));
      }
    }

    if (action === 'dev') {
      // nginx resolves Compose service names when its configuration loads. The
      // API/web containers can be recreated with new bridge-network addresses
      // while the proxy itself stays up, so refresh that resolution after every
      // normal dev bring-up without recreating the proxy or its dependencies.
      await phase('Refreshing proxy upstream addresses', () =>
        run(`${composeBase} exec -T proxy nginx -s reload`, mergedEnv, { cwd: rootDir }),
      );
    }
  } catch (error) {
    if (action === 'dev' || action === 'up') {
      await printFailureDiagnostics({
        composeBase,
        cwd: rootDir,
        diagnosticServices,
        env: mergedEnv,
        label: 'dev-docker',
      });
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
