import 'dotenv/config';
import { ServerResourceLifecycle, ServerStartupCancelledError } from './server-resource-lifecycle.js';
import { initializeScheduledRuns, stopScheduledRuns } from './scheduled-runs/runtime.js';
import { settleBeforeDeadline } from './shutdown-deadline.js';
import { projectBundleJobs } from './routes/workflows/project-bundle-jobs.js';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { reconcileRuntimeLibraries } from './runtime-libraries/startup.js';
import {
  beginRuntimeLibrariesDrain,
  checkRuntimeLibrariesHealth,
  disposeRuntimeLibrariesBackend,
} from './runtime-libraries/backend.js';
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
import { disposeWorkflowRecordingInputExtractor } from './routes/workflows/recording-input-extractor.js';
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
import {
  getDeploymentStorageBootstrapDrift,
  readDeploymentStorageRuntimeSettingsSync,
} from './deployment-storage-settings.js';
import { nodeExecutorProxySettingsRepository } from './node-executor-proxy-settings.js';
import { isVmMigrationMaintenanceActive } from './vm-migration-maintenance.js';
import { isReleaseMaintenanceActive } from './release-maintenance.js';
import { initializeLocalMetadataServing, assertLocalMetadataWritesAllowed } from './local-metadata/runtime-control.js';
import { getLocalMetadataServingSelection } from './local-metadata/serving-selection.js';
import { initializeLocalRuntimeLibraryAuthority } from './local-metadata/runtime-library-authority.js';
import { enableWorkflowRecordingMigrationCopyMode } from './routes/workflows/recordings.js';
import { getManagedWorkflowStorageConfig, isManagedWorkflowStorageEnabled } from './routes/workflows/storage-config.js';
import { getManagedDbPoolConfig } from './routes/workflows/managed/db.js';
import { assertVmMigrationTargetMayServe } from './vm-migration-target-gate.js';
import {
  getPostgresAppSettingsPoolConfigFromEnv,
  isPostgresAppSettingsBackendEnabled,
} from './app-settings/managed-settings-store.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const apiRuntimeProfile = getApiRuntimeProfile();
const metrics = configureStudioMetrics(apiRuntimeProfile);
let webAppActionWebSockets: WebAppActionWebSocketRuntime | null = null;
let disposeLocalRuntimeLibraryAuthority: (() => void) | undefined;
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
// This is the time allowed to receive the complete HTTP request, including a
// JSON body. It does not limit graph execution after the body has arrived.
// Keep it below the normal proxy request timeout so a slow client cannot keep
// an admitted parser reservation indefinitely.
server.requestTimeout = 120_000;

if (isControlPlaneApiProfile(apiRuntimeProfile) && !isReleaseMaintenanceActive()) {
  initializeLatestWorkflowRemoteDebugger(server);
}
if (isReleaseMaintenanceActive()) server.on('upgrade', (_request, socket) => socket.destroy());

let shuttingDown = false;
let startupPromise: Promise<void> | null = null;
function assertStartupActive(): void {
  resources.assertStartupActive();
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
  await settleBeforeDeadline(closedPromise, deadline);
  return closed;
}

const resources = new ServerResourceLifecycle([
  { name: 'scheduled-runs', dispose: () => stopScheduledRuns(0).then(() => undefined) },
  { name: 'recording-input-extractor', dispose: disposeWorkflowRecordingInputExtractor },
  {
    name: 'web-app-actions',
    beginDrain: () => webAppActionWebSockets?.drain(),
    async dispose(interrupt) {
      await webAppActionWebSockets?.dispose({ interrupt });
      webAppActionWebSockets = null;
    },
  },
  { name: 'latest-debugger', dispose: disposeLatestWorkflowRemoteDebugger },
  { name: 'bundle-exports', dispose: () => projectBundleJobs.dispose() },
  { name: 'workflow-storage', dispose: disposeWorkflowStorage },
  { name: 'runtime-libraries', beginDrain: beginRuntimeLibrariesDrain, dispose: disposeRuntimeLibrariesBackend },
  {
    name: 'local-runtime-library-authority',
    dispose() {
      disposeLocalRuntimeLibraryAuthority?.();
      disposeLocalRuntimeLibraryAuthority = undefined;
    },
  },
  { name: 'app-settings', dispose: disposeAppSettingsRepositories },
]);

