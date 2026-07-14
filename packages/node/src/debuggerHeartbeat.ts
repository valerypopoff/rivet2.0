import type WebSocket from 'ws';
import { terminateDebuggerSocket } from './debuggerTransport.js';
import { startWebSocketHeartbeat } from './webSocketHeartbeat.js';

export const DEBUGGER_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEBUGGER_HEARTBEAT_TIMEOUT_MS = 10_000;

export type DebuggerSocketHeartbeat = {
  markActivity: () => void;
};

export function startDebuggerSocketHeartbeat(
  socket: WebSocket,
  options: {
    intervalMs: number;
    timeoutMs: number;
  },
): DebuggerSocketHeartbeat {
  return startWebSocketHeartbeat(socket, {
    ...options,
    terminate: terminateDebuggerSocket,
  });
}
