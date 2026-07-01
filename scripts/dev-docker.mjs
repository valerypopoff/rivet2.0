import path from 'node:path';
import { loadDevEnv } from './lib/dev-env.mjs';
import {
  assertValidPort,
  ensurePortAvailable,
  isComposeServiceRunning,
  printFailureDiagnostics,
  readDockerWaitTimeoutSeconds,
  run,
} from './lib/docker-launcher.mjs';
import {
  assertNoRetiredEnv,
  dropAmbientNodeOptionsForDocker,
} from './lib/docker-launcher-env.mjs';
import { prepareRivetDockerContext } from './lib/rivet-source-context.mjs';

const rootDir = process.cwd();
let composeBase = 'docker compose -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.dev.yml';
const diagnosticServices = 'api web executor proxy';
let envFileLabel = '.env';

async function main() {
  const action = process.argv[2] == null ? 'dev' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile, fileEnv } = loadDevEnv(rootDir);
  dropAmbientNodeOptionsForDocker(mergedEnv, fileEnv);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    composeBase = `docker compose --env-file "${relativeEnvPath}" -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.dev.yml`;
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  assertNoRetiredEnv(mergedEnv, { launcherName: 'dev-docker', envFileLabel });

  if (['build', 'up', 'dev', 'recreate'].includes(action)) {
    prepareRivetDockerContext(rootDir, mergedEnv);
  }

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
    config: [`${composeBase} config`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    dev: [`${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`],
    recreate: [`${composeBase} up -d --build --force-recreate --wait --wait-timeout ${waitTimeoutSeconds}`],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: node scripts/dev-docker.mjs [dev|recreate|build|up|down|config|ps|logs]');
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
