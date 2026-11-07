import assert from 'node:assert/strict';
import https from 'node:https';

/** Consume the complete body. Neither a response header nor a successfully
 * opened stream counts as a completed protected request. No POST is retried. */
export function collectContinuityResponse(stream, status, headers) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0,
      ended = false;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 131072) stream.destroy(Error('Probe body exceeded bounds'));
      else chunks.push(chunk);
    });
    const fail = (reason, cause) => {
      const error =
        cause instanceof Error && Object.isExtensible(cause) ? cause : new Error(reason, cause ? { cause } : undefined);
      error.continuityResponse = { status, bodyBytes: bytes, fullBody: false, reason };
      reject(error);
    };
    stream.once('error', (error) => fail('Probe body stream failed', error));
    stream.once('aborted', () => fail('Probe body interrupted'));
    stream.once('close', () => {
      if (!ended) fail('Probe stream closed before its complete body');
    });
    stream.once('end', () => {
      ended = true;
      resolve({ status, headers, body: Buffer.concat(chunks), bytes });
    });
  });
}
export function requestHttp1(url, { agent, body, headers = {}, timeoutMs = body ? 330000 : 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        agent,
        method: body ? 'POST' : 'GET',
        headers: {
          ...headers,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        collectContinuityResponse(response, response.statusCode, response.headers).then(
          (value) => resolve({ ...value, reusedConnection: req.reusedSocket }),
          reject,
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}
export function requestHttp2(session, path, { body, headers = {}, timeoutMs = body ? 330000 : 15000 } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const stream = session.request({
    ':path': path,
    ':method': body ? 'POST' : 'GET',
    ...headers,
    ...(body ? { 'content-type': 'application/json' } : {}),
  });
  // An inactivity timer resets on each chunk and cannot bound a trickling body.
  const timer = setTimeout(() => stream.destroy(Error('HTTP/2 probe deadline exceeded')), timeoutMs);
  const completion = new Promise((resolve, reject) => {
    let headersReceived = false;
    stream.once('error', reject);
    stream.once('close', () => {
      if (!headersReceived) reject(Error('HTTP/2 probe closed before response headers'));
    });
    stream.once('response', (headers) => {
      headersReceived = true;
      collectContinuityResponse(stream, headers[':status'], headers).then(resolve, reject);
    });
  });
  stream.end(body);
  return completion.finally(() => clearTimeout(timer));
}
