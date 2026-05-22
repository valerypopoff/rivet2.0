import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';
import {
  assertNoRetiredEnv,
  enableManagedWorkflowProfileIfNeeded,
} from './lib/docker-launcher-env.mjs';

const rootDir = process.cwd();
const apiPackageDir = path.join(rootDir, 'wrapper', 'api');
const sampleProjectPath = path.join(rootDir, 'rivet', 'packages', 'node', 'test', 'test-graphs.rivet-project');
const repoLocalEnvKeysToScrub = [
  'RIVET_ENV_FILE',
  'RIVET_API_PROFILE',
  'RIVET_STORAGE_MODE',
  'RIVET_KEY',
  'RIVET_REQUIRE_WORKFLOW_KEY',
  'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER',
  'RIVET_UI_TOKEN_FREE_HOSTS',
  'RIVET_PUBLISHED_WORKFLOWS_BASE_PATH',
  'RIVET_LATEST_WORKFLOWS_BASE_PATH',
  'RIVET_WORKSPACE_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_WORKFLOW_RECORDINGS_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
  'RIVET_EXTRA_ROOTS',
  'RIVET_ENV_ALLOWLIST',
  'RIVET_SHELL_ALLOWLIST',
  'RIVET_COMMAND_TIMEOUT',
  'RIVET_MAX_OUTPUT',
  'RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS',
  'RIVET_ARTIFACTS_HOST_PATH',
  'RIVET_WORKFLOWS_HOST_PATH',
  'RIVET_WORKFLOW_RECORDINGS_HOST_PATH',
  'RIVET_RUNTIME_LIBS_HOST_PATH',
  'RIVET_RUNTIME_PROCESS_ROLE',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER',
  'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED',
  'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
  'RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS',
  'RIVET_DATABASE_MODE',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_STORAGE_URL',
  'RIVET_STORAGE_BUCKET',
  'RIVET_STORAGE_REGION',
  'RIVET_STORAGE_ENDPOINT',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_STORAGE_PREFIX',
  'RIVET_STORAGE_FORCE_PATH_STYLE',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
  'RIVET_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
  'RIVET_WORKFLOWS_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_OBJECT_STORAGE_PREFIX',
  'RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_RECORDINGS_COMPRESS',
  'RIVET_RECORDINGS_DATASET_MODE',
  'RIVET_RECORDINGS_GZIP_LEVEL',
  'RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS',
  'RIVET_RECORDINGS_INCLUDE_TRACE',
  'RIVET_RECORDINGS_RETENTION_DAYS',
  'RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT',
  'RIVET_RECORDINGS_MAX_TOTAL_BYTES',
  'RIVET_RECORDINGS_MAX_PENDING_WRITES',
];

function readSampleProjectContents() {
  if (!fs.existsSync(sampleProjectPath)) {
    throw new Error(
      'Compatibility fixtures require rivet/packages/node/test/test-graphs.rivet-project. ' +
      'Run "npm run setup" or "npm run setup:rivet" first.',
    );
  }

  return fs.readFileSync(sampleProjectPath, 'utf8');
}

function run(command, env = process.env, options = {}) {
  const stdio = options.stdio ?? 'inherit';
  const cwd = options.cwd ?? rootDir;

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code ?? 1}: ${command}`));
      }
    });
  });
}

function runCapture(command, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: rootDir,
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
      if ((code ?? 1) === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code ?? 1}: ${command}\n${stderr}`.trim()));
      }
    });
  });
}

