import http from 'node:http';
import WebSocket from 'ws';

export type WebSocketMessage = {
  message: string;
  data: unknown;
};

export type WebSocketConnectionFailure = {
  statusCode?: number;
  error?: Error;
};

export function closeWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  try {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.removeAllListeners();
    }
    socket.terminate();
  } catch {
    // The failure path helpers may close sockets before the handshake finishes.
  }
}

export async function connectWebSocket(
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: options.headers ?? {} });

  const connection = await new Promise<{ socket?: WebSocket; failure?: WebSocketConnectionFailure }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      closeWebSocket(socket);
      reject(new Error(`Timed out connecting to ${url}`));
    }, 3000);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('unexpected-response', handleUnexpectedResponse);
      socket.off('error', handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve({ socket });
    };

    const handleUnexpectedResponse = (_request: http.ClientRequest, response: http.IncomingMessage) => {
      cleanup();
      response.resume();
      resolve({ failure: { statusCode: response.statusCode } });
    };

    const handleError = (error: Error) => {
      cleanup();
      resolve({ failure: { error } });
    };

    socket.once('open', handleOpen);
    socket.once('unexpected-response', handleUnexpectedResponse);
    socket.once('error', handleError);
  });

  if (!connection.socket) {
    throw new Error(`Expected websocket to connect, got ${JSON.stringify(connection.failure)}`);
  }

  return connection.socket;
}

export async function expectWebSocketConnectionFailure(
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<WebSocketConnectionFailure> {
  const socket = new WebSocket(url, { headers: options.headers ?? {} });

  const failure = await new Promise<WebSocketConnectionFailure | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      closeWebSocket(socket);
      reject(new Error(`Timed out waiting for websocket failure at ${url}`));
    }, 3000);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('unexpected-response', handleUnexpectedResponse);
      socket.off('error', handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve(null);
    };

    const handleUnexpectedResponse = (_request: http.ClientRequest, response: http.IncomingMessage) => {
      cleanup();
      response.resume();
      resolve({ statusCode: response.statusCode });
    };

    const handleError = (error: Error) => {
      cleanup();
      resolve({ error });
    };

    socket.once('open', handleOpen);
    socket.once('unexpected-response', handleUnexpectedResponse);
    socket.once('error', handleError);
  });

  if (failure == null) {
    closeWebSocket(socket);
    throw new Error('Expected websocket connection to fail, but it opened successfully');
  }

  socket.removeAllListeners();
  return failure;
}

export function parseJsonWebSocketMessage(raw: WebSocket.RawData): WebSocketMessage {
  const parsed = JSON.parse(raw.toString()) as {
    message?: string;
    type?: string;
    data?: unknown;
  };
  const message = parsed.message ?? parsed.type;
  if (!message) {
    throw new Error(`Websocket message missing message/type field: ${raw.toString()}`);
  }

  return {
    message,
    data: parsed.data,
  };
}

export async function waitForWebSocketMessages(
  socket: WebSocket,
  expectedMessages: string[],
  options: { timeoutMs?: number; parser?: (raw: WebSocket.RawData) => WebSocketMessage } = {},
): Promise<WebSocketMessage[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const parseMessage = options.parser ?? parseJsonWebSocketMessage;
  const seen = new Set<string>();
  const messages: WebSocketMessage[] = [];

  return await new Promise<WebSocketMessage[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for websocket messages: ${expectedMessages.join(', ')}`));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('close', handleClose);
      socket.off('error', handleError);
    };

    const handleMessage = (raw: WebSocket.RawData) => {
      const message = parseMessage(raw);
      messages.push(message);
      seen.add(message.message);

      if (expectedMessages.every((expectedMessage) => seen.has(expectedMessage))) {
        cleanup();
        resolve(messages);
      }
    };

    const handleClose = () => {
      cleanup();
      reject(new Error(`Socket closed before expected messages arrived: ${expectedMessages.join(', ')}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('close', handleClose);
    socket.once('error', handleError);
  });
}
