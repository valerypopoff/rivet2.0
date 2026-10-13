import 'dotenv/config';
import { ServerResourceLifecycle, ServerStartupCancelledError } from './server-resource-lifecycle.js';
import { initializeScheduledRuns, stopScheduledRuns } from './scheduled-runs/runtime.js';
import { settleBeforeDeadline } from './shutdown-deadline.js';
import { projectBundleJobs } from './routes/workflows/project-bundle-jobs.js';
import { createServer } from 'node:http';
import { retainOrdinaryReceiveDeadline, RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS } from './legacy-restore/receive-deadline.js';
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
import { LegacyRestoreControl, acquireRestoreServingLease, restoreBlocksServing } from './legacy-restore/control.js';
import {
  LegacyRestoreService,
  setLegacyRestoreService,
  setLegacyRestorePaused,
  setLegacyRestoreWarmup,
  isLegacyRestorePaused,
  getLegacyRestoreActiveRequests,
  setLegacyRestoreWorkspaceEpoch,
} from './legacy-restore/service.js';
import { captureRestoreSettings, installRestoreSettings } from './app-settings/settings-repository.js';
import {
  getPostgresAppSettingsPoolConfigFromEnv,
  isPostgresAppSettingsBackendEnabled,
} from './app-settings/managed-settings-store.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const apiRuntimeProfile = getApiRuntimeProfile();
const metrics = configureStudioMetrics(apiRuntimeProfile);
let webAppActionWebSockets: WebAppActionWebSocketRuntime | null = null;
let disposeLocalRuntimeLibraryAuthority: (() => void) | undefined;
let releaseRestoreLease: (() => Promise<void>) | undefined;
let restoreLeasePool: Pool | undefined;
let legacyRestoreControl: LegacyRestoreControl | undefined;
let legacyRestoreService: LegacyRestoreService | undefined;
let restorePoll: NodeJS.Timeout | undefined;
let restoreControlOnly = false;
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
server.requestTimeout = process.env.RIVET_LEGACY_RESTORE_ENABLED === '1' ? RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS : 120_000;
if (process.env.RIVET_LEGACY_RESTORE_ENABLED === '1') server.on('request', retainOrdinaryReceiveDeadline);

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
  {
    name: 'restore-serving-lease',
    async dispose() {
      await (
        globalThis as typeof globalThis & { __rivetDisposeManagedRuntimeLibraries?: () => Promise<void> }
      ).__rivetDisposeManagedRuntimeLibraries?.();
      await releaseRestoreLease?.();
      releaseRestoreLease = undefined;
      await restoreLeasePool?.end();
      restoreLeasePool = undefined;
    },
  },
]);

