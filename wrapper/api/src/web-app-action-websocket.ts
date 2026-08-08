import { hostname } from 'node:os';
import type { IncomingMessage, Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';
import {
  createInMemoryRivetWebAppRunCoordinator,
  createInMemoryRivetWebAppRunStore,
  createRivetWebAppWebSocketGateway,
  ExecutionRecorder,
  type RivetWebAppWebSocketGateway,
} from '@valerypopoff/rivet2-node';

import { getManagedDbConnectionConfig, getManagedDbPoolConfig } from './routes/workflows/managed/db.js';
import { getManagedWorkflowStorageConfig, isManagedWorkflowStorageEnabled } from './routes/workflows/storage-config.js';
import {
  createWebAppProcessorOptions,
  createWebAppActionRecordingIdentity,
  createWebAppSocketFetchRequest,
  enqueueWebAppActionRecording,
  getWebAppBasePath,
  getWorkflowErrorMessage,
  getWorkflowRecordingStatusFromOutputs,
  resolveWebAppSocketExecution,
  type WebAppRouteKind,
} from './routes/workflows/execution.js';
import { getWorkflowExecutionRecorderOptions, isWorkflowRecordingEnabled } from './routes/workflows/recordings-config.js';
import { readRuntimeLimitSettingsSync } from './runtime-limit-settings.js';
import { PostgresRivetWebAppRunCoordinator } from './web-app-action-coordinator.js';
import { createPostgresRivetWebAppRunStore } from './web-app-action-run-store.js';
import type { WorkflowRecordingExecutionIdentity } from '../../shared/workflow-recording-types.js';

type WebAppSocketRoute = {
  routeKind: WebAppRouteKind;
  slug: string;
};

type RecorderEntry = {
  recorder: ExecutionRecorder | null;
  startedAt: number;
  executionIdentity: WorkflowRecordingExecutionIdentity;
};

export type WebAppActionWebSocketRuntime = {
  dispose(options?: { interrupt?: boolean }): Promise<void>;
  drain(): void;
  getActiveRunCount(): number;
};

let activeRuntime: WebAppActionWebSocketRuntime | null = null;

function getHostId(): string {
  return process.env.RIVET_RUNNER_SLOT_ID?.trim() || hostname();
}

function matchWebAppSocketRoute(req: IncomingMessage): WebAppSocketRoute | null {
  let pathname: string;
  try {
    pathname = new URL(req.url || '/', 'http://rivet.local').pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }

  for (const routeKind of ['published', 'latest'] as const) {
    const basePath = getWebAppBasePath(routeKind, '').replace(/\/$/, '');
    const prefix = `${basePath}/`;
    if (!pathname.startsWith(prefix)) continue;
    const parts = pathname.slice(prefix.length).split('/');
    if (parts.length !== 3 || parts[1] !== 'actions' || parts[2] !== 'ws') continue;
    try {
      const slug = decodeURIComponent(parts[0] ?? '');
      if (slug && !slug.includes('/')) return { routeKind, slug };
    } catch {
      return null;
    }
  }

  return null;
}

function isWebAppSocketUpgradePath(req: IncomingMessage): boolean {
  try {
    const pathname = new URL(req.url || '/', 'http://rivet.local').pathname.replace(/\/+$/, '');
    return (['published', 'latest'] as const).some((routeKind) => {
      const basePath = getWebAppBasePath(routeKind, '').replace(/\/$/, '');
      return pathname === basePath || pathname.startsWith(`${basePath}/`);
    });
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: import('node:stream').Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    'Connection: close\r\n' +
    'Cache-Control: no-store\r\n' +
    'Content-Length: 0\r\n\r\n',
  );
  socket.destroy();
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function initializeWebAppActionWebSockets(server: Server): Promise<WebAppActionWebSocketRuntime> {
  if (activeRuntime) return activeRuntime;

  const configuredMaxMessageBytes = readRuntimeLimitSettingsSync().webAppActionRequestLimitBytes;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: configuredMaxMessageBytes,
  });
  const recorders = new Map<string, RecorderEntry>();
  let pool: Pool | null = null;
  let coordinator: PostgresRivetWebAppRunCoordinator | null = null;

  const gateway: RivetWebAppWebSocketGateway = (() => {
    if (!isManagedWorkflowStorageEnabled()) {
      return createRivetWebAppWebSocketGateway({
        hostId: getHostId(),
        maxMessageBytes: configuredMaxMessageBytes,
        runCoordinator: createInMemoryRivetWebAppRunCoordinator(),
        runStore: createInMemoryRivetWebAppRunStore(),
        onError: (error) => console.error('[web-app-actions] WebSocket action error:', error),
      });
    }

    const config = getManagedWorkflowStorageConfig();
    pool = new Pool(getManagedDbPoolConfig(config));
    coordinator = new PostgresRivetWebAppRunCoordinator(
      pool,
      getManagedDbConnectionConfig(config),
      (error) => console.error('[web-app-actions] PostgreSQL coordinator error:', error),
    );
    return createRivetWebAppWebSocketGateway({
      hostId: getHostId(),
      maxMessageBytes: configuredMaxMessageBytes,
      runCoordinator: coordinator,
      runStore: createPostgresRivetWebAppRunStore(pool),
      onError: (error) => console.error('[web-app-actions] WebSocket action error:', error),
    });
  })();

  await coordinator?.initialize();
  await gateway.recoverInterruptedRuns();

  const handleUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    const route = matchWebAppSocketRoute(req);
    if (!route) {
      if (isWebAppSocketUpgradePath(req)) {
        rejectUpgrade(socket, 404, 'Not Found');
      }
      return;
    }

    void (async () => {
      try {
        const resolved = await resolveWebAppSocketExecution(req, route.routeKind, route.slug);
        if (!('executionProject' in resolved)) {
          rejectUpgrade(socket, resolved.statusCode, resolved.message);
          return;
        }

        webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
          const endpointName = getWebAppBasePath(route.routeKind, route.slug);
          gateway.handleConnection(webSocket, {
            ownerScope: resolved.ownerScope,
            project: resolved.executionProject.project,
            uiGraph: resolved.uiGraph,
            revisionKey: resolved.executionProject.revisionKey,
            request: createWebAppSocketFetchRequest(req),
            createProcessorOptions: async () => createWebAppProcessorOptions(
              resolved.executionProject,
              req,
              null,
              { enableRemoteDebugger: route.routeKind === 'latest' },
            ),
            onProcessorPrepared({ actionContext, processor, runId }) {
              const recorder = isWorkflowRecordingEnabled()
                ? new ExecutionRecorder(getWorkflowExecutionRecorderOptions())
                : null;
              recorder?.record(processor);
              recorders.set(runId, {
                recorder,
                startedAt: performance.now(),
                executionIdentity: createWebAppActionRecordingIdentity(
                  resolved.executionProject,
                  actionContext.uiGraph,
                  actionContext.component,
                  route.slug,
                ),
              });
            },
            onRunFinished({ result, runId }) {
              const entry = recorders.get(runId);
              recorders.delete(runId);
              if (!entry) return;
              enqueueWebAppActionRecording(
                resolved.executionProject,
                entry.recorder,
                performance.now() - entry.startedAt,
                getWorkflowRecordingStatusFromOutputs(result.outputs),
                undefined,
                {
                  endpointName,
                  runKind: route.routeKind,
                  executionIdentity: entry.executionIdentity,
                },
              );
            },
            onRunFailed({ error, outcome, runId }) {
              const entry = recorders.get(runId);
              recorders.delete(runId);
              if (!entry) return;
              const fallbackMessage = outcome === 'cancelled'
                ? 'Web app action was cancelled.'
                : outcome === 'interrupted'
                  ? 'Web app action was interrupted.'
                  : 'Web app action failed.';
              enqueueWebAppActionRecording(
                resolved.executionProject,
                entry.recorder,
                performance.now() - entry.startedAt,
                'failed',
                error == null ? fallbackMessage : getWorkflowErrorMessage(error),
                {
                  endpointName,
                  runKind: route.routeKind,
                  executionIdentity: entry.executionIdentity,
                },
              );
            },
          });
        });
      } catch (error) {
        console.error('[web-app-actions] WebSocket upgrade failed:', error);
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  };

  server.on('upgrade', handleUpgrade);
  const runtime: WebAppActionWebSocketRuntime = {
    getActiveRunCount: () => gateway.getActiveRunCount(),
    drain: () => gateway.drain(),
    async dispose(options = {}) {
      server.off('upgrade', handleUpgrade);
      await gateway.dispose({ interrupt: options.interrupt ?? true });
      for (const [runId] of recorders) recorders.delete(runId);
      await closeWebSocketServer(webSocketServer);
      await coordinator?.dispose();
      await pool?.end();
      if (activeRuntime === runtime) activeRuntime = null;
    },
  };
  activeRuntime = runtime;
  return runtime;
}

export function getWebAppActionWebSocketRuntime(): WebAppActionWebSocketRuntime | null {
  return activeRuntime;
}