function createRepoLocalTestEnv() {
  const env = {
    ...process.env,
  };

  for (const key of repoLocalEnvKeysToScrub) {
    delete env[key];
  }

  return env;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function buildFilesystemFixture(tempRoot) {
  const artifactsRoot = path.join(tempRoot, 'filesystem-artifacts');
  const workflowsRoot = path.join(artifactsRoot, 'workflows');
  const runtimeLibrariesRoot = path.join(artifactsRoot, 'runtime-libraries');
  const appDataRoot = path.join(tempRoot, 'app-data');
  const sampleProjectTarget = path.join(workflowsRoot, 'Compatibility Sample.rivet-project');
  const sampleProjectContents = readSampleProjectContents();

  fs.mkdirSync(workflowsRoot, { recursive: true });
  fs.mkdirSync(runtimeLibrariesRoot, { recursive: true });
  fs.mkdirSync(appDataRoot, { recursive: true });
  writeFile(sampleProjectTarget, sampleProjectContents);

  return {
    artifactsRoot,
    workflowsRoot,
    runtimeLibrariesRoot,
    appDataRoot,
  };
}

function buildMigrationFixture(tempRoot) {
  const migrationRoot = path.join(tempRoot, 'migration-source');
  const workflowsRoot = path.join(migrationRoot, 'workflows');
  const nestedRoot = path.join(workflowsRoot, 'Imported');
  const sampleProjectContents = readSampleProjectContents();

  fs.mkdirSync(nestedRoot, { recursive: true });
  writeFile(path.join(nestedRoot, 'Imported Example.rivet-project'), sampleProjectContents);

  return {
    migrationRoot,
    workflowsRoot,
  };
}

function createScenarioEnvFile(mode) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rivet-compat-${mode.replace(/[^a-z0-9-]/gi, '-')}-`));
  const filesystemFixture = buildFilesystemFixture(tempRoot);
  const migrationFixture = buildMigrationFixture(tempRoot);
  const envPath = path.join(tempRoot, '.env.compat');

  const lines = [
    'RIVET_KEY=compat-shared-key',
    'RIVET_REQUIRE_WORKFLOW_KEY=false',
    'RIVET_REQUIRE_UI_GATE_KEY=false',
    'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=false',
    `RIVET_APP_DATA_ROOT=${filesystemFixture.appDataRoot}`,
    `RIVET_RUNTIME_LIBRARIES_ROOT=${filesystemFixture.runtimeLibrariesRoot}`,
  ];

  if (mode === 'filesystem') {
    lines.push(
      'RIVET_STORAGE_MODE=filesystem',
      `RIVET_ARTIFACTS_HOST_PATH=${filesystemFixture.artifactsRoot}`,
    );
  } else if (mode === 'local-docker') {
    lines.push(
      'RIVET_STORAGE_MODE=managed',
      'RIVET_DATABASE_MODE=local-docker',
      'RIVET_DATABASE_CONNECTION_STRING=postgres://rivet:rivet@workflow-postgres:5432/rivet',
      'RIVET_DATABASE_SSL_MODE=disable',
      'RIVET_STORAGE_URL=http://workflow-minio:9000/rivet-workflows',
      'RIVET_STORAGE_ACCESS_KEY_ID=minioadmin',
      'RIVET_STORAGE_ACCESS_KEY=minioadmin',
      'RIVET_STORAGE_PREFIX=workflows/',
      'RIVET_STORAGE_FORCE_PATH_STYLE=true',
      `RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT=${migrationFixture.workflowsRoot}`,
    );
  } else {
    throw new Error(`Unknown scenario: ${mode}`);
  }

  writeFile(envPath, `${lines.join('\n')}\n`);

  return {
    tempRoot,
    envPath,
    filesystemFixture,
    migrationFixture,
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function loadScenarioEnv(envPath) {
  const previousEnvFile = process.env.RIVET_ENV_FILE;
  process.env.RIVET_ENV_FILE = envPath;

  try {
    return loadDevEnv(rootDir);
  } finally {
    if (previousEnvFile == null) {
      delete process.env.RIVET_ENV_FILE;
    } else {
      process.env.RIVET_ENV_FILE = previousEnvFile;
    }
  }
}

function assertFilesystemLauncherContract(loadedEnv, fixture) {
  const launcherEnv = {
    ...loadedEnv.mergedEnv,
  };

  assertNoRetiredEnv(launcherEnv, { launcherName: 'compatibility', envFileLabel: path.basename(loadedEnv.envPath) });
  enableManagedWorkflowProfileIfNeeded(launcherEnv);

  if (launcherEnv.COMPOSE_PROFILES?.includes('workflow-managed')) {
    throw new Error('filesystem mode unexpectedly enabled the workflow-managed compose profile');
  }

  if (launcherEnv.RIVET_WORKFLOWS_HOST_PATH !== fixture.workflowsRoot) {
    throw new Error('filesystem mode did not derive the expected workflows host path');
  }

  if (launcherEnv.RIVET_RUNTIME_LIBS_HOST_PATH !== fixture.runtimeLibrariesRoot) {
    throw new Error('filesystem mode did not derive the expected runtime-libraries host path');
  }
}

function assertLocalDockerLauncherContract(loadedEnv) {
  const launcherEnv = {
    ...loadedEnv.mergedEnv,
  };

  assertNoRetiredEnv(launcherEnv, { launcherName: 'compatibility', envFileLabel: path.basename(loadedEnv.envPath) });
  enableManagedWorkflowProfileIfNeeded(launcherEnv);

  if (!launcherEnv.COMPOSE_PROFILES?.split(',').map((value) => value.trim()).includes('workflow-managed')) {
    throw new Error('managed local-docker mode did not enable the workflow-managed compose profile');
  }

  if (String(launcherEnv.RIVET_DATABASE_MODE).trim().toLowerCase() !== 'local-docker') {
    throw new Error('managed local-docker scenario did not preserve RIVET_DATABASE_MODE=local-docker');
  }
}

async function ensureDockerAvailable() {
  await run('docker compose version', process.env, { stdio: 'ignore' });
}

async function runDockerConfigWithEnv(envPath, launcherScript) {
  const env = {
    ...process.env,
    RIVET_ENV_FILE: envPath,
  };

  return await runCapture(`node ${launcherScript} config`, env);
}

async function runRepoLocalBaseline() {
  const env = createRepoLocalTestEnv();
  await run('npm --prefix wrapper/api run build', env);
  await run('npm --prefix wrapper/api test', env);
}

async function runSplitRepoLocalChecks() {
  const env = createRepoLocalTestEnv();
  await run(
    'node ../../scripts/run-preserve-symlinks.mjs tsx --test ' +
    'src/tests/api-profile.test.ts ' +
    'src/tests/hosted-editor-seams.test.ts ' +
    'src/tests/proxy-image-contract.test.ts ' +
    'src/tests/runtime-library-cleanup.test.ts ' +
    'src/tests/workflow-storage-config.test.ts ' +
    'src/tests/docker-launcher-env.test.ts',
    env,
    { cwd: apiPackageDir },
  );
}

async function runManagedLocalDockerRepoLocalChecks() {
  const env = createRepoLocalTestEnv();
  await run(
    'node ../../scripts/run-preserve-symlinks.mjs tsx --test ' +
    'src/tests/workflow-storage-config.test.ts ' +
    'src/tests/runtime-libraries.test.ts ' +
    'src/tests/runtime-library-cleanup.test.ts ' +
    'src/tests/migrate-workflow-storage.test.ts ' +
    'src/tests/docker-launcher-env.test.ts',
    env,
    { cwd: apiPackageDir },
  );
}

function assertDockerConfigExcludesManagedWorkflowServices(label, output) {
  if (output.includes('workflow-postgres:') || output.includes('workflow-minio:')) {
    throw new Error(`${label} unexpectedly included managed local-docker services`);
  }
}

function assertDockerConfigIncludesManagedWorkflowServices(label, output) {
  if (!output.includes('workflow-postgres:') || !output.includes('workflow-minio:')) {
    throw new Error(`${label} did not include the managed local-docker services`);
  }
}

async function verifyFilesystem() {
  await runRepoLocalBaseline();

  const scenario = createScenarioEnvFile('filesystem');
  try {
    const loadedEnv = loadScenarioEnv(scenario.envPath);
    assertFilesystemLauncherContract(loadedEnv, scenario.filesystemFixture);
  } finally {
    scenario.cleanup();
  }
}

async function verifyFilesystemDocker() {
  const scenario = createScenarioEnvFile('filesystem');
  try {
    const loadedEnv = loadScenarioEnv(scenario.envPath);
    assertFilesystemLauncherContract(loadedEnv, scenario.filesystemFixture);
    await ensureDockerAvailable();
    const devConfig = await runDockerConfigWithEnv(scenario.envPath, 'scripts/dev-docker.mjs');
    const prodConfig = await runDockerConfigWithEnv(scenario.envPath, 'scripts/prod-docker.mjs');
    assertDockerConfigExcludesManagedWorkflowServices('dev-docker config', devConfig.stdout);
    assertDockerConfigExcludesManagedWorkflowServices('prod-docker config', prodConfig.stdout);
  } finally {
    scenario.cleanup();
  }
}

async function verifyLocalDocker() {
  await runManagedLocalDockerRepoLocalChecks();

  const scenario = createScenarioEnvFile('local-docker');
  try {
    const loadedEnv = loadScenarioEnv(scenario.envPath);
    assertLocalDockerLauncherContract(loadedEnv);
    await ensureDockerAvailable();
    const devConfig = await runDockerConfigWithEnv(scenario.envPath, 'scripts/dev-docker.mjs');
    const prodConfig = await runDockerConfigWithEnv(scenario.envPath, 'scripts/prod-docker.mjs');
    assertDockerConfigIncludesManagedWorkflowServices('dev-docker config', devConfig.stdout);
    assertDockerConfigIncludesManagedWorkflowServices('prod-docker config', prodConfig.stdout);
  } finally {
    scenario.cleanup();
  }
}

async function verifyLocalDockerSplit() {
  await runSplitRepoLocalChecks();

  const scenario = createScenarioEnvFile('local-docker');
  try {
    const loadedEnv = loadScenarioEnv(scenario.envPath);
    assertLocalDockerLauncherContract(loadedEnv);
    await ensureDockerAvailable();
    const devConfig = await runDockerConfigWithEnv(scenario.envPath, 'scripts/dev-docker.mjs');
    assertDockerConfigIncludesManagedWorkflowServices('dev-docker config', devConfig.stdout);
  } finally {
    scenario.cleanup();
  }
}

const action = process.argv[2];
const actions = {
  filesystem: verifyFilesystem,
  'filesystem:docker': verifyFilesystemDocker,
  'local-docker': verifyLocalDocker,
  'local-docker:split': verifyLocalDockerSplit,
};

if (!action || !(action in actions)) {
  console.error('Usage: node scripts/verify-compatibility.mjs [filesystem|filesystem:docker|local-docker|local-docker:split]');
  process.exit(1);
}

actions[action]().catch((error) => {
  console.error(`[verify-compatibility] ${error.message}`);
  process.exit(1);
});