async function requestRestoreRestart(): Promise<void> {
  const token = process.env.RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN;
  if (!token) throw new Error('The managed restore restart capability is unavailable.');
  const response = await fetch(`http://127.0.0.1:${process.env.RIVET_BACKEND_HEALTH_PORT}/legacy-restore/restart`, {
    method: 'POST',
    headers: { 'x-rivet-supervisor-token': token },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (response.status !== 202) throw new Error('Supervisor refused restore restart.');
}

async function initializeRestoreRole(): Promise<boolean> {
  if (process.env.RIVET_LEGACY_RESTORE_ENABLED !== '1' || process.env.RIVET_DEPLOYMENT_TOPOLOGY !== 'replicated')
    return false;
  const poolConfig = getPostgresAppSettingsPoolConfigFromEnv();
  const secret = process.env.RIVET_APP_SETTINGS_ENCRYPTION_KEY || process.env.RIVET_KEY;
  if (!secret) throw new Error('Restore settings encryption key is unavailable.');
  legacyRestoreControl = new LegacyRestoreControl(
    poolConfig,
    secret,
    isControlPlaneApiProfile(apiRuntimeProfile) ? 2 : 1,
  );
  const deployment = process.env.RIVET_LEGACY_RESTORE_INSTALLATION;
  if (!deployment) throw new Error('Managed restore deployment identity is missing.');
  if (isControlPlaneApiProfile(apiRuntimeProfile)) await legacyRestoreControl.initialize(deployment);
  const present = (
    await legacyRestoreControl.pool.query("SELECT to_regclass('rivet_restore_control.operation') AS name")
  ).rows[0]?.name;
  const operation = present ? await legacyRestoreControl.read() : null;
  setLegacyRestoreWorkspaceEpoch(present ? await legacyRestoreControl.readEpoch() : 'initial');
  if (present) await legacyRestoreControl.assertDeployment(deployment);
  const blocked = restoreBlocksServing(operation);
  setLegacyRestoreWarmup(operation?.phase === 'restarting');
  setLegacyRestorePaused(blocked);
  if (blocked && operation && isControlPlaneApiProfile(apiRuntimeProfile)) {
    const payload = await legacyRestoreControl.payload(operation.id);
    if (operation.phase !== 'restarting')
      installRestoreSettings(payload.preserved as ReturnType<typeof captureRestoreSettings>, operation.id);
    restoreControlOnly = operation.phase !== 'restarting';
  } else if (blocked && operation?.phase !== 'restarting') {
    // Keep a fenced, probe-responsive standby instead of crash-looping for long restores.
    // It owns no stores or writer lease and restarts into the restored generation when warmup begins.
    restoreControlOnly = true;
  }
  if (!restoreControlOnly) {
    restoreLeasePool = new Pool({ ...poolConfig, max: 1 });
    releaseRestoreLease = await acquireRestoreServingLease(restoreLeasePool);
  }
  let pollBusy = false;
  restorePoll = setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    void legacyRestoreControl!
      .read()
      .then(async (operation) => {
        setLegacyRestoreWorkspaceEpoch(await legacyRestoreControl!.readEpoch());
        legacyRestoreService?.observe(operation);
        if (restoreBlocksServing(operation) && operation?.phase !== 'restarting') {
          setLegacyRestorePaused(true);
          if (!isControlPlaneApiProfile(apiRuntimeProfile) && !restoreControlOnly)
            void shutdown('legacy restore').then(() => process.exit(0));
        } else if (
          ((operation?.phase === 'restarting' && restoreControlOnly) || !restoreBlocksServing(operation)) &&
          isLegacyRestorePaused() &&
          !isControlPlaneApiProfile(apiRuntimeProfile)
        ) {
          void shutdown('restore generation changed').then(() => process.exit(0));
        }
      })
      .catch(() => {
        setLegacyRestorePaused(true);
        void shutdown('restore gate unavailable').then(() => process.exit(1));
      })
      .finally(() => {
        pollBusy = false;
      });
  }, 1000);
  restorePoll.unref();
  return restoreControlOnly;
}

