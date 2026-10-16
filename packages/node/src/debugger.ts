import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type GraphProcessor,
  type Project,
  type Settings,
  type NodeId,
  type StringArrayDataValue,
  type DataId,
  type Outputs,
  type FrozenNodeOutputsByGraph,
  type RemoteRunRequestId,
  type OutgoingMessageMap,
  decodeDebuggerTransportSentinels,
  normalizeClassifierProject,
} from '@valerypopoff/rivet2-core';
import { match } from 'ts-pattern';
import Emittery from 'emittery';
import { type DebuggerDatasetProvider } from './index.js';
import {
  DEBUGGER_HEARTBEAT_INTERVAL_MS,
  DEBUGGER_HEARTBEAT_TIMEOUT_MS,
  startDebuggerSocketHeartbeat,
  type DebuggerSocketHeartbeat,
} from './debuggerHeartbeat.js';
import { emitDebuggerError, sendDebuggerMessage, stringifyDebuggerMessage } from './debuggerTransport.js';
import { createDebuggerProcessorAttachments } from './debuggerProcessorAttachments.js';
import type { DebuggerSessions } from './debuggerSessions.js';

export { DEBUGGER_HEARTBEAT_INTERVAL_MS, DEBUGGER_HEARTBEAT_TIMEOUT_MS } from './debuggerHeartbeat.js';

export interface RivetDebuggerServer {
  on: Emittery<DebuggerEvents>['on'];
  off: Emittery<DebuggerEvents>['off'];

  webSocketServer: WebSocketServer;

  broadcast(processor: GraphProcessor, message: string, data: unknown, requestId?: RemoteRunRequestId): void;

  attach(processor: GraphProcessor, requestId?: RemoteRunRequestId): void;
  detach(processor: GraphProcessor): void;
}

export interface DebuggerEvents {
  error: Error;
}

export const currentDebuggerState = {
  uploadedProject: undefined as Project | undefined,
  settings: undefined as Settings | undefined,
};

export type DebuggerClientState = typeof currentDebuggerState;

export type DynamicGraphRunOptions = Omit<OutgoingMessageMap['run'], 'frozenNodeOutputs' | 'projectPath'> & {
  client: WebSocket;
  frozenNodeOutputs?: FrozenNodeOutputsByGraph;
  projectPath: string | undefined;
};

export type DynamicGraphRun = (data: DynamicGraphRunOptions) => Promise<void>;

