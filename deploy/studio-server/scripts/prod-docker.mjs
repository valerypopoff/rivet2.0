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
const rootDir = process.cwd();
const composeProject = 'rivet-studio-server-prod';
let composeBase = `docker compose -p ${composeProject} -f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.yml`;
const diagnosticServices = 'api web executor proxy';
let envFileLabel = '.env';

async function main() {
  const action = process.argv[2] == null ? 'prebuilt' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile, fileEnv } = loadDevEnv(rootDir);
  dropAmbientNodeOptionsForDocker(mergedEnv, fileEnv);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    mergedEnv.RIVET_RUNTIME_ENV_FILE = envPath;
    composeBase = `docker compose -p ${composeProject} --env-file "${relativeEnvPath}" -f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.yml -f deploy/studio-server/compose/docker-compose.runtime-env.yml`;
  }

  assertNoRetiredEnv(mergedEnv, { launcherName: 'prod-docker', envFileLabel });

  if (action === 'custom') {
    if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
      mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
    }
  }

  const waitTimeoutSeconds = await readDockerWaitTimeoutSeconds({
    composeBase,
    cwd: rootDir,
    env: mergedEnv,
    label: 'prod-docker',
  });
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);
  const commandsByAction = {
    config: [`${composeBase} config --no-interpolate --no-env-resolution --no-path-resolution`],
    services: [`${composeBase} config --services`],
    prebuilt: [
      `${composeBase} pull proxy web api executor`,
      `${composeBase} up -d --no-build --force-recreate --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
    restart: [
      `${composeBase} up -d --no-build --force-recreate --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
    custom: [
      `${composeBase} up -d --build --force-recreate --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: yarn studio-server:prod[:config|:services|:restart|:custom]');
    process.exit(1);
  }

  try {
    if (action !== 'config' && action !== 'services') {
      const proxyAlreadyRunning = await isComposeServiceRunning('proxy', {
        composeBase,
        cwd: rootDir,
        env: mergedEnv,
      });
      if (!proxyAlreadyRunning) {
        await ensurePortAvailable(proxyPort, {
          envFileLabel,
          label: 'prod-docker',
        });
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv, { cwd: rootDir });
    }
  } catch (error) {
    await printFailureDiagnostics({
      composeBase,
      cwd: rootDir,
      diagnosticServices,
      env: mergedEnv,
      label: 'prod-docker',
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
