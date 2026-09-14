import { hostname } from 'node:os';
import { watchAuthorization } from './watch-authorization.js';
import { runOutsideAppSettingsSnapshot } from './app-settings/settings-repository.js';
import type { IncomingMessage, Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createInMemoryRivetWebAppRunCoordinator,
  createInMemoryRivetWebAppRunStore,
  createRivetWebAppWebSocketGateway,
  ExecutionRecorder,
  RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES,
  RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES,
  RivetWebAppActionHttpError,
  type RivetWebAppBrowserStorageRpcEvent,
  type RivetWebAppWebSocketGateway,
} from '@valerypopoff/rivet2-node';

import { checkPostgresPoolHealth } from './managed-health.js';
import { getPublishedExecutionAdmission, toPublishedExecutionAdmissionError } from './published-execution-admission.js';
import { recordStudioMetrics } from './metrics.js';
import { acquireManagedPostgresPool, type ManagedPostgresPoolLease } from './managed-postgres-pool.js';
import type { RuntimeHealthCheckContext } from './runtime-health.js';
import { createRivetCorrelationId } from './request-correlation.js';
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
  type WebAppSocketAuthorizationStatus,
  type WebAppSocketExecutionResolution,
  type WebAppRouteKind,
} from './routes/workflows/execution.js';
import { subscribeWebAppSocketPolicyInvalidation } from './routes/workflows/web-app-policy-invalidation.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
} from './routes/workflows/recordings-config.js';
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
const WEB_APP_SOCKET_ACCESS_RECHECK_MS = 5_000;
export const WEB_APP_SOCKET_POLICY_LOOKUP_MAX_ACTIVE = 16;
export const WEB_APP_SOCKET_POLICY_LOOKUP_TIMEOUT_MS = 5_000;
const WEB_APP_SOCKET_AUTHORIZATION_CLOSE_GRACE_MS = 1_000;

type ResolvedWebAppSocketExecution = Extract<WebAppSocketExecutionResolution, { executionProject: unknown }>;

type WebAppSocketPolicyLookupCoordinator = {
  read<T>(key: string, reader: () => Promise<T>, options?: { fresh?: boolean }): Promise<T>;
  dispose(): void;
};

type SharedPolicyLookup<T> = {
  response: Promise<T>;
};

type WebAppSocketPolicyRecheckScheduler = {
  subscribe(recheck: () => void): () => void;
};

/**
 * A process owns one timer for idle socket rechecks. Individual sockets still
 * make their own authorization decisions, while the lookup coordinator below
 * coalesces the policy-store work for a shared app binding.
 */
export function createWebAppSocketPolicyRecheckScheduler(
  intervalMs = WEB_APP_SOCKET_ACCESS_RECHECK_MS,
): WebAppSocketPolicyRecheckScheduler {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('Web app socket policy recheck intervalMs must be a positive integer.');
  }

  const subscribers = new Set<() => void>();
  let timer: NodeJS.Timeout | undefined;
  const stopTimerIfIdle = () => {
    if (subscribers.size !== 0 || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };
  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      for (const subscriber of subscribers) {
        // A socket recheck is a defense-in-depth task. One unexpected
        // callback failure must not prevent other sockets from being checked
        // or turn a timer tick into an uncaught process exception.
        try {
          subscriber();
        } catch {
          // Each controller also converts its own policy-read failures into a
          // fail-closed authorization result. This is only the final guard for
          // an unexpected synchronous subscriber failure.
        }
      }
    }, intervalMs);
    timer.unref();
  };

  return {
    subscribe(recheck) {
      subscribers.add(recheck);
      startTimer();
      return () => {
        subscribers.delete(recheck);
        stopTimerIfIdle();
      };
    },
  };
}

const webAppSocketPolicyRecheckScheduler = createWebAppSocketPolicyRecheckScheduler();

function createPolicyLookupTimeoutError(): Error {
  return new Error('Web app authorization lookup timed out.');
}

/**
 * Bounds policy-store work independently of action execution admission. A
 * timeout rejects the caller but deliberately retains the slot until the
 * underlying read settles, preventing a slow store from being retried without
 * limit. Background rechecks of one app binding share that one read; effectful
 * commands always start a fresh read.
 */