async function configureRestoreService() {
  if (!legacyRestoreControl || !isControlPlaneApiProfile(apiRuntimeProfile)) return;
  if (!process.env.RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN) return;
  // Never adopt a UI-selected foreign namespace just because its database is reachable.
  // Existing serving settings remain authoritative; restore requires explicit deployment alignment.
  if (getDeploymentStorageBootstrapDrift(readDeploymentStorageRuntimeSettingsSync()).length) return;
  const bootstrapUrl = new URL(getPostgresAppSettingsPoolConfigFromEnv().connectionString!);
  const targetUrl = new URL(getManagedWorkflowStorageConfig().databaseUrl);
  if (
    bootstrapUrl.hostname !== targetUrl.hostname ||
    (bootstrapUrl.port || '5432') !== (targetUrl.port || '5432') ||
    bootstrapUrl.pathname !== targetUrl.pathname
  )
    return;
  legacyRestoreService = new LegacyRestoreService(
    legacyRestoreControl,
    getManagedWorkflowStorageConfig(),
    process.env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore',
    {
      async drain() {
        setLegacyRestorePaused(true);
        beginActiveHttpExecutionDrain();
        getPublishedExecutionAdmission().beginDrain();
        webAppActionWebSockets?.drain();
        await stopScheduledRuns(120000);
        const deadline = Date.now() + 120000;
        while (
          getLegacyRestoreActiveRequests() ||
          getActiveHttpExecutionCount() ||
          webAppActionWebSockets?.getActiveRunCount()
        ) {
          if (Date.now() > deadline) throw new Error('Application activity did not drain.');
          await wait(250);
        }
        const preserved = captureRestoreSettings();
        runtimeHealth.stop();
        await resources.dispose(false);
        installRestoreSettings(preserved, (await legacyRestoreControl!.read())!.id);
      },
      restart: requestRestoreRestart,
    },
  );
  setLegacyRestoreService(legacyRestoreService);
  await legacyRestoreService.recover();
}

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
  if (restorePoll) clearInterval(restorePoll);
  await legacyRestoreService?.dispose();
  await legacyRestoreControl?.dispose();
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
    if (await initializeRestoreRole()) {
      await listenHttpServer();
      await configureRestoreService();
      return;
    }
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
      if (isControlPlaneApiProfile(apiRuntimeProfile) && !isReleaseMaintenanceActive() && !isLegacyRestorePaused())
        await initializeScheduledRuns();
      assertStartupActive();
    });
    await configureRestoreService();
    if (isLegacyRestorePaused() && legacyRestoreService) {
      const urls = [
        { url: `http://127.0.0.1:${process.env.RIVET_BACKEND_HEALTH_PORT}/readyz`, warmup: false },
        ...[process.env.RIVET_LEGACY_RESTORE_EXECUTION_READY_URL, process.env.RIVET_LEGACY_RESTORE_EVALUATION_READY_URL]
          .filter((url): url is string => !!url)
          .map((url) => ({ url, warmup: true })),
      ];
      const deadline = Date.now() + 300000;
      for (const { url, warmup } of urls) {
        while (true) {
          const ready = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' })
            .then(async (response) => {
              if (warmup) {
                const body = await response.json().catch(() => null);
                return response.status === 200 && body?.restoreWarmup === true;
              }
              await response.body?.cancel();
              return response.status === 200;
            })
            .catch(() => false);
          if (ready) break;
          if (Date.now() > deadline)
            throw new Error('Restored consumers did not become ready. Maintenance remains active.');
          await wait(1000);
        }
      }
      await legacyRestoreService.complete();
    }
  } catch (error) {
    if (
      legacyRestoreControl &&
      isControlPlaneApiProfile(apiRuntimeProfile) &&
      isLegacyRestorePaused() &&
      !(error instanceof ServerStartupCancelledError)
    ) {
      const operation = await legacyRestoreControl.read();
      if (operation) {
        if (operation.phase === 'completed') {
          // Verification is durable, but restart acknowledgement may have been lost.
          // Close this generation so the ordinary supervisor/container lifecycle brings up a normal one.
          runtimeHealth.stop();
          await disposeResources(true);
          if (restorePoll) clearInterval(restorePoll);
          await legacyRestoreService?.dispose();
          await legacyRestoreControl.dispose();
          server.closeAllConnections();
          server.close();
          process.exitCode = 1;
          return;
        }
        const payload = await legacyRestoreControl.payload(operation.id);
        setLegacyRestoreWarmup(false);
        runtimeHealth.stop();
        await resources.dispose(false).catch(() => undefined);
        installRestoreSettings(payload.preserved as ReturnType<typeof captureRestoreSettings>, operation.id);
        await legacyRestoreControl.write(
          {
            ...operation,
            phase: 'failed',
            message: 'Restored consumers could not become ready. Maintenance remains active; retry restore.',
          },
          { ...payload, resumePhase: operation.phase },
        );
        if (!server.listening) await listenHttpServer();
        if (!legacyRestoreService) await configureRestoreService();
        return;
      }
    }
    if (error instanceof ServerStartupCancelledError) {
      await disposeResources(true);
      return;
    }
    console.error('[rivet-api] Startup reconciliation failed:', error);
    runtimeHealth.stop();
    await disposeResources(true);
    if (restorePoll) clearInterval(restorePoll);
    await legacyRestoreService?.dispose();
    await legacyRestoreControl?.dispose();
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
