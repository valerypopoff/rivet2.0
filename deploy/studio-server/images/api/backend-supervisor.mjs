import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { acquireLocalMetadataOwnerLease, assertLegacyLocalMetadataStartup } from './local-metadata-owner-lease.mjs';
import {
  loadUiUpgradeEnvironment,
  prepareUiUpgrade,
  uiPreparationAvailable,
  rememberManualControlRoot,
  initializeNewLocalStorage,
} from './local-upgrade-ui.mjs';

const API_ENTRYPOINT = '/opt/rivet/api-entrypoint.sh';
const EXECUTOR_ENTRYPOINT = '/opt/rivet/executor-entrypoint.sh';

function port(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return parsed;
}

export function childEnvironments(env = process.env) {
  const apiPort = port(env.RIVET_BACKEND_API_PORT, 'RIVET_BACKEND_API_PORT');
  const executorPort = port(env.RIVET_BACKEND_EXECUTOR_PORT, 'RIVET_BACKEND_EXECUTOR_PORT');
  port(env.RIVET_BACKEND_HEALTH_PORT, 'RIVET_BACKEND_HEALTH_PORT');
  if (new Set([apiPort, executorPort, Number(env.RIVET_BACKEND_HEALTH_PORT)]).size !== 3) {
    throw new Error('Backend API, executor, and health ports must be distinct.');
  }
  const topology = env.RIVET_DEPLOYMENT_TOPOLOGY || 'single-host';
  if (topology === 'replicated') {
    if (env.RIVET_RUNTIME_CONFIG_PROTOCOL !== '1') {
      throw new Error('The combined replicated backend requires runtime configuration protocol 1.');
    }
    const expectedConfigUrl = `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`;
    if (env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL !== expectedConfigUrl) {
      throw new Error('The executor runtime configuration URL must target the co-located API loopback endpoint.');
    }
  } else if (topology !== 'single-host' || env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL) {
    throw new Error('The single-host backend must use local executor settings without a runtime configuration URL.');
  }

  const api = { ...env, PORT: String(apiPort), RIVET_RUNTIME_PROCESS_ROLE: 'api' };
  const executor = {
    ...env,
    PORT: String(executorPort),
    RIVET_EXECUTOR_PORT: String(executorPort),
    RIVET_EXECUTOR_HOST: '0.0.0.0',
    RIVET_RUNTIME_PROCESS_ROLE: 'executor',
    RIVET_APP_DATA_ROOT: '/home/rivet/.local/share/com.valerypopoff.rivet2',
  };
  if (topology === 'replicated') {
    executor.RIVET_RUNTIME_LIBRARIES_REPLICA_TIER = 'editor';
    delete executor.RIVET_LLM_PROFILE_HEALTH_API_URL;
    delete executor.RIVET_EXECUTION_ENVIRONMENT_API_URL;
  } else {
    api.RIVET_VM_MIGRATION_EDITOR_CONTROL = '1';
    delete executor.RIVET_RUNTIME_LIBRARIES_REPLICA_TIER;
    executor.RIVET_VM_MIGRATION_CONTROL_ROOT = env.RIVET_APP_DATA_ROOT || '/data/rivet-app';
    executor.RIVET_LLM_PROFILE_HEALTH_API_URL = `http://127.0.0.1:${apiPort}/api/workflows/llm-profile-health`;
    executor.RIVET_EXECUTION_ENVIRONMENT_API_URL = `http://127.0.0.1:${apiPort}/api/workflows/execution-environment`;
  }
  delete executor.RIVET_API_PROFILE;
  delete executor.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN;
  delete executor.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE;
  delete executor.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE;
  delete executor.RIVET_RUNNER_SLOT_ID;
  delete executor.RIVET_MANAGED_MAINTENANCE_ENABLED;
  delete executor.RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED;
  return { api, executor, apiPort, executorPort, healthPort: Number(env.RIVET_BACKEND_HEALTH_PORT) };
}