export function createWebAppSocketPolicyLookupCoordinator(
  maxActive = WEB_APP_SOCKET_POLICY_LOOKUP_MAX_ACTIVE,
  timeoutMs = WEB_APP_SOCKET_POLICY_LOOKUP_TIMEOUT_MS,
): WebAppSocketPolicyLookupCoordinator {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new RangeError('Web app socket policy lookup maxActive must be a positive integer.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Web app socket policy lookup timeoutMs must be a positive integer.');
  }

  let active = 0;
  let disposed = false;
  const backgroundLookups = new Map<string, SharedPolicyLookup<unknown>>();

  const start = <T>(key: string | null, reader: () => Promise<T>): SharedPolicyLookup<T> | null => {
    if (disposed || active >= maxActive) return null;
    active += 1;
    const operation = Promise.resolve().then(reader);
    let entry: SharedPolicyLookup<T>;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      if (key && backgroundLookups.get(key) === entry) backgroundLookups.delete(key);
    };
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(createPolicyLookupTimeoutError()), timeoutMs);
      timer.unref();
      void operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    entry = { response };
    void operation.then(release, release);
    return entry;
  };

  return {
    read<T>(key: string, reader: () => Promise<T>, options: { fresh?: boolean } = {}): Promise<T> {
      if (!options.fresh) {
        const existing = backgroundLookups.get(key) as SharedPolicyLookup<T> | undefined;
        if (existing) return existing.response;
      }

      const entry = start(options.fresh ? null : key, reader);
      if (!entry) return Promise.reject(new Error('Web app authorization lookup capacity is exhausted.'));
      if (!options.fresh) backgroundLookups.set(key, entry as SharedPolicyLookup<unknown>);
      return entry.response;
    },
    dispose() {
      disposed = true;
      backgroundLookups.clear();
    },
  };
}

function closeForAuthorization(
  webSocket: WebSocket,
  status: Extract<WebAppSocketAuthorizationStatus, 'revoked' | 'unavailable'>,
): void {
  webSocket.close(
    status === 'unavailable' ? 1013 : 1008,
    status === 'unavailable' ? 'Web app authorization is temporarily unavailable' : 'Web app access was revoked',
  );
  const fallback = setTimeout(() => {
    if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
  }, WEB_APP_SOCKET_AUTHORIZATION_CLOSE_GRACE_MS);
  fallback.unref();
  webSocket.once('close', () => clearTimeout(fallback));
}

function checkResolvedWebAppSocketAuthorization(
  resolved: ResolvedWebAppSocketExecution,
  lookups: WebAppSocketPolicyLookupCoordinator,
  options: { fresh?: boolean } = {},
): Promise<WebAppSocketAuthorizationStatus> {
  try {
    if (!runOutsideAppSettingsSnapshot(resolved.isAuthorized)) {
      return Promise.resolve('revoked');
    }
  } catch {
    // This is an infrastructure failure, not proof that the credentials were
    // revoked. Treat it as temporary unavailability so the client can retry
    // instead of leaving a live socket authorized by a failed check.
    return Promise.resolve('unavailable');
  }

  return lookups.read(
    resolved.accessPolicyLookupKey,
    () => runOutsideAppSettingsSnapshot(resolved.readCurrentAccessPolicy),
    options,
  ).then(
    (policy) => {
      try {
        return runOutsideAppSettingsSnapshot(() => resolved.evaluateCurrentAccessPolicy(policy));
      } catch {
        return 'unavailable' as const;
      }
    },
    () => 'unavailable' as const,
  );
}

/**
 * An execution snapshot is intentionally pinned at upgrade time, whereas this
 * controller rechecks only the app binding and its current authorization
 * policy. That lets an access change revoke future socket operations without
 * replacing the graph used by an already accepted action.
 */
