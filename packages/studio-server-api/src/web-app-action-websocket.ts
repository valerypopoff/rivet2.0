import { hostname } from 'node:os';
import type { IncomingMessage, Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { WebSocketServer } from 'ws';
import {
  createInMemoryRivetWebAppRunCoordinator,
  createInMemoryRivetWebAppRunStore,
  createRivetWebAppWebSocketGateway,
  ExecutionRecorder,
  RivetWebAppActionHttpError,
  type RivetWebAppWebSocketGateway,
} from '@valerypopoff/rivet2-node';

import { checkPostgresPoolHealth } from './managed-health.js';
import {
  getPublishedExecutionAdmission,
  toPublishedExecutionAdmissionError,
} from './published-execution-admission.js';
import {
  acquireManagedPostgresPool,
  type ManagedPostgresPoolLease,
} from './managed-postgres-pool.js';
import type { RuntimeHealthCheckContext } from './runtime-health.js';
import { getRequestCorrelationId } from './request-correlation.js';
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
import { getApiRuntimeProfile, type ApiRuntimeProfile } from './runtime-profile.js';
import { PostgresRivetWebAppRunCoordinator } from './web-app-action-coordinator.js';
import { createPostgresRivetWebAppRunStore } from './web-app-action-run-store.js';
import type { WorkflowRecordingExecutionIdentity } from '../../studio-server-shared/workflow-recording-types.js';

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
  isAccepting(): boolean;
  checkHealth(context?: RuntimeHealthCheckContext): Promise<void>;
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

export function isWebAppSocketRouteEnabled(
  routeKind: WebAppRouteKind,
  profile: ApiRuntimeProfile = getApiRuntimeProfile(),
): boolean {
  return routeKind === 'published'
    ? profile === 'combined' || profile === 'execution'
    : profile === 'combined' || profile === 'control';
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

function acquirePublishedWebAppActionPermit() {
  const result = getPublishedExecutionAdmission().acquire('web-app-action');
  if (result.kind === 'accepted') return result.permit;
  const error = toPublishedExecutionAdmissionError(result);
  throw new RivetWebAppActionHttpError(error.message, error.status, error.code);
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
  let poolLease: ManagedPostgresPoolLease | null = null;
  let coordinator: PostgresRivetWebAppRunCoordinator | null = null;
  let accepting = true;

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
    poolLease = acquireManagedPostgresPool(getManagedDbPoolConfig(config));
    pool = poolLease.pool;
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
    if (!isWebAppSocketRouteEnabled(route.routeKind)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!accepting) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
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
            ...(route.routeKind === 'published'
              ? { acquireRunPermit: acquirePublishedWebAppActionPermit }
              : {}),
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
                  getRequestCorrelationId(req),
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
    isAccepting: () => accepting,
    async checkHealth(context) {
      if (!accepting) throw new Error('Web-app action gateway is draining.');
      if (pool) await checkPostgresPoolHealth(pool, context);
    },
    drain() {
      accepting = false;
      // Upgraded sockets otherwise keep node:http's close callback pending for
      // the full shutdown grace period. The graph owner remains active and a
      // reconnecting client can resume through the durable action ledger.
      gateway.drain({ closeConnections: true });
    },
    async dispose(options = {}) {
      accepting = false;
      server.off('upgrade', handleUpgrade);
      await gateway.dispose({ interrupt: options.interrupt ?? true });
      for (const [runId] of recorders) recorders.delete(runId);
      await closeWebSocketServer(webSocketServer);
      await coordinator?.dispose();
      await poolLease?.release();
      if (activeRuntime === runtime) activeRuntime = null;
    },
  };
  activeRuntime = runtime;
  return runtime;
}

export function getWebAppActionWebSocketRuntime(): WebAppActionWebSocketRuntime | null {
  return activeRuntime;
}
