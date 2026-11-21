import http from 'node:http';
import { randomBytes } from 'node:crypto';

/** Ephemeral local capability, valid only while the operator owns its DB lock. */
export async function serveRecordingTransitionGuard(check, identity) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    try {
      await check();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(identity));
    } catch {
      response.writeHead(503).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export async function assertRecordingTransitionGuard(identity, required = true) {
  const raw = process.env.RIVET_RECORDING_TRANSITION_GUARD;
  if (!raw) {
    if (!required) return;
    throw Error('This release requires the recording storage transition wrapper. No deployment was started.');
  }
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}$/.test(url.pathname))
    throw Error('Invalid recording storage transition guard.');
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Recording storage transition ownership was lost.');
  const actual = await response.json();
  if (actual.protocol !== 1 || ['release', 'namespace', 'context'].some((key) => identity[key] !== actual[key]))
    throw Error('Recording storage guard belongs to another installation.');
  return actual;
}