function createWebAppSocketAuthorizationController(
  resolved: ResolvedWebAppSocketExecution,
  webSocket: WebSocket,
  lookups: WebAppSocketPolicyLookupCoordinator,
) {
  let disposed = false;
  let terminalStatus: Extract<WebAppSocketAuthorizationStatus, 'revoked' | 'unavailable'> | undefined;
  let policyRevoked = false;
  let inFlight: Promise<WebAppSocketAuthorizationStatus> | undefined;
  let stopBaseAuthorization: (() => void) | undefined;
  let stopPolicyInvalidation: (() => void) | undefined;
  let stopPolicyRecheck: (() => void) | undefined;
  let invalidationGeneration = 0;
  const policyRevocationListeners = new Set<() => void>();

  const stop = () => {
    if (disposed) return;
    disposed = true;
    stopPolicyRecheck?.();
    stopPolicyRecheck = undefined;
    stopBaseAuthorization?.();
    stopPolicyInvalidation?.();
    policyRevocationListeners.clear();
  };
  const deny = (status: Extract<WebAppSocketAuthorizationStatus, 'revoked' | 'unavailable'>) => {
    if (terminalStatus || disposed) return;
    terminalStatus = status;
    stop();
    closeForAuthorization(webSocket, status);
  };
  const revokePolicy = () => {
    if (policyRevoked || disposed) return;
    policyRevoked = true;
    stopPolicyRecheck?.();
    stopPolicyRecheck = undefined;
    // Policy revocation is permanent for this connection. Keep the base
    // credential watcher alive for any still-running browser-storage action,
    // but release the now-useless per-app invalidation listener immediately.
    stopPolicyInvalidation?.();
    stopPolicyInvalidation = undefined;
    for (const listener of policyRevocationListeners) listener();
  };
  const checkCurrentAuthorization = (requireFreshRead = false): Promise<WebAppSocketAuthorizationStatus> => {
    if (terminalStatus) return Promise.resolve(terminalStatus);
    if (policyRevoked) return Promise.resolve('policy-revoked');
    if (disposed) return Promise.resolve('revoked');
    // A periodic check that began before a publication change must not
    // authorize a new action after that change. Commands therefore require
    // their own policy read; periodic checks can still share in-flight work.
    if (!requireFreshRead && inFlight) return inFlight;
    const check = checkResolvedWebAppSocketAuthorization(resolved, lookups, { fresh: requireFreshRead });
    if (requireFreshRead) return check;
    const current = check.finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };
  const checkAndRevoke = (requireFreshRead = false) => {
    const generation = invalidationGeneration;
    void checkCurrentAuthorization(requireFreshRead).then(
      (status) => {
        if (disposed || generation !== invalidationGeneration) return;
        if (status === 'policy-revoked') revokePolicy();
        else if (status !== 'authorized') deny(status);
      },
      () => {
        if (disposed || generation !== invalidationGeneration) return;
        deny('unavailable');
      },
    );
  };
  stopPolicyRecheck = webAppSocketPolicyRecheckScheduler.subscribe(checkAndRevoke);

  stopBaseAuthorization = watchAuthorization(
    () => runOutsideAppSettingsSnapshot(resolved.isAuthorized),
    () => deny('revoked'),
  );
  // `watchAuthorization` checks synchronously during subscription. If the
  // original credentials were revoked in the narrow window since upgrade,
  // `deny` has already disposed this controller; do not then install a
  // policy-invalidation listener that nothing can ever remove.
  if (!terminalStatus) {
    stopPolicyInvalidation = subscribeWebAppSocketPolicyInvalidation(resolved.accessPolicyInvalidationKey, () => {
      invalidationGeneration += 1;
      checkAndRevoke(true);
    });
  } else {
    stopBaseAuthorization();
  }

  return {
    // Browser-storage RPC frames belong to a run which was already accepted.
    // They remain available after the app policy is revoked, but never after
    // the credentials that opened this socket are revoked.
    isAuthorized: () => !disposed && !terminalStatus && runOutsideAppSettingsSnapshot(resolved.isAuthorized),
    async authorizeOperation(): Promise<WebAppSocketAuthorizationStatus> {
      // A command must not accept an allow decision read before a known
      // publication mutation. Retry once against the newer generation; a
      // second concurrent mutation fails closed rather than spinning a
      // command-path lookup loop forever.
      let status: WebAppSocketAuthorizationStatus = 'unavailable';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const generation = invalidationGeneration;
        status = await checkCurrentAuthorization(true);
        if (status !== 'authorized' || generation === invalidationGeneration) break;
        if (attempt === 1) status = 'unavailable';
      }
      if (status === 'policy-revoked') revokePolicy();
      else if (status !== 'authorized') deny(status);
      return status;
    },
    onPolicyRevoked(listener: () => void): () => void {
      if (policyRevoked) listener();
      else policyRevocationListeners.add(listener);
      return () => policyRevocationListeners.delete(listener);
    },
    stop,
  };
}

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

