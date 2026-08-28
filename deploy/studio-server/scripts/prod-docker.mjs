import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { assertNoRetiredEnv, dropAmbientNodeOptionsForDocker } from './lib/docker-launcher-env.mjs';
const rootDir = process.cwd();
// Older standalone deployments used either Compose project name below, depending
// on the Docker Compose version that first created their named volumes. Detect a
// single legacy app-data volume so an in-place monorepo cutover keeps its state.
export const DEFAULT_PRODUCTION_COMPOSE_PROJECT = 'compose';
export const LEGACY_PRODUCTION_COMPOSE_PROJECTS = ['ops', DEFAULT_PRODUCTION_COMPOSE_PROJECT];
const composeProjectNamePattern = /^[a-z0-9][a-z0-9_-]*$/;
const diagnosticServices = 'api web executor proxy';

export function appDataVolumeName(composeProject) {
  return `${composeProject}_rivet_data`;
}

export async function resolveProductionComposeProject({ environment, volumeExists }) {
  const explicitlyConfiguredProject = environment.RIVET_STUDIO_SERVER_COMPOSE_PROJECT?.trim();
  if (explicitlyConfiguredProject) {
    if (!composeProjectNamePattern.test(explicitlyConfiguredProject)) {
      throw new Error(
        'RIVET_STUDIO_SERVER_COMPOSE_PROJECT must be a lowercase Docker Compose project name containing only letters, numbers, hyphens, and underscores.',
      );
    }

    return { composeProject: explicitlyConfiguredProject, source: 'configured' };
  }

  const detectedProjects = [];
  for (const candidate of LEGACY_PRODUCTION_COMPOSE_PROJECTS) {
    if (await volumeExists(appDataVolumeName(candidate))) {
      detectedProjects.push(candidate);
    }
  }

  if (detectedProjects.length > 1) {
    const discoveredVolumes = detectedProjects.map(appDataVolumeName).join(', ');
    throw new Error(
      `Found multiple legacy Studio Server app-data volumes (${discoveredVolumes}). To protect persisted settings and evaluation history, set RIVET_STUDIO_SERVER_COMPOSE_PROJECT in .env to the project that owns the production data.`,
    );
  }

  if (detectedProjects.length === 1) {
    return { composeProject: detectedProjects[0], source: 'detected' };
  }

  return { composeProject: DEFAULT_PRODUCTION_COMPOSE_PROJECT, source: 'default' };
}

async function dockerVolumeExists(volumeName, environment) {
  const result = await runCapture(`docker volume inspect ${volumeName}`, environment, {
    allowFailure: true,
    cwd: rootDir,
  });
  return result.exitCode === 0;
}

function composeCommand(project, suffix) {
  return `docker compose -p ${project} ${suffix}`;
}

async function main() {
  const action = process.argv[2] == null ? 'prebuilt' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile, fileEnv } = loadDevEnv(rootDir);
  dropAmbientNodeOptionsForDocker(mergedEnv, fileEnv);

  const envFileLabel = path.basename(envPath);
  const { composeProject, source } = await resolveProductionComposeProject({
    environment: mergedEnv,
    volumeExists: (volumeName) => dockerVolumeExists(volumeName, mergedEnv),
  });
  if (source === 'detected') {
    console.log(
      `[prod-docker] Reusing detected legacy app-data volume ${appDataVolumeName(composeProject)} (Compose project ${composeProject}).`,
    );
  }

  let composeBase = composeCommand(
    composeProject,
    '-f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.yml',
  );
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    mergedEnv.RIVET_RUNTIME_ENV_FILE = envPath;
    composeBase = composeCommand(
      composeProject,
      `--env-file "${relativeEnvPath}" -f deploy/studio-server/compose/docker-compose.managed-services.yml -f deploy/studio-server/compose/docker-compose.yml -f deploy/studio-server/compose/docker-compose.runtime-env.yml`,
    );
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
