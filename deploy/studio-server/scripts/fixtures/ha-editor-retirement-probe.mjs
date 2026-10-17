// Runs only via kubectl exec in a disposable release-gate backend. It never
// initiates retirement: the real release owner must fence this accepted run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { UserInputNodeImpl, GraphOutputNodeImpl } from '@valerypopoff/rivet2-core';
import { requestBackendRetirement } from '/opt/rivet/retire-backend.mjs';

const [marker, neighbor, hold = '25000'] = process.argv.slice(2);
if (
  !/^\/tmp\/rivet-ha-probe-[a-f0-9-]{36}\.json$/.test(marker ?? '') ||
  !/^[a-z0-9-]+$/.test(neighbor ?? '') ||
  !['25000', '45000'].includes(hold)
)
  throw Error('Invalid disposable probe identity');
const deadline = Date.now() + 180_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = {
  'x-rivet-proxy-auth': createHash('sha256').update(`${process.env.RIVET_KEY}:proxy-auth`).digest('hex'),
  cookie: `rivet_ui_token=${createHash('sha256').update(`${process.env.RIVET_KEY}:ui-session`).digest('hex')}`,
};
const base = `http://127.0.0.1:${process.env.PORT}`;
const sockets = [];
const waitFor = async (description, condition) => {
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(25);
  }
  throw Error(`Timed out waiting for ${description}`);
};
const connect = async (url, messages, protocols) => {
  const socket = new WebSocket(url, protocols, { headers });
  sockets.push(socket);
  socket.on('error', () => {});
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
};
const send = (socket, type, data) => socket.send(JSON.stringify({ type, data }));
try {
  const peer = `${neighbor}.${process.env.RIVET_HA_HEADLESS_SERVICE}:${process.env.PORT}`;
  const observations = [];
  const latest = await connect(`ws://${peer}/ws/latest-debugger`, observations);
  await waitFor('mesh observer greeting', () => observations.find((e) => e.message === 'latest-session'));
  const initial = observations.length;
  const inputMarker = `ha-latest-${marker.split('/').at(-1)}`;
  const latestCall = fetch(`${base}/workflows-latest/managed-release-workflow`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${process.env.RIVET_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: inputMarker }),
    signal: AbortSignal.timeout(30_000),
  });
  const started = await waitFor('remote latest start', () => observations.slice(initial).find((e) =>
    e.message === 'start' && e.rivetEventId?.startsWith(`${process.env.RIVET_POD_NAME}:`) &&
    JSON.stringify(e.data?.inputs).includes(inputMarker)));
  const startSequence = Number(started.rivetEventId.split(':').at(-1));
  // Replay can arrive after the greeting. Count this run's owner sequence,
  // never an earlier completed run merely because it arrived on this socket.
  const peerEvents = () => observations.filter(e => e.rivetEventId?.startsWith(`${process.env.RIVET_POD_NAME}:`) &&
    Number(e.rivetEventId.split(':').at(-1)) >= startSequence);
  send(latest, 'pause');
  await waitFor('remote latest pause', () => peerEvents().find((e) => e.message === 'pause'));
  send(latest, 'resume');
  const latestResponse = await latestCall;
  assert.equal(latestResponse.status, 200, await latestResponse.text());
  await waitFor('remote latest completion', () => peerEvents().find((e) => e.message === 'done'));
  assert.equal(peerEvents().filter((e) => e.message === 'pause').length, 1);
  assert.equal(peerEvents().filter((e) => e.message === 'done').length, 1);
  latest.close();

  const configResponse = await fetch(`${base}/api/config`, { headers });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  const ownerUrl = new URL(config.executorWsUrl);
  ownerUrl.host = peer; // Preserve the signed original owner path across another API.
  const messages = [];
  let socket = await connect(ownerUrl.href, messages, ['rivet-session-v1']);
  const session = await waitFor('logical editor session', () => messages.find((e) => e.message === 'executor-session'));
  const input = UserInputNodeImpl.create(),
    output = GraphOutputNodeImpl.create();
  output.data.id = 'result';
  output.data.dataType = 'string[]';
  const requestId = marker.split('/').at(-1).replace('.json', '');
  const project = {
    metadata: { id: requestId, title: 'HA editor probe', description: '', mainGraphId: 'main' },
    graphs: {
      main: {
        metadata: { id: 'main', name: 'Main' },
        nodes: [input, output],
        connections: [{ outputNodeId: input.id, outputId: 'output', inputNodeId: output.id, inputId: 'value' }],
      },
    },
  };
  send(socket, 'set-dynamic-data', { project, settings: {} });
  send(socket, 'run', { requestId, graphId: 'main' });
  const runEvent = (message) => messages.find((e) => e.requestId === requestId && e.message === message);
  await waitFor('accepted editor input request', () => runEvent('userInput'));
  send(socket, 'pause', { requestId });
  await waitFor('accepted editor pause', () => runEvent('pause'));
  await fs.writeFile(marker, JSON.stringify({ phase: 'paused', pod: process.env.RIVET_POD_NAME }), {
    flag: 'wx',
    mode: 0o600,
  });
  const status = () => requestBackendRetirement(process.env.RIVET_ROLLING_RETIREMENT_SOCKET);
  const retiring = await waitFor('real release owner retirement', async () => {
    const value = await status();
    return value.state === 'draining' ? value : null;
  });
  const heldFrom = Date.now();
  await delay(Number(hold)); // Exceeds forced shutdown; recovery also crosses the journal heartbeat.
  const stillOwned = await status();
  assert.equal(stillOwned.incarnation, retiring.incarnation);
  assert.notEqual(stillOwned.state, 'drained');
  assert.equal(runEvent('done'), undefined);
  const cursor = Math.max(...messages.map((e) => e.rivetSequence ?? 0));
  socket.terminate();
  const resumeFrom = messages.length;
  socket = await connect(ownerUrl.href, messages, [
    'rivet-session-v1',
    `rivet-cap.${session.data.capability}`,
    `rivet-seq.${cursor}`,
  ]);
  await waitFor('resumed original owner', () =>
    messages.slice(resumeFrom).find((e) => e.message === 'executor-session-ready' && e.data.resumed),
  );
  send(socket, 'run', { requestId, graphId: 'main' }); // A duplicate must not execute again.
  send(socket, 'run', { requestId: `${requestId}-rejected`, graphId: 'main' });
  await waitFor('new-run fence', () =>
    messages.find((e) => e.requestId === `${requestId}-rejected` && e.message === 'error'),
  );
  send(socket, 'user-input', { requestId, nodeId: input.id, answers: { type: 'string[]', value: ['preserved'] } });
  send(socket, 'resume', { requestId });
  const done = await waitFor('resumed editor completion', () => runEvent('done'));
  assert.deepEqual(done.data.results.result, { type: 'string[]', value: ['preserved'] });
  assert.equal(messages.filter((e) => e.requestId === requestId && e.message === 'start').length, 1);
  assert.equal(messages.filter((e) => e.requestId === requestId && e.message === 'done').length, 1);
  assert.equal(runEvent('abort'), undefined);
  const receipt = {
    phase: 'passed',
    pod: process.env.RIVET_POD_NAME,
    neighbor,
    heldMs: Date.now() - heldFrom,
    editorResumed: true,
    starts: 1,
    completions: 1,
    latestMesh: true,
    latestPauseCount: 1,
  };
  await fs.writeFile(marker, JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
} finally {
  sockets.forEach((socket) => socket.terminate());
}
