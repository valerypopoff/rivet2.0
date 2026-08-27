import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { startDebuggerServer, type RivetDebuggerServer } from '@valerypopoff/rivet2-node';
import { WebSocketServer } from 'ws';
import { isTrustedProxyRequest } from './auth.js';

export const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = '/ws/latest-debugger';

type RivetDebuggerServerOptions = NonNullable<Parameters<typeof startDebuggerServer>[0]>;

let latestWorkflowRemoteDebugger: RivetDebuggerServer | null = null;
let latestWorkflowRemoteDebuggerHttpServer: HttpServer | null = null;
let latestWorkflowRemoteDebuggerUpgradeHandler:
  | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
  | null = null;

export function isLatestWorkflowRemoteDebuggerEnabled(): boolean {
  const configuredValue = process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER?.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(configuredValue ?? '');
}

function rejectWebSocketUpgrade(socket: Duplex, statusCode: 401 | 404, statusText: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function initializeLatestWorkflowRemoteDebugger(httpServer: HttpServer): RivetDebuggerServer | null {
  if (latestWorkflowRemoteDebugger) {
    return latestWorkflowRemoteDebugger;
  }

  const debuggerEnabled = isLatestWorkflowRemoteDebuggerEnabled();

  if (!debuggerEnabled && latestWorkflowRemoteDebuggerUpgradeHandler) {
    return null;
  }

  const webSocketServer = debuggerEnabled ? new WebSocketServer({ noServer: true }) : null;

  if (!latestWorkflowRemoteDebuggerUpgradeHandler) {
    latestWorkflowRemoteDebuggerUpgradeHandler = (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');

      if (url.pathname !== LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH) {
        return;
      }

      if (!isTrustedProxyRequest(request)) {
        rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      if (!debuggerEnabled || !webSocketServer) {
        rejectWebSocketUpgrade(socket, 404, 'Not Found');
        return;
      }

      const handleUpgradeComplete = (webSocket: unknown) => {
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

  latestWorkflowRemoteDebugger = startDebuggerServer({
    server: webSocketServer as RivetDebuggerServerOptions['server'],
  });

  return latestWorkflowRemoteDebugger;
}

export function getLatestWorkflowRemoteDebugger(): RivetDebuggerServer {
  if (!latestWorkflowRemoteDebugger) {
    throw new Error('Latest workflow remote debugger has not been initialized');
  }

  return latestWorkflowRemoteDebugger;
}

export function maybeGetLatestWorkflowRemoteDebugger(): RivetDebuggerServer | undefined {
  return latestWorkflowRemoteDebugger ?? undefined;
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
}
