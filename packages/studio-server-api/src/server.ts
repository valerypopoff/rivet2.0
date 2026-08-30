import 'dotenv/config';
import { createServer } from 'node:http';
import { reconcileRuntimeLibraries } from './runtime-libraries/startup.js';
import { checkRuntimeLibrariesHealth, disposeRuntimeLibrariesBackend } from './runtime-libraries/backend.js';
import {
  disposeLatestWorkflowRemoteDebugger,
  initializeLatestWorkflowRemoteDebugger,
} from './latestWorkflowRemoteDebugger.js';
import { initializeWebAppActionWebSockets, type WebAppActionWebSocketRuntime } from './web-app-action-websocket.js';
import {
  checkWorkflowStorageHealth,
  disposeWorkflowStorage,
  initializeWorkflowStorage,
} from './routes/workflows/storage-backend.js';
import { flushWorkflowExecutionRecordingPersistence } from './routes/workflows/recordings.js';
import { getPublishedExecutionAdmission } from './published-execution-admission.js';
import {
  abortActiveHttpExecutions,
  beginActiveHttpExecutionDrain,
  getActiveHttpExecutionCount,
} from './active-http-executions.js';
import { getApiRuntimeProfile, isControlPlaneApiProfile, isPublishedExecutionApiProfile } from './runtime-profile.js';
import { assertApiRuntimeProfileStartupPreconditions, createApiApp } from './app.js';
import {
  checkAppSettingsRepositoriesHealth,
  disposeAppSettingsRepositories,
  initializeAppSettingsRepositories,
} from './app-settings/settings-repository.js';
import { getRuntimeHealthOptionsFromEnv, RuntimeHealthController, type RuntimeHealthCheck } from './runtime-health.js';
import { configureStudioMetrics } from './metrics.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const apiRuntimeProfile = getApiRuntimeProfile();
const metrics = configureStudioMetrics(apiRuntimeProfile);
let webAppActionWebSockets: WebAppActionWebSocketRuntime | null = null;
const runtimeHealthChecks: RuntimeHealthCheck[] = [
  {
    name: 'app-settings',
    failureCode: 'app_settings_unavailable',
    check: checkAppSettingsRepositoriesHealth,
  },
  {
    name: 'workflow-storage',
    failureCode: 'workflow_storage_unavailable',
    check: checkWorkflowStorageHealth,
  },
  {
    name: 'runtime-libraries',
    failureCode: 'runtime_libraries_unavailable',
    check: checkRuntimeLibrariesHealth,
  },
];

// The internal Evaluation profile exposes no web-app routes, so it must not
// allocate a WebSocket gateway or an extra managed PostgreSQL listener.
if (apiRuntimeProfile !== 'evaluation') {
  runtimeHealthChecks.push({
    name: 'web-app-actions',
    failureCode: 'web_app_gateway_unavailable',
    async check(context) {
      if (!webAppActionWebSockets) {
        throw new Error('Web-app action gateway is not initialized.');
      }
      await webAppActionWebSockets.checkHealth(context);
    },
  });
}

const runtimeHealth = new RuntimeHealthController(
  apiRuntimeProfile,
  runtimeHealthChecks,
  getRuntimeHealthOptionsFromEnv(),
);
const app = createApiApp(apiRuntimeProfile, { health: runtimeHealth, metrics });
const server = createServer(app);

if (isControlPlaneApiProfile(apiRuntimeProfile)) {
  initializeLatestWorkflowRemoteDebugger(server);
}

let shuttingDown = false;
let startupPromise: Promise<void> | null = null;
let resourceDisposalQueue = Promise.resolve();

class StartupCancelledError extends Error {}

function assertStartupActive(): void {
  if (shuttingDown) throw new StartupCancelledError();
}

function readShutdownGraceMs(): number {
  const seconds = Number(process.env.RIVET_SHUTDOWN_GRACE_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 1) return 120_000;
  return Math.min(Math.floor(seconds * 1_000), 3_600_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForActiveRuns(getActiveRunCount: () => number, deadline: number): Promise<boolean> {
  while (getActiveRunCount() > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await wait(Math.min(250, remainingMs));
  }
  return true;
}

async function waitForActiveWebAppRuns(deadline: number): Promise<boolean> {
  return waitForActiveRuns(() => webAppActionWebSockets?.getActiveRunCount() ?? 0, deadline);
}

async function waitForActiveHttpExecutions(deadline: number): Promise<boolean> {
  return waitForActiveRuns(getActiveHttpExecutionCount, deadline);
}

async function closeHttpServer(deadline: number): Promise<boolean> {
  if (!server.listening) return true;

  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    server.close(() => {
      closed = true;
      resolve();
    });
    server.closeIdleConnections?.();
  });
  const remainingMs = Math.max(0, deadline - Date.now());
  await Promise.race([closedPromise, wait(remainingMs)]);
  return closed;
}

function disposeResources(interruptWebAppRuns: boolean): Promise<void> {
  const disposal = resourceDisposalQueue.then(() => disposeResourcesOnce(interruptWebAppRuns));
  resourceDisposalQueue = disposal;
  return disposal;
}