async function disposeResources(interrupt: boolean): Promise<void> {
  try {
    await resources.dispose(interrupt);
  } catch (error) {
    console.error('[rivet-api] Resource disposal incomplete; ownership retained:', error);
    process.exitCode = 1;
  }
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
  try {
    resources.beginDrain();
  } catch (error) {
    console.error('[rivet-api] Resource admission fencing failed; cleanup will retry the fence.', error);
    process.exitCode = 1;
  }
  const shutdownGraceMs = readShutdownGraceMs();
  const deadline = Date.now() + shutdownGraceMs;
  const scheduledDrain = stopScheduledRuns(shutdownGraceMs);
  console.log(`[rivet-api] Received ${signal}; draining for up to ${shutdownGraceMs}ms...`);

  if (startupPromise && !server.listening) {
    await settleBeforeDeadline(
      startupPromise.catch(() => undefined),
      deadline,
    );
  }

  const [httpClosed, webAppRunsCompleted, httpRunsCompleted] = await Promise.all([
    closeHttpServer(deadline),
    waitForActiveWebAppRuns(deadline),
    waitForActiveHttpExecutions(deadline),
    scheduledDrain,
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
  process.exitCode ??= 0;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function startServer(): Promise<void> {
  try {
    await resources.initialize(async () => {
      await initializeLocalMetadataServing();
      // A paused migration survives a process restart. Disable source recording
      // retention before storage initialization can run its startup cleanup.
      const vmMigrationPaused = isVmMigrationMaintenanceActive();
      if (vmMigrationPaused) enableWorkflowRecordingMigrationCopyMode();
      if (isPublishedExecutionApiProfile(apiRuntimeProfile)) {
        getPublishedExecutionAdmission();
      }
      // PostgreSQL settings initialization seeds missing rows. An incomplete
      // migration target must fail before that first potential target write.
      if (isPostgresAppSettingsBackendEnabled()) {
        const bootstrapPool = new Pool(getPostgresAppSettingsPoolConfigFromEnv());
        try {
          await assertVmMigrationTargetMayServe(bootstrapPool);
        } finally {
          await bootstrapPool.end();
        }
      }
      await initializeAppSettingsRepositories();
      assertStartupActive();
      if (isManagedWorkflowStorageEnabled()) {
        const gatePool = new Pool(getManagedDbPoolConfig(getManagedWorkflowStorageConfig()));
        try {
          await assertVmMigrationTargetMayServe(gatePool);
        } finally {
          await gatePool.end();
        }
      }
      assertApiRuntimeProfileStartupPreconditions(apiRuntimeProfile);
      let startManagedRuntimeLibraries: (() => Promise<void>) | undefined;
      if (getLocalMetadataServingSelection()) {
        if (readDeploymentStorageRuntimeSettingsSync().storageMode !== 'filesystem')
          throw new Error('Local SQLite generation must keep local artifact storage selected.');
        const apply = (
          globalThis as typeof globalThis & {
            __rivetApplyNodeExecutorProxySettings?: (settings: unknown) => Promise<void>;
          }
        ).__rivetApplyNodeExecutorProxySettings;
        if (!apply) throw new Error('Local SQL runtime bootstrap is not installed.');
        await apply(nodeExecutorProxySettingsRepository.readSync().value);
        disposeLocalRuntimeLibraryAuthority = await initializeLocalRuntimeLibraryAuthority(
          getLocalMetadataServingSelection()!,
          assertLocalMetadataWritesAllowed,
        );
      }
      if (process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') {
        const storageSettings = readDeploymentStorageRuntimeSettingsSync();
        const mismatchedFields =
          process.env.RIVET_DEPLOYMENT_STORAGE_BUCKET || process.env.RIVET_DEPLOYMENT_STORAGE_URL
            ? getDeploymentStorageBootstrapDrift(storageSettings)
            : [];
        if (mismatchedFields.length > 0) {
          console.warn(
            `[deployment-storage] Helm bootstrap differs from the authoritative PostgreSQL settings row (${mismatchedFields.join(', ')}). The row remains authoritative; reconcile configuration before rollout.`,
          );
        }
        const bootstrap = globalThis as typeof globalThis & {
          __rivetApplyNodeExecutorProxySettings?: (settings: unknown) => Promise<void>;
          __rivetStartManagedRuntimeLibraries?: (settings: unknown) => Promise<void>;
        };
        const start = bootstrap.__rivetStartManagedRuntimeLibraries;
        if (!bootstrap.__rivetApplyNodeExecutorProxySettings || !start) {
          throw new Error('Managed runtime configuration bootstrap is not installed.');
        }
        await bootstrap.__rivetApplyNodeExecutorProxySettings(nodeExecutorProxySettingsRepository.readSync().value);
        startManagedRuntimeLibraries = () => start(storageSettings);
      }
      // On first install the workflow store creates the shared S3 bucket. The
      // bootstrap runtime-library sync only checks for that bucket, so it must
      // not start first on a fresh managed deployment.
      await initializeWorkflowStorage();
      assertStartupActive();
      await startManagedRuntimeLibraries?.();
      // Reconciliation can rewrite the source manifest or migrate a legacy
      // release layout. Keep the frozen runtime-library tree untouched too.
      if (!vmMigrationPaused) await reconcileRuntimeLibraries();
      assertStartupActive();
      if (apiRuntimeProfile !== 'evaluation') {
        webAppActionWebSockets = await initializeWebAppActionWebSockets(server);
      }
      assertStartupActive();
      await runtimeHealth.start();
      assertStartupActive();
      await listenHttpServer();
      assertStartupActive();
      // Existing schedules may be due immediately. Do not start their execution
      // until runtime-library reconciliation and the rest of startup have finished.
      if (isControlPlaneApiProfile(apiRuntimeProfile) && !isReleaseMaintenanceActive()) await initializeScheduledRuns();
      assertStartupActive();
    });
  } catch (error) {
    if (error instanceof ServerStartupCancelledError) {
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
