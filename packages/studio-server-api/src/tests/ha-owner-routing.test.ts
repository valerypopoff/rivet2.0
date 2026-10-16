import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import {
  executorOwnerPath,
  parseExecutorOwnerPath,
  installExecutorOwnerRouting,
  type OwnerRoutingConfig,
} from '../ha-owner-routing.js';
import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { listenTestServer } from './helpers/http-server-harness.js';
import { connectWebSocket, closeWebSocket, expectWebSocketConnectionFailure } from './helpers/websocket-harness.js';

const config: OwnerRoutingConfig = {
  pod: 'rivet-backend-0',
  backendName: 'rivet-backend',
  incarnation: randomUUID(),
  headless: 'rivet-backend-headless.rivet.svc.cluster.local',
  installation: 'rivet/rivet',
  apiPort: 3001,
  executorPort: 21888,
  key: 'test-only-installation-key',
};
test('executor route binds installation, pod and process incarnation without exposing the key', () => {
  const pathname = executorOwnerPath(config);
  assert.deepEqual(parseExecutorOwnerPath(config, pathname), { pod: config.pod, incarnation: config.incarnation });
  assert.equal(pathname.includes(config.key), false);
  const neighbor = { ...config, pod: 'rivet-backend-1' };
  assert.deepEqual(parseExecutorOwnerPath(neighbor, pathname), { pod: config.pod, incarnation: config.incarnation });
  for (const changed of [
    { ...config, key: 'other-key' },
    { ...config, installation: 'other/rivet' },
    { ...config, backendName: 'other-backend' },
  ])
    assert.throws(() => parseExecutorOwnerPath(changed, pathname));
  for (const changed of [
    pathname.replace(config.pod, 'rivet-backend-1'),
    pathname.replace(config.incarnation, randomUUID()),
    `${pathname}/extra`,
    pathname.replace(config.pod, '127.0.0.1'),
    pathname.replace(config.pod, 'rivet-backend-99999'),
  ])
    assert.throws(() => parseExecutorOwnerPath(config, changed));
});

test('owner upgrade requires fresh UI authentication and reaches only the unchanged local incarnation', async (t) => {
  const savedKey = process.env.RIVET_KEY,
    savedMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  process.env.RIVET_KEY = config.key;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
  t.after(() => {
    if (savedKey == null) delete process.env.RIVET_KEY;
    else process.env.RIVET_KEY = savedKey;
    if (savedMode == null) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = savedMode;
  });
  const executorHttp = createServer();
  const executor = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  executorHttp.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/internal');
    upgrades++;
    executor.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (message) => client.send(message));
    });
  });
  const executorAddress = await listenTestServer(executorHttp);
  const apiHttp = createServer();
  const apiAddress = await listenTestServer(apiHttp);
  const owner = { ...config, apiPort: apiAddress.port, executorPort: executorAddress.port };
  const dispose = installExecutorOwnerRouting(apiHttp, owner);
  t.after(async () => {
    dispose();
    for (const client of executor.clients) closeWebSocket(client);
    executor.close();
    await apiAddress.close();
    await executorAddress.close();
  });
  const address = apiAddress.baseUrl.replace('http:', 'ws:');
  const pathname = executorOwnerPath(owner);
  assert.equal((await expectWebSocketConnectionFailure(`${address}${pathname}`)).statusCode, 401);
  const headers = {
    'X-Rivet-Proxy-Auth': getExpectedProxyAuthToken(),
    cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
  };
  assert.equal(
    (
      await expectWebSocketConnectionFailure(`${address}${pathname}`, {
        headers: { 'X-Rivet-Proxy-Auth': headers['X-Rivet-Proxy-Auth'] },
      })
    ).statusCode,
    401,
  );
  const client = await connectWebSocket(`${address}${pathname}`, { headers });
  t.after(() => closeWebSocket(client));
  const echoed = once(client, 'message');
  client.send('control-not-replayed');
  assert.equal(String((await echoed)[0]), 'control-not-replayed');
  const stale = executorOwnerPath({ ...owner, incarnation: randomUUID() });
  assert.equal((await expectWebSocketConnectionFailure(`${address}${stale}`, { headers })).statusCode, 409);
  assert.equal(upgrades, 1);
});