async function disposeResourcesOnce(interruptWebAppRuns: boolean): Promise<void> {
  if (webAppActionWebSockets) {
    await webAppActionWebSockets.dispose({ interrupt: interruptWebAppRuns }).catch((error) => {
      console.error('[web-app-actions] Failed to dispose WebSocket actions during shutdown:', error);
    });
  }
  webAppActionWebSockets = null;

  await disposeLatestWorkflowRemoteDebugger().catch((error) => {
    console.error('[latest-debugger] Failed to dispose during shutdown:', error);
  });

  await flushWorkflowExecutionRecordingPersistence().catch((error) => {
    console.error('[workflow-recordings] Failed to flush recording persistence during shutdown:', error);
  });
  await disposeWorkflowStorage().catch((error) => {
    console.error('[managed-workflows] Failed to dispose storage backend during shutdown:', error);
  });
  await disposeRuntimeLibrariesBackend().catch((error) => {
    console.error('[runtime-libraries] Failed to dispose backend during shutdown:', error);
  });
  await disposeAppSettingsRepositories().catch((error) => {
    console.error('[app-settings] Failed to dispose settings backend during shutdown:', error);
  });
}

async function listenHttpServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT);
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;

  shuttingDown = true;
  runtimeHealth.beginDrain();
  beginActiveHttpExecutionDrain();
  if (isPublishedExecutionApiProfile(apiRuntimeProfile)) {
    getPublishedExecutionAdmission().beginDrain();
  }
  webAppActionWebSockets?.drain();
  const shutdownGraceMs = readShutdownGraceMs();
  const deadline = Date.now() + shutdownGraceMs;
  console.log(`[rivet-api] Received ${signal}; draining for up to ${shutdownGraceMs}ms...`);

  if (startupPromise && !server.listening) {
    await Promise.race([startupPromise.catch(() => undefined), wait(Math.max(0, deadline - Date.now()))]);
  }

  const [httpClosed, webAppRunsCompleted, httpRunsCompleted] = await Promise.all([
    closeHttpServer(deadline),
    waitForActiveWebAppRuns(deadline),
    waitForActiveHttpExecutions(deadline),
  ]);

  if (!webAppRunsCompleted) {
    const interruptedWebAppRuns = webAppActionWebSockets?.getActiveRunCount() ?? 0;
    console.warn(
      `[web-app-actions] ${interruptedWebAppRuns} active run(s) exceeded the shutdown grace period and will be interrupted.`,
    );
    metrics.recordPublishedExecutionInterruptions('web_app_action', interruptedWebAppRuns);
  }
  if (!httpRunsCompleted) {
    const activeHttpRuns = getActiveHttpExecutionCount();
    const aborted = abortActiveHttpExecutions();
    metrics.recordPublishedExecutionInterruptions('workflow_endpoint', aborted);
    console.warn(
      `[workflow-executions] ${activeHttpRuns} active HTTP graph run(s) exceeded the shutdown grace period; aborting ${aborted}.`,
    );
    const finalized = await waitForActiveHttpExecutions(Date.now() + 5_000);
    if (!finalized) {
      console.warn(
        `[workflow-executions] ${getActiveHttpExecutionCount()} HTTP graph run(s) did not settle after shutdown abort.`,
      );
    }
  }

  if (!httpClosed) {
    console.warn('[rivet-api] HTTP connections exceeded the shutdown grace period; forcing them closed.');
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  }

  await disposeResources(!webAppRunsCompleted);
  runtimeHealth.stop();
  process.exitCode = 0;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function startServer(): Promise<void> {
  try {
    if (isPublishedExecutionApiProfile(apiRuntimeProfile)) {
      getPublishedExecutionAdmission();
    }
    await initializeAppSettingsRepositories();
    assertStartupActive();
    assertApiRuntimeProfileStartupPreconditions(apiRuntimeProfile);
    await reconcileRuntimeLibraries();
    assertStartupActive();
    await initializeWorkflowStorage();
    assertStartupActive();
    if (apiRuntimeProfile !== 'evaluation') {
      webAppActionWebSockets = await initializeWebAppActionWebSockets(server);
    }
    assertStartupActive();
    await runtimeHealth.start();
    assertStartupActive();
    await listenHttpServer();
    assertStartupActive();
  } catch (error) {
    if (error instanceof StartupCancelledError) {
      await disposeResources(true);
      return;
    }
    console.error('[rivet-api] Startup reconciliation failed:', error);
    runtimeHealth.stop();
    await disposeResources(true);
    process.exitCode = 1;
    return;
  }

  console.log(`[rivet-api] Listening on port ${PORT}`);
  console.log(`[rivet-api] Runtime profile: ${apiRuntimeProfile}`);
  console.log(`[rivet-api] Workspace root: ${process.env.RIVET_WORKSPACE_ROOT ?? '/workspace'}`);
  console.log(`[rivet-api] App data root: ${process.env.RIVET_APP_DATA_ROOT ?? '/data/rivet-app'}`);
  console.log(`[rivet-api] Runtime libraries root: ${process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '(not set)'}`);
}

startupPromise = startServer();
