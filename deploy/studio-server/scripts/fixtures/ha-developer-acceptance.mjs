// Only exec'd inside the exact isolated backend by the provider qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { requestBackendRetirement } from '/opt/rivet/retire-backend.mjs';

assert.equal(process.env.RIVET_POD_UID, process.argv[2]);
const identity = () => requestBackendRetirement(process.env.RIVET_ROLLING_RETIREMENT_SOCKET);
assert.equal((await identity()).incarnation, process.argv[3]);
const headers = {
  'x-rivet-proxy-auth': createHash('sha256')
    .update(process.env.RIVET_KEY + ':proxy-auth')
    .digest('hex'),
  cookie:
    'rivet_ui_token=' +
    createHash('sha256')
      .update(process.env.RIVET_KEY + ':ui-session')
      .digest('hex'),
};
const base = 'http://127.0.0.1:' + process.env.PORT;
const read = async (route) => {
  const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
};
await read('/api/workflows/tree');
const config = await read('/api/config');
const url = new URL(config.executorWsUrl);
url.host = '127.0.0.1:' + process.env.PORT;
await new Promise((resolve, reject) => {
  const socket = new WebSocket(url, ['rivet-session-v1'], { headers });
  const timer = setTimeout(() => {
    socket.terminate();
    reject(Error('Editor acceptance timed out'));
  }, 10000);
  const finish = (error) => {
    clearTimeout(timer);
    socket.close();
    if (error) reject(error);
    else resolve();
  };
  socket.once('error', finish);
  socket.on('message', (raw) => {
    try {
      if (JSON.parse(raw).message === 'executor-session-ready') finish();
    } catch (e) {
      finish(e);
    }
  });
});
assert.equal((await identity()).incarnation, process.argv[3]);
console.log(
  JSON.stringify({
    podUid: process.env.RIVET_POD_UID,
    incarnation: process.argv[3],
    developerApi: true,
    editorSession: true,
  }),
);