function readOptionalPositiveIntegerEnvironment(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export async function initializeWebAppActionWebSockets(server: Server): Promise<WebAppActionWebSocketRuntime> {
  if (activeRuntime) return activeRuntime;

  const policyLookups = createWebAppSocketPolicyLookupCoordinator();
  const configuredMaxMessageBytes = readRuntimeLimitSettingsSync().webAppActionRequestLimitBytes;
  const browserStorageRpcOptions = {
    browserStorageTransferTimeoutMs: readOptionalPositiveIntegerEnvironment(
      'RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_TIMEOUT_MS',
    ),
    maxBrowserStorageActionBytes: readOptionalPositiveIntegerEnvironment(
      'RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTION_BYTES',
    ),
    maxBrowserStorageActiveBytes: readOptionalPositiveIntegerEnvironment(
      'RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTIVE_BYTES',
    ),
    maxBrowserStorageValueBytes: readOptionalPositiveIntegerEnvironment(
      'RIVET_WEB_APP_BROWSER_STORAGE_MAX_VALUE_BYTES',
    ),
    onBrowserStorageRpcEvent(event: RivetWebAppBrowserStorageRpcEvent) {
      recordStudioMetrics((metrics) => {
        if (event.type === 'protocol-negotiated') metrics.recordBrowserStorageRpcProtocolNegotiation(event.version);
        else metrics.recordBrowserStorageRpcTransfer(event);
      });
    },
  };
  const webSocketServer = new WebSocketServer({
    noServer: true,
    // The gateway applies configuredMaxMessageBytes to JSON control messages.
    // Leave enough room here for one independently bounded binary storage chunk.
    maxPayload: Math.max(
      configuredMaxMessageBytes,
      RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_CHUNK_BYTES + RIVET_WEB_APP_BROWSER_STORAGE_BINARY_FRAME_HEADER_BYTES,
    ),
  });
  const recorders = new Map<string, RecorderEntry>();
  let pool: Pool | null = null;
  let poolLease: ManagedPostgresPoolLease | null = null;
  let coordinator: PostgresRivetWebAppRunCoordinator | null = null;
  let accepting = true;

  const gateway: RivetWebAppWebSocketGateway = (() => {
    if (!isManagedWorkflowStorageEnabled()) {
      return createRivetWebAppWebSocketGateway({
        ...browserStorageRpcOptions,
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
    coordinator = new PostgresRivetWebAppRunCoordinator(pool, getManagedDbConnectionConfig(config), (error) =>
      console.error('[web-app-actions] PostgreSQL coordinator error:', error),
    );
    return createRivetWebAppWebSocketGateway({
      ...browserStorageRpcOptions,
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
        const initialAuthorization = await checkResolvedWebAppSocketAuthorization(resolved, policyLookups, { fresh: true });
        if (initialAuthorization !== 'authorized') {
          rejectUpgrade(socket, initialAuthorization === 'unavailable' ? 503 : 403, initialAuthorization === 'unavailable' ? 'Service Unavailable' : 'Forbidden');
          return;
        }
        if (!accepting) {
          rejectUpgrade(socket, 503, 'Service Unavailable');
          return;
        }

        webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
          const authorization = createWebAppSocketAuthorizationController(resolved, webSocket, policyLookups);
          webSocket.once('close', authorization.stop);
          if (webSocket.readyState !== 1) {
            authorization.stop();
            return;
          }
          const endpointName = getWebAppBasePath(route.routeKind, route.slug);
          // A socket can carry several concurrent actions. Keep an opaque key
          // per action context rather than reusing the socket request ID.
          const healthCorrelations = new WeakMap<object, string>();
          gateway.handleConnection(webSocket, {
            isAuthorized: authorization.isAuthorized,
            authorizeOperation: authorization.authorizeOperation,
            onPolicyRevoked: authorization.onPolicyRevoked,
            ownerScope: resolved.ownerScope,
            ...(route.routeKind === 'published' ? { acquireRunPermit: acquirePublishedWebAppActionPermit } : {}),
            project: resolved.executionProject.project,
            uiGraph: resolved.uiGraph,
            revisionKey: resolved.executionProject.revisionKey,
            request: createWebAppSocketFetchRequest(req),
            createProcessorOptions: async (actionContext) => {
              const correlationId = createRivetCorrelationId();
              healthCorrelations.set(actionContext, correlationId);
              return await createWebAppProcessorOptions(resolved.executionProject, req, null, {
                enableRemoteDebugger: route.routeKind === 'latest',
                llmProfileHealthExecutionCorrelationId: correlationId,
              });
            },
            onProcessorPrepared({ actionContext, processor, runId }) {
              const correlationId = healthCorrelations.get(actionContext) ?? createRivetCorrelationId();
              healthCorrelations.delete(actionContext);
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
                  correlationId,
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
              const fallbackMessage =
                outcome === 'cancelled'
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
      policyLookups.dispose();
      if (activeRuntime === runtime) activeRuntime = null;
    },
  };
  activeRuntime = runtime;
  return runtime;
}

export function getWebAppActionWebSocketRuntime(): WebAppActionWebSocketRuntime | null {
  return activeRuntime;
}
