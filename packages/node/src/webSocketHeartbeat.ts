import WebSocket from 'ws';

export type WebSocketHeartbeat = {
  markActivity(): void;
  stop(): void;
};

export function startWebSocketHeartbeat(
  socket: WebSocket,
  options: {
    intervalMs: number;
    timeoutMs: number;
    terminate?: (socket: WebSocket) => void;
  },
): WebSocketHeartbeat {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    return { markActivity: () => undefined, stop: () => undefined };
  }

  let awaitingPong = false;
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const terminate = options.terminate ?? ((target: WebSocket) => target.terminate());

  const clearHeartbeatTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const markActivity = () => {
    awaitingPong = false;
    clearHeartbeatTimeout();
  };
  const terminateUnresponsiveSocket = () => {
    timeout = undefined;
    if (awaitingPong && !stopped) terminate(socket);
  };
  const sendPing = () => {
    if (stopped || socket.readyState !== WebSocket.OPEN || awaitingPong) return;
    awaitingPong = true;
    try {
      socket.ping();
    } catch {
      awaitingPong = false;
      terminate(socket);
      return;
    }
    timeout = setTimeout(terminateUnresponsiveSocket, options.timeoutMs);
    unrefTimer(timeout);
  };
  const interval = setInterval(sendPing, options.intervalMs);
  unrefTimer(interval);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearHeartbeatTimeout();
    socket.off('pong', markActivity);
    socket.off('message', markActivity);
    socket.off('close', stop);
    socket.off('error', stop);
  };

  socket.on('pong', markActivity);
  socket.on('message', markActivity);
  socket.once('close', stop);
  socket.once('error', stop);

  return { markActivity, stop };
}

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>) {
  (timer as { unref?: () => void }).unref?.();
}
