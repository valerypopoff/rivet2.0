import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { startDebuggerServer, type RivetDebuggerServer } from '@valerypopoff/rivet2-node';
import { WebSocketServer, type WebSocket } from 'ws';
import { isTrustedProxyRequest } from './auth.js';
import { isServerUiAuthRequestAllowed } from './server-ui-auth.js';
import { watchAuthorization } from './watch-authorization.js';
import { isVmMigrationMaintenanceActive } from './vm-migration-maintenance.js';
import { isLegacyRestorePaused } from './legacy-restore/service.js';
import { readOwnerRoutingConfig } from './ha-owner-routing.js';
import { LatestDebuggerRelay } from './ha-latest-relay.js';
import { randomUUID } from 'node:crypto';
import { parseLatestDebuggerPath, type LatestDebuggerChannel } from '@valerypopoff/rivet2-core';
import { LatestDebuggerPolicy } from './latest-debugger-policy.js';
import { createLatestDebuggerReporter } from './latest-debugger-diagnostics.js';

export const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = '/ws/latest-debugger';

type RivetDebuggerServerOptions = NonNullable<Parameters<typeof startDebuggerServer>[0]>;

let latestWorkflowRemoteDebugger: RivetDebuggerServer | null = null;
let retiring = false;
let relay: LatestDebuggerRelay | undefined;
let policy: LatestDebuggerPolicy | undefined;
export function isLatestDebuggerRelayReady(): boolean {
  return !relay || relay.ready;
}

export function beginLatestWorkflowRemoteDebuggerDrain(): void {
  retiring = true;
}
let latestWorkflowRemoteDebuggerHttpServer: HttpServer | null = null;
let latestWorkflowRemoteDebuggerUpgradeHandler:
  | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
  | null = null;

export function isLatestWorkflowRemoteDebuggerEnabled(): boolean {
  const configuredValue = process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER?.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(configuredValue ?? '');
}

function rejectWebSocketUpgrade(socket: Duplex, statusCode: 400 | 401 | 404 | 503, statusText: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function initializeLatestWorkflowRemoteDebugger(httpServer: HttpServer): RivetDebuggerServer | null {
  if (latestWorkflowRemoteDebugger) {
    return policy!.forChannel(latestWorkflowRemoteDebugger, null);
  }

  const debuggerEnabled = isLatestWorkflowRemoteDebuggerEnabled();

  if (!debuggerEnabled && latestWorkflowRemoteDebuggerUpgradeHandler) {
    return null;
  }

  const webSocketServer = debuggerEnabled ? new WebSocketServer({ noServer: true }) : null;
  const owner = readOwnerRoutingConfig();
  const identity = owner ?? {
    pod: 'local',
    incarnation: randomUUID(),
    headless: '',
    backendName: 'local',
    apiPort: 1,
    executorPort: 1,
    installation: 'local',
    key: randomUUID(),
  };
  const report = createLatestDebuggerReporter();
  policy = new LatestDebuggerPolicy(identity.pod, identity.incarnation, report);
  if (webSocketServer)
    relay = new LatestDebuggerRelay(
      identity,
      webSocketServer,
      owner ? Number(process.env.RIVET_HA_PEER_LIMIT) : 0,
      undefined,
      (input, channel) => policy!.control(input, channel),
      report,
    );

  if (!latestWorkflowRemoteDebuggerUpgradeHandler) {
    latestWorkflowRemoteDebuggerUpgradeHandler = (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '', 'http://localhost');
      } catch {
        rejectWebSocketUpgrade(socket, 400, 'Bad Request');
        return;
      }

      if (url.pathname === '/internal/ha/latest' && relay && webSocketServer) {
        if (!relay.authorize(request)) {
          rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (client) =>
          webSocketServer.emit('connection', client, request),
        );
        return;
      }
      if (!url.pathname.startsWith(LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH)) {
        return;
      }
      try {
        parseLatestDebuggerPath(url.pathname);
      } catch {
        rejectWebSocketUpgrade(socket, 400, 'Bad Request');
        return;
      }

      if (retiring || isVmMigrationMaintenanceActive() || isLegacyRestorePaused()) {
        rejectWebSocketUpgrade(socket, 503, 'Service Unavailable');
        return;
      }

      let authorized: boolean;
      try {
        authorized = isTrustedProxyRequest(request) && isServerUiAuthRequestAllowed(request);
      } catch {
        // Upgrade callbacks are outside Express's error boundary.
        rejectWebSocketUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      if (!authorized) {
        rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      if (!debuggerEnabled || !webSocketServer) {
        rejectWebSocketUpgrade(socket, 404, 'Not Found');
        return;
      }

      const handleUpgradeComplete = (webSocket: WebSocket) => {
        const stop = watchAuthorization(
          () => isServerUiAuthRequestAllowed(request),
          () => webSocket.terminate(),
        );
        webSocket.once('close', stop);
        if (webSocket.readyState !== 1) return;
        webSocketServer.emit('connection', webSocket, request);
      };

      webSocketServer.handleUpgrade(request, socket, head, handleUpgradeComplete);
    };
    latestWorkflowRemoteDebuggerHttpServer = httpServer;
    httpServer.on('upgrade', latestWorkflowRemoteDebuggerUpgradeHandler);
  }

  if (!debuggerEnabled || !webSocketServer) {
    return null;
  }

  const activePolicy = policy;
  const activeRelay = relay!;
  latestWorkflowRemoteDebugger = startDebuggerServer({
    server: webSocketServer as RivetDebuggerServerOptions['server'],
    transformBroadcast: (payload, processor, message, data) => {
      const scoped = activePolicy.decorate(payload, processor, message, data);
      return scoped ? activeRelay.transformBroadcast(scoped) : '';
    },
    sendBroadcast: relay?.sendBroadcast,
    interceptMessage: relay?.interceptMessage,
  });

  return policy!.forChannel(latestWorkflowRemoteDebugger, null);
}

export function maybeGetLatestWorkflowRemoteDebugger(
  channel: LatestDebuggerChannel = null,
): RivetDebuggerServer | undefined {
  return latestWorkflowRemoteDebugger && policy ? policy.forChannel(latestWorkflowRemoteDebugger, channel) : undefined;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function disposeLatestWorkflowRemoteDebugger(): Promise<void> {
  relay?.dispose();
  relay = undefined;
  policy = undefined;
  const debuggerServer = latestWorkflowRemoteDebugger;
  const httpServer = latestWorkflowRemoteDebuggerHttpServer;
  const upgradeHandler = latestWorkflowRemoteDebuggerUpgradeHandler;
  latestWorkflowRemoteDebugger = null;
  latestWorkflowRemoteDebuggerHttpServer = null;
  latestWorkflowRemoteDebuggerUpgradeHandler = null;

  if (httpServer && upgradeHandler) {
    httpServer.off('upgrade', upgradeHandler);
  }

  if (debuggerServer) {
    await closeWebSocketServer(debuggerServer.webSocketServer);
  }
}

// Test-only reset seam for the module-scoped debugger singleton.
export async function resetLatestWorkflowRemoteDebuggerForTests(): Promise<void> {
  await disposeLatestWorkflowRemoteDebugger();
  retiring = false;
}
