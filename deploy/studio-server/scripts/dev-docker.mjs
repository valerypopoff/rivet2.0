import path from 'node:path';
import { loadDevEnv } from './lib/dev-env.mjs';
import {
  assertValidPort,
  ensurePortAvailable,
  isComposeServiceRunning,
  printFailureDiagnostics,
  readDockerWaitTimeoutSeconds,
  run,
  runCapture,
} from './lib/docker-launcher.mjs';
import {
  assertNoRetiredEnv,
  dropAmbientNodeOptionsForDocker,
} from './lib/docker-launcher-env.mjs';
const rootDir = process.cwd();
const composeProject = 'rivet-studio-server-dev';
let composeBase = `docker compose -p ${composeProject} -f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.dev.yml`;
const diagnosticServices = 'api web executor proxy';
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

async function runningServiceDependenciesNeedRefresh(service, env) {
  const result = await runCapture(`${composeBase} exec -T ${service} sh -lc "${devDependencyMarkerChecks[service]}"`, env, {
    allowFailure: true,
    cwd: rootDir,
  });

  return result.exitCode !== 0;
}

async function main() {
  const action = process.argv[2] == null ? 'dev' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile, fileEnv } = loadDevEnv(rootDir);
  dropAmbientNodeOptionsForDocker(mergedEnv, fileEnv);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    mergedEnv.RIVET_RUNTIME_ENV_FILE = envPath;
    composeBase = `docker compose -p ${composeProject} --env-file "${relativeEnvPath}" -f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.dev.yml -f deploy/studio-server/compose/docker-compose.runtime-env.yml`;
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  // Keep local Node and endpoint execution off a configured outbound proxy.
  // Compose maps this hostname to Docker's supported host-gateway address.
  mergedEnv.RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS = 'host.docker.internal';

  assertNoRetiredEnv(mergedEnv, { launcherName: 'dev-docker', envFileLabel });

  const waitTimeoutSeconds = await readDockerWaitTimeoutSeconds({
    composeBase,
    cwd: rootDir,
    env: mergedEnv,
    label: 'dev-docker',
  });
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);
  let refreshRunningProxy = false;

  const commandsByAction = {
    build: [`${composeBase} build api executor`],
    up: [`${composeBase} up --build`],
    down: [`${composeBase} down`],
    config: [`${composeBase} config --no-interpolate --no-env-resolution --no-path-resolution`],
    services: [`${composeBase} config --services`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    dev: [`${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`],
    recreate: [`${composeBase} up -d --build --force-recreate --wait --wait-timeout ${waitTimeoutSeconds}`],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: yarn studio-server:dev[:docker:*]');
    process.exit(1);
  }

  try {
    if (action === 'dev' || action === 'up') {
      const proxyAlreadyRunning = await isComposeServiceRunning('proxy', {
        composeBase,
        cwd: rootDir,
        env: mergedEnv,
      });
      refreshRunningProxy = action === 'dev' && proxyAlreadyRunning;

      if (!proxyAlreadyRunning) {
        await ensurePortAvailable(proxyPort, {
          envFileLabel,
          label: 'dev-docker',
        });
      }
    }

    if (action === 'dev') {
      for (const service of ['web', 'api']) {
        const alreadyRunning = await isComposeServiceRunning(service, {
          composeBase,
          cwd: rootDir,
          env: mergedEnv,
        });

        if (alreadyRunning && (await runningServiceDependenciesNeedRefresh(service, mergedEnv))) {
          console.log(`[dev-docker] Recreating ${service} because dependency markers changed.`);
          await run(
            `${composeBase} up -d --no-deps --force-recreate --wait --wait-timeout ${waitTimeoutSeconds} ${service}`,
            mergedEnv,
            { cwd: rootDir },
          );
        }
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv, { cwd: rootDir });
    }

    if (refreshRunningProxy) {
      await run(
        `${composeBase} up -d --no-deps --force-recreate --wait --wait-timeout ${waitTimeoutSeconds} proxy`,
        mergedEnv,
        { cwd: rootDir },
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