export async function startBackendSupervisor({
  env = process.env,
  apiCommand = API_ENTRYPOINT,
  executorCommand = EXECUTOR_ENTRYPOINT,
  executorCwd = '/app',
  apiEnvOverrides = {},
  executorEnvOverrides = {},
  signalSource = process,
  apiStartupTimeoutMs = Number(env.RIVET_BACKEND_API_STARTUP_TIMEOUT_MS ?? 300_000),
  shutdownTimeoutMs = Number(env.RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS ?? 130_000),
} = {}) {
  const config = childEnvironments(env);
  const uiControl = (env.RIVET_DEPLOYMENT_TOPOLOGY || 'single-host') === 'single-host';
  const controlToken = randomBytes(32).toString('hex');
  const canPrepare = uiControl && uiPreparationAvailable(env);
  if (uiControl) {
    config.api.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN = controlToken;
    config.api.RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE = canPrepare ? '1' : '0';
    config.api.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE = '1';
  }
  let localMetadataLease;
  if (env.RIVET_LOCAL_METADATA_CONTROL_ROOT) {
    if ((env.RIVET_DEPLOYMENT_TOPOLOGY || 'single-host') !== 'single-host')
      throw new Error('Local metadata ownership is supported only on a single host.');
    localMetadataLease = acquireLocalMetadataOwnerLease(env.RIVET_LOCAL_METADATA_CONTROL_ROOT);
    try {
      const selection = assertLegacyLocalMetadataStartup(
        env.RIVET_LOCAL_METADATA_CONTROL_ROOT,
        env.RIVET_APP_DATA_ROOT || '/data/rivet-app',
        { allowSqlite: true },
      );
      rememberManualControlRoot(env);
      for (const child of [config.api, config.executor]) {
        child.RIVET_LOCAL_METADATA_SUPERVISED = '1';
        child.RIVET_LOCAL_METADATA_BOOT_GENERATION = selection.generationId;
        child.RIVET_LOCAL_METADATA_BOOT_REVISION = String(selection.revision);
      }
      if (selection.generationId) {
        config.executor.RIVET_EXECUTOR_RUNTIME_CONFIG_URL = `http://127.0.0.1:${config.apiPort}/internal/executor-runtime-config`;
        config.executor.RIVET_RUNTIME_CONFIG_PROTOCOL = '2';
        config.executor.RIVET_RUNTIME_LIBRARIES_ROOT = path.join(
          env.RIVET_LOCAL_METADATA_CONTROL_ROOT,
          'generations',
          selection.generationId,
          'runtime-cache',
        );
        config.executor.RIVET_CODE_RUNNER_REQUIRE_ROOT = path.join(
          config.executor.RIVET_RUNTIME_LIBRARIES_ROOT,
          'current',
          'node_modules',
        );
      }
    } catch (error) {
      localMetadataLease.release();
      throw error;
    }
  }
  if (
    !Number.isFinite(apiStartupTimeoutMs) ||
    apiStartupTimeoutMs < 1_000 ||
    !Number.isFinite(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1_000
  ) {
    localMetadataLease?.release();
    throw new Error('Backend startup and shutdown timeouts must be positive durations.');
  }
  let api;
  let executor;
  let apiDone = false;
  let executorDone = true;
  let executorReady = false;
  let stopping = false;
  let finishing = false;
  let exitCode = 0;
  let requestedAction = null;
  let shutdownTimer;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const apiReadyUrl = `http://127.0.0.1:${config.apiPort}/readyz`;

  async function apiReady() {
    try {
      const response = await fetch(apiReadyUrl, { signal: AbortSignal.timeout(1_500) });
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async function executorListening() {
    return new Promise((resolve) => {
      const socket = connect(config.executorPort, '127.0.0.1');
      const finish = (ready) => {
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(1_000, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }

  const health = createServer(async (request, response) => {
    if (request.url === '/local-upgrade/prepare' || request.url === '/local-upgrade/restart') {
      const supplied = Buffer.from(String(request.headers['x-rivet-supervisor-token'] || ''));
      const expected = Buffer.from(controlToken);
      if (
        !uiControl ||
        request.method !== 'POST' ||
        request.headers.origin ||
        !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress) ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        response.writeHead(403).end();
        return;
      }
      if (stopping || requestedAction || (request.url.endsWith('/prepare') && !canPrepare)) {
        response.writeHead(409).end();
        return;
      }
      requestedAction = request.url.endsWith('/prepare') ? 'prepare' : 'restart';
      response.writeHead(202, { 'Cache-Control': 'no-store' }).end();
      // Let the API forward its acknowledgement before graceful shutdown.
      setTimeout(() => void stop(), 250).unref();
      return;
    }
    if (request.url !== '/livez' && request.url !== '/readyz') {
      response.writeHead(404).end();
      return;
    }
    const live = !stopping && api != null && !apiDone && (!executor || !executorDone);
    const healthy =
      request.url === '/livez'
        ? live && (!executorReady || (await executorListening()))
        : live && executorReady && (await apiReady()) && (await executorListening());
    response.writeHead(healthy ? 200 : 503, { 'Cache-Control': 'no-store' }).end();
  });
  try {
    await new Promise((resolve, reject) => {
      health.once('error', reject);
      health.listen(config.healthPort, '0.0.0.0', resolve);
    });
  } catch (error) {
    localMetadataLease?.release();
    throw error;
  }

  function finishIfStopped() {
    if (!stopping || !apiDone || !executorDone || finishing) return;
    finishing = true;
    clearTimeout(shutdownTimer);
    signalSource.off('SIGINT', onSignal);
    signalSource.off('SIGTERM', onSignal);
    health.closeAllConnections();
    health.close(() => {
      localMetadataLease?.release();
      finish(exitCode);
    });
  }

  function stop(code = 0) {
    if (stopping) {
      exitCode = Math.max(exitCode, code);
      return completed;
    }
    stopping = true;
    exitCode = code;
    executorReady = false;
    if (!apiDone) api?.kill('SIGTERM');
    if (!executorDone) executor?.kill('SIGTERM');
    shutdownTimer = setTimeout(() => {
      if (!apiDone) api?.kill('SIGKILL');
      if (!executorDone) executor?.kill('SIGKILL');
      exitCode = 1;
    }, shutdownTimeoutMs);
    shutdownTimer.unref();
    finishIfStopped();
    return completed;
  }

  function onSignal() {
    void stop();
  }
  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);

  function launch(command, childEnv, onExit, ipc = false) {
    const [executable, ...args] = Array.isArray(command) ? command : [command];
    const child = spawn(executable, args, {
      env: childEnv,
      cwd: ipc ? executorCwd : undefined,
      stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
    });
    child.once('error', (error) => {
      console.error(`[backend-supervisor] Failed to start ${ipc ? 'executor' : 'API'}:`, error);
    });
    child.once('close', (code, signal) => {
      onExit();
      if (!stopping) {
        console.error(`[backend-supervisor] ${ipc ? 'Executor' : 'API'} exited (${code ?? signal}).`);
        void stop(1);
      }
      finishIfStopped();
    });
    return child;
  }

  api = launch(apiCommand, { ...config.api, ...apiEnvOverrides }, () => {
    apiDone = true;
  });
  void (async () => {
    const deadline = Date.now() + apiStartupTimeoutMs;
    while (!stopping && !(await apiReady())) {
      if (Date.now() >= deadline) {
        console.error('[backend-supervisor] API did not become ready before the startup deadline.');
        void stop(1);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (stopping) return;
    executorDone = false;
    executor = launch(
      executorCommand,
      { ...config.executor, ...executorEnvOverrides },
      () => {
        executorDone = true;
        executorReady = false;
      },
      true,
    );
    executor.on('message', (message) => {
      if (message?.type === 'rivet-executor-ready') executorReady = true;
      if (message?.type === 'rivet-executor-unready') executorReady = false;
    });
  })().catch((error) => {
    console.error('[backend-supervisor] Startup failed:', error);
    void stop(1);
  });

  return {
    completed,
    stop,
    healthPort: config.healthPort,
    get requestedAction() {
      return requestedAction;
    },
  };
}

/** Restart both children in-process, including fresh journal selection and
 * owner lease. Never require Docker socket access or restart web/proxy. */
export async function runBackendSupervisor(options = {}) {
  const originalEnv = options.env || process.env;
  const signals = options.signalSource || process;
  const setupCancellation = new AbortController();
  const setupOptions = {
    signal: setupCancellation.signal,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? Number(originalEnv.RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS ?? 130_000),
  };
  let stopped = false;
  const onSignal = () => {
    stopped = true;
    setupCancellation.abort();
  };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  let uiVolumeLease;
  try {
    let env = loadUiUpgradeEnvironment(originalEnv);
    // Fence concurrent supported backends even before first UI opt-in. Keep
    // this reserved-volume lease across child restarts and offline setup.
    if (
      originalEnv.RIVET_DEPLOYMENT_TOPOLOGY !== 'replicated' &&
      originalEnv.RIVET_LOCAL_METADATA_UI_ROOT &&
      (!env.RIVET_LOCAL_METADATA_CONTROL_ROOT ||
        path.resolve(env.RIVET_LOCAL_METADATA_CONTROL_ROOT) !== path.resolve(originalEnv.RIVET_LOCAL_METADATA_UI_ROOT))
    )
      uiVolumeLease = acquireLocalMetadataOwnerLease(originalEnv.RIVET_LOCAL_METADATA_UI_ROOT);
    env = await initializeNewLocalStorage(
      originalEnv,
      options.localStorageInitializeCommand || [
        process.execPath,
        '/app/packages/studio-server-api/dist/studio-server-api/src/scripts/local-metadata-control.js',
        '--initialize-empty',
      ],
      setupOptions,
    );
    while (!stopped) {
      const supervisor = await startBackendSupervisor({ ...options, env });
      // A signal can arrive while the health listener is opening, before the
      // child supervisor has installed its own signal handlers.
      if (stopped) await supervisor.stop();
      const code = await supervisor.completed;
      if (stopped || code !== 0 || !supervisor.requestedAction) return code;
      if (supervisor.requestedAction === 'prepare') {
        env = await prepareUiUpgrade(
          originalEnv,
          options.localUpgradeProvisionCommand || [
            process.execPath,
            '/app/packages/studio-server-api/dist/studio-server-api/src/scripts/local-metadata-control.js',
            '--provision',
          ],
          setupOptions,
        );
      }
    }
    return 0;
  } catch (error) {
    if (error === setupCancellation.signal.reason && stopped) return 0;
    throw error;
  } finally {
    uiVolumeLease?.release();
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await runBackendSupervisor();
  } catch (error) {
    console.error('[backend-supervisor] Configuration failed:', error);
    process.exitCode = 1;
  }
}