export function startDebuggerServer(
  options: {
    getClientsForProcessor?: (processor: GraphProcessor, allClients: WebSocket[]) => WebSocket[];
    getClientDebuggerState?: (client: WebSocket) => DebuggerClientState;
    getDatasetProviderForClient?: (client: WebSocket) => DebuggerDatasetProvider | undefined;
    getProcessorsForClient?: (client: WebSocket, allProcessors: GraphProcessor[]) => GraphProcessor[];
    datasetProvider?: DebuggerDatasetProvider;
    server?: WebSocketServer;
    /** Upgrade and periodic authorization. The host must bound async work and supply its own deadline. */
    authorizeClient?: (request: IncomingMessage) => Promise<boolean>;
    /** Admission only. Existing connections continue fresh authorization and run controls while draining. */
    isAcceptingConnections?: (request: IncomingMessage) => boolean;
    sessions?: DebuggerSessions;
    /** Hosting adapters can relay observations/controls without owning processors. */
    transformBroadcast?: (payload: string) => string;
    onControl?: (client: WebSocket, payload: string) => void;
    port?: number;
    dynamicGraphRun?: DynamicGraphRun;
    allowGraphUpload?: boolean;
    throttlePartialOutputs?: number;
    host?: string;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
  } = {},
): RivetDebuggerServer {
  const { port = 21888, throttlePartialOutputs = 100, host = 'localhost' } = options;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs == null || !Number.isFinite(options.heartbeatIntervalMs)
      ? DEBUGGER_HEARTBEAT_INTERVAL_MS
      : options.heartbeatIntervalMs;
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs && Number.isFinite(options.heartbeatTimeoutMs) && options.heartbeatTimeoutMs > 0
      ? options.heartbeatTimeoutMs
      : DEBUGGER_HEARTBEAT_TIMEOUT_MS;

  const authorize = options.authorizeClient;
  if (options.server && (authorize || options.isAcceptingConnections))
    throw new Error('An externally owned debugger server must authorize its own upgrades.');
  const server =
    options.server ??
    new WebSocketServer({
      port,
      host,
      ...(options.sessions ? { handleProtocols: () => 'rivet-session-v1' } : {}),
      ...(authorize || options.isAcceptingConnections
        ? {
            verifyClient: (info: { req: IncomingMessage }, done: (allowed: boolean, code?: number) => void) => {
              void Promise.resolve()
                .then(async () => {
                  if (options.isAcceptingConnections?.(info.req) === false) return false;
                  const authorized = (await authorize?.(info.req)) ?? true;
                  return authorized && options.isAcceptingConnections?.(info.req) !== false;
                })
                .then(
                  (allowed) => done(allowed, allowed ? undefined : 403),
                  () => done(false, 403),
                );
            },
          }
        : {}),
    });

  if (authorize)
    server.on('connection', (client, request) => {
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void Promise.resolve()
          .then(() => authorize(request))
          .then(
            (allowed) => {
              if (!allowed) client.terminate();
            },
            () => client.terminate(),
          )
          .finally(() => {
            checking = false;
          });
      }, 5_000);
      timer.unref();
      client.once('close', () => clearInterval(timer));
    });

  const emitter = new Emittery<DebuggerEvents>();

  const socketHeartbeats = new WeakMap<WebSocket, DebuggerSocketHeartbeat>();
  const processorAttachments = createDebuggerProcessorAttachments({
    broadcast: broadcastDebuggerMessage,
    emitError: (err) => emitDebuggerError(emitter, err),
    throttlePartialOutputs,
  });

  function broadcastDebuggerMessage(
    processor: GraphProcessor,
    message: string,
    data: unknown,
    requestId?: RemoteRunRequestId,
  ) {
    const clients = options.getClientsForProcessor?.(processor, [...server.clients]) ?? [...server.clients];
    const resolvedRequestId = requestId ?? processorAttachments.getRequestId(processor);
    const serialized = stringifyDebuggerMessage({ message, data, requestId: resolvedRequestId }, emitter);
    const payload = serialized && (options.transformBroadcast?.(serialized) ?? serialized);

    if (!payload) {
      return;
    }

    clients.forEach((client) => {
      if (options.sessions) options.sessions.send(client, payload);
      else sendDebuggerMessage(client, payload, emitter, socketHeartbeats.get(client));
    });
  }

  server.on('connection', (socket, request) => {
    let logicalClient: WebSocket;
    try {
      logicalClient = options.sessions?.bind(socket, request) ?? socket;
    } catch {
      socket.close(4409, 'Debugger session unavailable');
      return;
    }
    const heartbeat = startDebuggerSocketHeartbeat(socket, {
      intervalMs: heartbeatIntervalMs,
      timeoutMs: heartbeatTimeoutMs,
    });
    socketHeartbeats.set(socket, heartbeat);

    socket.once('close', () => {
      socketHeartbeats.delete(socket);
    });

    const datasetProvider = getDatasetProviderForClient(logicalClient, options);
    if (datasetProvider) {
      datasetProvider.onrequest = (type, data) => {
        const payload = stringifyDebuggerMessage(
          {
            message: type,
            data,
          },
          emitter,
        );
        if (payload) {
          if (options.sessions) options.sessions.send(logicalClient, payload);
          else sendDebuggerMessage(socket, payload, emitter, socketHeartbeats.get(socket));
        }
      };
    }

    const handleMessage = async (data: RawData) => {
      try {
        if (options.sessions && !options.sessions.isCurrent(socket)) return;
        const stringData = data.toString();

        if (stringData.startsWith('set-static-data:')) {
          const [, id, value] = stringData.split(':');
          const debuggerState = getDebuggerStateForClient(logicalClient, options);

          if (debuggerState.uploadedProject) {
            debuggerState.uploadedProject.data ??= {};
            debuggerState.uploadedProject.data![id as DataId] = value!;
          }
          return;
        }

        const message = JSON.parse(data.toString()) as { type: string; data: unknown };
        if (['abort', 'pause', 'resume', 'user-input', 'preload'].includes(message.type))
          options.onControl?.(socket, stringData);

        await match(message)
          .with({ type: 'run' }, async () => {
            const runData = message.data as OutgoingMessageMap['run'];
            if (options.sessions) {
              try {
                if (!options.sessions.acceptRun(logicalClient, runData.requestId)) return;
              } catch {
                options.sessions.send(
                  logicalClient,
                  JSON.stringify({
                    message: 'error',
                    requestId: typeof runData.requestId === 'string' ? runData.requestId : undefined,
                    data: { error: 'Executor session run identity or capacity is unavailable. Open a new session.' },
                  }),
                );
                return;
              }
            }
            const { frozenNodeOutputs, projectPath, ...forwardedRunData } = runData;
            const decodedFrozenNodeOutputs = frozenNodeOutputs
              ? decodeDebuggerTransportSentinels(frozenNodeOutputs)
              : undefined;

            await options.dynamicGraphRun?.({
              ...forwardedRunData,
              client: logicalClient,
              frozenNodeOutputs: decodedFrozenNodeOutputs,
              projectPath: projectPath ?? undefined,
            });
          })
          .with({ type: 'set-dynamic-data' }, async () => {
            if (options.allowGraphUpload) {
              const { project, settings } = message.data as {
                project: Project;
                settings: Settings;
                datasets: string;
              };
              // Remote clients send an already-objectified project instead of
              // serialized YAML. Normalize here before the sidecar resolves
              // project plugins so legacy Jev graphs work without TypeSafe.
              normalizeClassifierProject(project);
              const debuggerState = getDebuggerStateForClient(logicalClient, options);
              debuggerState.uploadedProject = project;
              debuggerState.settings = settings;
            }
          })
          .with({ type: 'datasets:response' }, async () => {
            getDatasetProviderForClient(logicalClient, options)?.handleResponse(message.type, message.data);
          })
          .otherwise(async () => {
            const attachedProcessors = processorAttachments.getAttachedProcessors();
            const processorsForClient =
              options.getProcessorsForClient?.(logicalClient, attachedProcessors) ?? attachedProcessors;
            const requestId = getRequestIdForControlMessage(message.data);
            const processors = requestId
              ? processorsForClient.filter((processor) => processorAttachments.getRequestId(processor) === requestId)
              : processorsForClient;

            for (const processor of processors) {
              await match(message)
                .with({ type: 'abort' }, async () => {
                  await processor.abort();
                })
                .with({ type: 'pause' }, async () => {
                  processor.pause();
                })
                .with({ type: 'resume' }, async () => {
                  processor.resume();
                })
                .with({ type: 'user-input' }, async () => {
                  const { nodeId, answers } = message.data as { nodeId: NodeId; answers: StringArrayDataValue };
                  processor.userInput(nodeId, answers);
                })
                .with({ type: 'preload' }, async () => {
                  const data = (message.data as { nodeData: Record<NodeId, Outputs> }).nodeData;

                  for (const [nodeId, outputs] of Object.entries(data)) {
                    processor.preloadNodeData(nodeId as NodeId, outputs);
                  }
                })
                .otherwise(async () => {
                  throw new Error(`Unknown message type: ${message.type}`);
                });
            }
          });
      } catch (err) {
        emitDebuggerError(emitter, err);
      }
    };

    socket.on('message', (data) => {
      void handleMessage(data);
    });

    if (options.allowGraphUpload) {
      const payload = stringifyDebuggerMessage(
        {
          message: 'graph-upload-allowed',
          data: {},
        },
        emitter,
      );
      if (payload) {
        if (options.sessions) options.sessions.send(logicalClient, payload);
        else sendDebuggerMessage(socket, payload, emitter, socketHeartbeats.get(socket));
      }
    }
  });

  const debuggerServer: RivetDebuggerServer = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    webSocketServer: server,

    /** Given an event on a processor, sends that processor's events to the correct debugger clients (allows routing debugger). */
    broadcast: broadcastDebuggerMessage,

    attach: processorAttachments.attach,

    detach: processorAttachments.detach,
  };

  return debuggerServer;
}

function getRequestIdForControlMessage(data: unknown): RemoteRunRequestId | undefined {
  if (typeof data !== 'object' || data == null) {
    return undefined;
  }

  const requestId = (data as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? (requestId as RemoteRunRequestId) : undefined;
}

function getDatasetProviderForClient(
  client: WebSocket,
  options: {
    getDatasetProviderForClient?: (client: WebSocket) => DebuggerDatasetProvider | undefined;
    datasetProvider?: DebuggerDatasetProvider;
  },
): DebuggerDatasetProvider | undefined {
  return options.getDatasetProviderForClient?.(client) ?? options.datasetProvider;
}

function getDebuggerStateForClient(
  client: WebSocket,
  options: {
    getClientDebuggerState?: (client: WebSocket) => DebuggerClientState;
  },
): DebuggerClientState {
  return options.getClientDebuggerState?.(client) ?? currentDebuggerState;
}
