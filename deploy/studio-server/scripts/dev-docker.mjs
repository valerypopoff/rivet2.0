import path from 'node:path';
import { loadDevEnv } from './lib/dev-env.mjs';
import {
  assertValidPort,
  composeProjectInputFingerprint,
  reconcileComposeProjectConfiguration,
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
const composeConfigFiles = [
  'deploy/studio-server/compose/docker-compose.managed-services.yml',
  'deploy/studio-server/compose/docker-compose.dev.yml',
];
let composeBase = `docker compose -p ${composeProject} -f ${composeConfigFiles[0]} -f ${composeConfigFiles[1]}`;
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
  const projectInputFingerprint = await composeProjectInputFingerprint({
    composeConfigFiles,
    cwd: rootDir,
  });
  mergedEnv.RIVET_DEV_STACK_INPUT_FINGERPRINT = projectInputFingerprint;

  const waitTimeoutSeconds = await readDockerWaitTimeoutSeconds({
    composeBase,
    cwd: rootDir,
    env: mergedEnv,
    label: 'dev-docker',
  });
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);
  const staleDependencyServices = [];

  const commandsByAction = {
    build: [`${composeBase} build api executor`],
    up: [`${composeBase} up --build --remove-orphans`],
    down: [`${composeBase} down --remove-orphans`],
    config: [`${composeBase} config --no-interpolate --no-env-resolution --no-path-resolution`],
    services: [`${composeBase} config --services`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    dev: [`${composeBase} up -d --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`],
    recreate: [
      `${composeBase} down --remove-orphans --timeout 20`,
      `${composeBase} up -d --build --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
  };

  let commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: yarn studio-server:dev[:docker:*]');
    process.exit(1);
  }

  try {
    if (action === 'dev' || action === 'up') {
      await reconcileComposeProjectConfiguration({
        composeProject,
        expectedConfigFiles: composeConfigFiles,
        expectedProjectFingerprint: projectInputFingerprint,
        cwd: rootDir,
        env: mergedEnv,
        label: 'dev-docker',
      });
    }

    if (action === 'dev' || action === 'up') {
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
    }

    if (action === 'dev') {
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
        commands = [
          `${composeBase} down --remove-orphans --timeout 20`,
          `${composeBase} up -d --build --remove-orphans --wait --wait-timeout ${waitTimeoutSeconds}`,
        ];
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv, { cwd: rootDir });
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
