export const retiredEnvReplacements = {
  RIVET_STORAGE_BACKEND: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_BACKEND: 'Settings -> Storage',
  RIVET_DATABASE_URL: 'Settings -> Storage',
  RIVET_WORKFLOWS_DATABASE_MODE: 'Settings -> Storage',
  RIVET_WORKFLOWS_DATABASE_URL: 'Settings -> Storage',
  RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: 'Settings -> Storage',
  RIVET_WORKFLOWS_DATABASE_SSL_MODE: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_BUCKET: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_REGION: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_ENDPOINT: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_ACCESS_KEY_ID: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'Settings -> Storage',
  RIVET_STORAGE_SECRET_ACCESS_KEY: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_PREFIX: 'Settings -> Storage',
  RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_URL: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_BUCKET: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_REGION: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_ENDPOINT: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_PREFIX: 'Settings -> Storage',
  RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE: 'Settings -> Storage',
  RIVET_PROXY_READ_TIMEOUT: 'Settings -> Workflow endpoints',
  RIVET_REQUIRE_WORKFLOW_KEY: 'Settings -> Workflow endpoints',
  RIVET_COMMAND_TIMEOUT: 'Settings -> General',
  RIVET_MAX_OUTPUT: 'Settings -> General',
  RIVET_DOCKER_WAIT_TIMEOUT: 'Settings -> Docker',
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
};

export function listActiveRetiredEnv(env) {
  return Object.entries(retiredEnvReplacements)
    .filter(([name]) => String(env[name] ?? '').trim())
    .map(([name, replacement]) => `${name} -> ${replacement}`);
}

export function assertNoRetiredEnv(env, options = {}) {
  const activeRetired = listActiveRetiredEnv(env);

  if (activeRetired.length === 0) {
    return;
  }

  const launcherName = options.launcherName ?? 'docker-launcher';
  const envFileLabel = options.envFileLabel ?? '.env';

  throw new Error(
    `[${launcherName}] Retired environment variable(s) detected in ${envFileLabel}: ${activeRetired.join(', ')}. ` +
    'Remove retired runtime values from the env file and configure them in the App Settings UI.',
  );
}

export function dropAmbientNodeOptionsForDocker(env, fileEnv = {}) {
  // Yarn PnP injects host-only NODE_OPTIONS when scripts run through `yarn`.
  // Do not pass those Windows/macOS preload paths into Linux Docker containers.
  if (!Object.prototype.hasOwnProperty.call(fileEnv, 'NODE_OPTIONS')) {
    delete env.NODE_OPTIONS;
  }

  return env;
}
