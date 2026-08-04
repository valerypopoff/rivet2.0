import 'dotenv/config';
import { createServer } from 'node:http';
import { reconcileRuntimeLibraries } from './runtime-libraries/startup.js';
import { disposeRuntimeLibrariesBackend } from './runtime-libraries/backend.js';
import { initializeLatestWorkflowRemoteDebugger } from './latestWorkflowRemoteDebugger.js';
import { initializeWebAppActionWebSockets, type WebAppActionWebSocketRuntime } from './web-app-action-websocket.js';
import { disposeWorkflowStorage, initializeWorkflowStorage } from './routes/workflows/storage-backend.js';
import { flushWorkflowExecutionRecordingPersistence } from './routes/workflows/recordings.js';
import { getApiRuntimeProfile, isControlPlaneApiProfile } from './runtime-profile.js';
import { assertApiRuntimeProfileStartupPreconditions, createApiApp } from './app.js';
import { initializeAppSettingsRepositories } from './app-settings/settings-repository.js';

const app = createApiApp();
const server = createServer(app);
const PORT = parseInt(process.env.PORT ?? '3100', 10);
const apiRuntimeProfile = getApiRuntimeProfile();

if (isControlPlaneApiProfile(apiRuntimeProfile)) {
  initializeLatestWorkflowRemoteDebugger(server);
}

let shuttingDown = false;
const SHUTDOWN_GRACE_MS = 5_000;
let webAppActionWebSockets: WebAppActionWebSocketRuntime | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[rivet-api] Received ${signal}, shutting down...`);
  webAppActionWebSockets?.drain();

  try {
    let resolved = false;
    await Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => {
          resolved = true;
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!resolved) {
            console.warn(`[rivet-api] HTTP server did not close within ${SHUTDOWN_GRACE_MS}ms; forcing connection shutdown.`);
            server.closeAllConnections?.();
            server.closeIdleConnections?.();
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.error('[rivet-api] Failed to close HTTP server:', error);
  }

  if (webAppActionWebSockets) {
    await webAppActionWebSockets.dispose({ interrupt: true }).catch((error) => {
      console.error('[web-app-actions] Failed to dispose WebSocket actions during shutdown:', error);
    });
  }
  webAppActionWebSockets = null;

  await flushWorkflowExecutionRecordingPersistence().catch((error) => {
    console.error('[workflow-recordings] Failed to flush recording persistence during shutdown:', error);
  });

  await disposeWorkflowStorage().catch((error) => {
    console.error('[managed-workflows] Failed to dispose storage backend during shutdown:', error);
  });

  await disposeRuntimeLibrariesBackend().catch((error) => {
    console.error('[runtime-libraries] Failed to dispose backend during shutdown:', error);
  });

  process.exitCode = 0;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function startServer() {
  try {
    await initializeAppSettingsRepositories();
    assertApiRuntimeProfileStartupPreconditions(apiRuntimeProfile);
    await reconcileRuntimeLibraries();
    await initializeWorkflowStorage();
    webAppActionWebSockets = await initializeWebAppActionWebSockets(server);
  } catch (error) {
    console.error('[rivet-api] Startup reconciliation failed:', error);
    process.exitCode = 1;
    return;
  }

  server.listen(PORT, () => {
    console.log(`[rivet-api] Listening on port ${PORT}`);
    console.log(`[rivet-api] Runtime profile: ${apiRuntimeProfile}`);
    console.log(`[rivet-api] Workspace root: ${process.env.RIVET_WORKSPACE_ROOT ?? '/workspace'}`);
    console.log(`[rivet-api] App data root: ${process.env.RIVET_APP_DATA_ROOT ?? '/data/rivet-app'}`);
    console.log(`[rivet-api] Runtime libraries root: ${process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '(not set)'}`);
  });
}

void startServer();
