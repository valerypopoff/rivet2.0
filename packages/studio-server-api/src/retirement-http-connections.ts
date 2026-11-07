import type { Server, ServerResponse } from 'node:http';

/** Node's idle closer checks response.finished, which is already true after
 * end() even when backpressure leaves response bytes buffered in the socket. */
export function createRetirementHttpConnections(server: Server, isWithdrawing: () => boolean) {
  const responses = new Set<ServerResponse>();
  let closeRequested = false;
  const closeIdleConnections = () => {
    closeRequested = true;
    for (const response of responses)
      if (response.writableEnded && !response.writableFinished && !response.destroyed) return;
    closeRequested = false;
    server.closeIdleConnections();
  };
  return {
    closeIdleConnections,
    observeResponse(response: ServerResponse) {
      responses.add(response);
      if (isWithdrawing()) response.setHeader('Connection', 'close');
      const settled = () => {
        if (!responses.delete(response)) return;
        if (closeRequested || isWithdrawing()) closeIdleConnections();
      };
      response.once('finish', settled);
      response.once('close', settled);
    },
  };
}
