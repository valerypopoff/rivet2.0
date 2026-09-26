import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

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
    delete executor.RIVET_RUNTIME_LIBRARIES_REPLICA_TIER;
    executor.RIVET_LLM_PROFILE_HEALTH_API_URL = `http://127.0.0.1:${apiPort}/api/workflows/llm-profile-health`;
    executor.RIVET_EXECUTION_ENVIRONMENT_API_URL = `http://127.0.0.1:${apiPort}/api/workflows/execution-environment`;
  }
  delete executor.RIVET_API_PROFILE;
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
  signalSource = process,
  apiStartupTimeoutMs = Number(env.RIVET_BACKEND_API_STARTUP_TIMEOUT_MS ?? 300_000),
  shutdownTimeoutMs = Number(env.RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS ?? 130_000),
} = {}) {
  const config = childEnvironments(env);
  if (
    !Number.isFinite(apiStartupTimeoutMs) ||
    apiStartupTimeoutMs < 1_000 ||
    !Number.isFinite(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1_000
  ) {
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
  await new Promise((resolve, reject) => {
    health.once('error', reject);
    health.listen(config.healthPort, '0.0.0.0', resolve);
  });

  function finishIfStopped() {
    if (!stopping || !apiDone || !executorDone || finishing) return;
    finishing = true;
    clearTimeout(shutdownTimer);
    signalSource.off('SIGINT', onSignal);
    signalSource.off('SIGTERM', onSignal);
    health.closeAllConnections();
    health.close(() => finish(exitCode));
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

  api = launch(apiCommand, config.api, () => {
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
      config.executor,
      () => {
        executorDone = true;
        executorReady = false;
      },
      true,
    );
    executor.on('message', (message) => {
      if (message?.type === 'rivet-executor-ready') executorReady = true;
    });
  })().catch((error) => {
    console.error('[backend-supervisor] Startup failed:', error);
    void stop(1);
  });

  return { completed, stop, healthPort: config.healthPort };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const supervisor = await startBackendSupervisor();
    process.exitCode = await supervisor.completed;
  } catch (error) {
    console.error('[backend-supervisor] Configuration failed:', error);
    process.exitCode = 1;
  }
}
