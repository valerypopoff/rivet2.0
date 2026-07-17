import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type GraphId,
  type GraphProcessor,
  type Project,
  type Settings,
  type GraphInputs,
  type NodeId,
  type StringArrayDataValue,
  type DataId,
  type DataValue,
  type Outputs,
  type FrozenNodeOutputsByGraph,
  type RemoteRunRequestId,
  type RivetWebAppStorage,
  decodeDebuggerTransportSentinels,
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

export type DynamicGraphRunOptions = {
  client: WebSocket;
  requestId: RemoteRunRequestId;
  graphId: GraphId;
  inputs?: GraphInputs;
  runToNodeIds?: NodeId[];
  preloadData?: Record<NodeId, Outputs>;
  frozenNodeOutputs?: FrozenNodeOutputsByGraph;
  contextValues: Record<string, DataValue>;
  projectPath: string | undefined;
  useEditorCache?: boolean;
  captureNodeTimings?: boolean;
  webAppStorage?: RivetWebAppStorage;
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

  const server = options.server ?? new WebSocketServer({ port, host });

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
    const payload = stringifyDebuggerMessage({ message, data, requestId: resolvedRequestId }, emitter);

    if (!payload) {
      return;
    }

    clients.forEach((client) => sendDebuggerMessage(client, payload, emitter, socketHeartbeats.get(client)));
  }

  server.on('connection', (socket) => {
    const heartbeat = startDebuggerSocketHeartbeat(socket, {
      intervalMs: heartbeatIntervalMs,
      timeoutMs: heartbeatTimeoutMs,
    });
    socketHeartbeats.set(socket, heartbeat);

    socket.once('close', () => {
      socketHeartbeats.delete(socket);
    });

    const datasetProvider = getDatasetProviderForClient(socket, options);
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
          sendDebuggerMessage(socket, payload, emitter, socketHeartbeats.get(socket));
        }
      };
    }

    const handleMessage = async (data: RawData) => {
      try {
        const stringData = data.toString();

        if (stringData.startsWith('set-static-data:')) {
          const [, id, value] = stringData.split(':');
          const debuggerState = getDebuggerStateForClient(socket, options);

          if (debuggerState.uploadedProject) {
            debuggerState.uploadedProject.data ??= {};
            debuggerState.uploadedProject.data![id as DataId] = value!;
          }
          return;
        }

        const message = JSON.parse(data.toString()) as { type: string; data: unknown };

        await match(message)
          .with({ type: 'run' }, async () => {
            const runData = message.data as {
              requestId: RemoteRunRequestId;
              graphId: GraphId;
              inputs: GraphInputs;
              runToNodeIds?: NodeId[];
              preloadData?: Record<NodeId, Outputs>;
              frozenNodeOutputs?: FrozenNodeOutputsByGraph;
              contextValues: Record<string, DataValue>;
              projectPath: string | undefined;
              useEditorCache?: boolean;
              captureNodeTimings?: boolean;
              webAppStorage?: RivetWebAppStorage;
            };
            const {
              requestId,
              graphId,
              inputs,
              runToNodeIds,
              contextValues,
              preloadData,
              frozenNodeOutputs,
              projectPath,
              useEditorCache,
              captureNodeTimings,
              webAppStorage,
            } = runData;
            const decodedFrozenNodeOutputs = frozenNodeOutputs
              ? decodeDebuggerTransportSentinels(frozenNodeOutputs)
              : undefined;

            await options.dynamicGraphRun?.({
              client: socket,
              requestId,
              graphId,
              inputs,
              runToNodeIds,
              contextValues,
              preloadData,
              frozenNodeOutputs: decodedFrozenNodeOutputs,
              projectPath,
              useEditorCache,
              captureNodeTimings,
              webAppStorage,
            });
          })
          .with({ type: 'set-dynamic-data' }, async () => {
            if (options.allowGraphUpload) {
              const { project, settings } = message.data as {
                project: Project;
                settings: Settings;
                datasets: string;
              };
              const debuggerState = getDebuggerStateForClient(socket, options);
              debuggerState.uploadedProject = project;
              debuggerState.settings = settings;
            }
          })
          .with({ type: 'datasets:response' }, async () => {
            getDatasetProviderForClient(socket, options)?.handleResponse(message.type, message.data);
          })
          .otherwise(async () => {
            const attachedProcessors = processorAttachments.getAttachedProcessors();
            const processorsForClient =
              options.getProcessorsForClient?.(socket, attachedProcessors) ?? attachedProcessors;
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
        sendDebuggerMessage(socket, payload, emitter, socketHeartbeats.get(socket));
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
