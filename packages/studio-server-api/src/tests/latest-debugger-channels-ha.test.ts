import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { GraphProcessor, LatestDebuggerScope } from '@valerypopoff/rivet2-core';
import { startDebuggerServer } from '@valerypopoff/rivet2-node';
import { LatestDebuggerRelay } from '../ha-latest-relay.js';
import { LatestDebuggerPolicy } from '../latest-debugger-policy.js';

void test('managed HA replay filters channels and forwards controls only to the exact owner', async (t) => {
  const servers = [createServer(), createServer()];
  const sockets = servers.map(() => new WebSocketServer({ noServer: true }));
  const clients: WebSocket[] = [],
    relays: LatestDebuggerRelay[] = [];
  const ports: number[] = [];
  const calls: string[] = [];
  const faults = new EventEmitter();
  const reports: string[] = [];
  let reportThrows = false;
  let dropAcknowledgements = false;
  let corruptAcknowledgement: 'command' | 'status' | 'reason' | undefined;
  const inboundPeers: WebSocket[] = [];
  const outboundPeers = new Map<number, WebSocket>();
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'HA channel fixture timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    for (const server of servers) {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      ports.push((server.address() as { port: number }).port);
    }
    const debuggers = servers.map((server, i) => {
      const incarnation = randomUUID();
      const policy = new LatestDebuggerPolicy(`backend-${i}`, incarnation);
      const relay = new LatestDebuggerRelay(
        {
          pod: `backend-${i}`,
          incarnation,
          backendName: 'backend',
          headless: 'unused',
          apiPort: ports[i]!,
          executorPort: 1,
          installation: 'fixture',
          key: 'k'.repeat(32),
        },
        sockets[i]!,
        2,
        (url, options) => {
          const peer = new WebSocket(
            `ws://127.0.0.1:${ports[Number(/backend-(\d)/.exec(url)![1])]}/internal/ha/latest`,
            options,
          );
          outboundPeers.set(i, peer);
          return peer;
        },
        (input, channel) => policy.control(input, channel),
        (reason) => {
          reports.push(reason);
          if (reportThrows) throw new Error('Telemetry sink failed');
        },
      );
      relays.push(relay);
      sockets[i]!.on('connection', (client, request) => {
        if (request.url !== '/internal/ha/latest') return;
        inboundPeers.push(client);
        const send = client.send.bind(client);
        client.send = ((...args: Parameters<WebSocket['send']>) => {
          const frame = JSON.parse(args[0].toString());
          if (frame.rivetEventId) {
            const { rivetEventId, ...rest } = frame;
            // Exercise real peer transport, not just an isolated JSON helper.
            args[0] = JSON.stringify({ ...rest, rivetEventId });
          }
          if (corruptAcknowledgement && frame.message === 'latest-control-result') {
            if (corruptAcknowledgement === 'command') frame.data.commandId = 'another-command';
            if (corruptAcknowledgement === 'status') frame.data.status = 'invented-status';
            if (corruptAcknowledgement === 'reason') frame.data.reason = { invalid: true };
            args[0] = JSON.stringify(frame);
          }
          if (dropAcknowledgements && JSON.parse(args[0].toString()).message === 'latest-control-result') {
            const complete = typeof args[1] === 'function' ? args[1] : args[2];
            complete?.();
            faults.emit('acknowledgement-dropped');
            return;
          }
          send(...args);
        }) as WebSocket['send'];
      });
      server.on('upgrade', (req, socket, head) => {
        if (req.url === '/internal/ha/latest' && !relay.authorize(req)) {
          socket.destroy();
          return;
        }
        sockets[i]!.handleUpgrade(req, socket, head, (client) => sockets[i]!.emit('connection', client, req));
      });
      const debuggerServer = startDebuggerServer({
        server: sockets[i]! as NonNullable<Parameters<typeof startDebuggerServer>[0]>['server'],
        heartbeatIntervalMs: 0,
        interceptMessage: relay.interceptMessage,
        transformBroadcast: (payload, processor, message, data) => {
          const scoped = policy.decorate(payload, processor, message, data);
          return scoped ? relay.transformBroadcast(scoped) : '';
        },
        sendBroadcast: relay.sendBroadcast,
      });
      return { policy, debuggerServer };
    });
    await until(() => relays.every((relay) => relay.ready));
    const received: Array<
      Array<{
        message: string;
        rivetScope?: LatestDebuggerScope;
        data?: { status?: string; commandId?: string; code?: string; promptId?: string };
      }>
    > = [[], []];
    for (const [i, channel] of ['A', 'B'].entries()) {
      const client = new WebSocket(`ws://127.0.0.1:${ports[1]}/ws/latest-debugger@${channel}`);
      clients.push(client);
      client.on('message', (raw) => received[i]!.push(JSON.parse(raw.toString())));
      await once(client, 'open');
    }
    const processorEvents: EventEmitter[] = [];
    const processors = ['A', 'B'].map((channel) => {
      const events = new EventEmitter();
      processorEvents.push(events);
      const processor = {
        id: channel,
        on(event: string, handler: (...args: unknown[]) => void) {
          events.on(event, handler);
          return () => events.off(event, handler);
        },
        pause() {
          calls.push(channel);
        },
        resume() {
          calls.push(`${channel}:resume`);
        },
      } as unknown as GraphProcessor;
      debuggers[0]!.policy.forChannel(debuggers[0]!.debuggerServer, channel).attach(processor);
      events.emit('start', {
        project: { metadata: { id: 'same-project' } },
        execution: { rootRunId: channel, projectId: 'same-project', graphRunId: channel },
      });
      return processor;
    });
    await until(() => received.every((messages) => messages.some((message) => message.message === 'start')));
    const target = received[0]!.find((message) => message.message === 'start')!.rivetScope;
    clients[0]!.send(JSON.stringify({ type: 'latest-control', data: { commandId: 'valid', target, action: 'pause' } }));
    await until(() => received[0]!.some((message) => message.message === 'latest-control-result'));
    assert.equal(received[0]!.find((message) => message.message === 'latest-control-result')!.data!.status, 'accepted');
    clients[1]!.send(
      JSON.stringify({ type: 'latest-control', data: { commandId: 'foreign', target, action: 'pause' } }),
    );
    await until(() => received[1]!.some((message) => message.message === 'latest-control-result'));
    assert.equal(received[1]!.find((message) => message.message === 'latest-control-result')!.data!.status, 'rejected');
    assert.deepEqual(calls, ['A']);
    assert.ok(reports.includes('ownership'), 'cross-channel rejection is observable without payloads');
    reportThrows = true;
    clients[0]!.send(
      JSON.stringify({
        type: 'latest-control',
        data: {
          commandId: 'stale-owner',
          target: { ...target, incarnation: randomUUID() },
          action: 'resume',
        },
      }),
    );
    await until(() => received[0]!.some((event) => event.data?.commandId === 'stale-owner'));
    assert.equal(received[0]!.find((event) => event.data?.commandId === 'stale-owner')!.data!.status, 'rejected');
    assert.deepEqual(calls, ['A'], 'stale-incarnation controls cannot affect the current owner');
    reportThrows = false;
    // The peer can be authentic while an acknowledgement is contradictory or
    // malformed. Keep that command unknown rather than invent a valid reply.
    for (const [index, fault] of (['command', 'status', 'reason'] as const).entries()) {
      corruptAcknowledgement = fault;
      const commandId = `corrupt-${fault}`;
      const incoming = once(outboundPeers.get(1)!, 'message');
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        clients[0]!.send(
          JSON.stringify({
            type: 'latest-control',
            data: { commandId, target, action: index % 2 === 0 ? 'resume' : 'pause' },
          }),
        );
        const [raw] = await incoming;
        assert.equal(JSON.parse(raw.toString()).message, 'latest-control-result');
        // The peer message event completes all relay listeners before this
        // continuation advances only the pending acknowledgement deadline.
        t.mock.timers.tick(10_001);
      } finally {
        t.mock.timers.reset();
        corruptAcknowledgement = undefined;
      }
      await until(() => received[0]!.some((event) => event.data?.commandId === commandId));
      assert.equal(received[0]!.find((event) => event.data?.commandId === commandId)!.data!.status, 'outcome-unknown');
    }
    assert.deepEqual(calls, ['A', 'A:resume', 'A', 'A:resume']);
    // Drop a real peer reply after the owner has applied the command. Advancing
    // only the acknowledgement timer proves uncertainty without a ten-second sleep.
    dropAcknowledgements = true;
    reportThrows = true;
    const dropped = once(faults, 'acknowledgement-dropped');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      clients[0]!.send(
        JSON.stringify({ type: 'latest-control', data: { commandId: 'lost-ack', target, action: 'pause' } }),
      );
      await dropped;
      assert.deepEqual(calls, ['A', 'A:resume', 'A', 'A:resume', 'A']);
      t.mock.timers.tick(10_001);
    } finally {
      t.mock.timers.reset();
      dropAcknowledgements = false;
      reportThrows = false;
    }
    await until(() => received[0]!.some((event) => event.data?.commandId === 'lost-ack'));
    assert.equal(received[0]!.find((event) => event.data?.commandId === 'lost-ack')!.data!.status, 'outcome-unknown');
    assert.ok(reports.includes('unavailable'), 'lost acknowledgements are observable even when reporting throws');
    assert.ok(reports.every((reason) => ['ownership', 'history', 'unavailable'].includes(reason)));
    const previousConnections = inboundPeers.length;
    for (const peer of inboundPeers) peer.terminate();
    await until(() => inboundPeers.length >= previousConnections + 2 && relays.every((relay) => relay.ready));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls,
      ['A', 'A:resume', 'A', 'A:resume', 'A'],
      'peer recovery must not replay an uncertain command',
    );
    processorEvents[0]!.emit('userInput', {
      execution: { projectId: 'same-project', rootRunId: 'A', graphRunId: 'A' },
      processId: 'prompt-process',
      callback: () => calls.push('A:answer'),
    });
    await until(() => received[0]!.some((event) => event.message === 'userInput'));
    const prompt = received[0]!.find((event) => event.message === 'userInput')!.rivetScope!;
    assert.equal(prompt.promptLifecycle, 1, 'capability belongs to the execution owner, not the relay');
    clients[0]!.send(
      JSON.stringify({
        type: 'latest-control',
        data: {
          commandId: 'prompt-answer',
          target,
          action: 'user-input',
          promptId: prompt.promptId,
          answers: { type: 'string[]', value: ['private answer'] },
        },
      }),
    );
    await until(() => received[0]!.some((event) => event.data?.commandId === 'prompt-answer'));
    const closure = received[0]!.find((event) => event.message === 'latest-prompt-closed')!;
    assert.deepEqual(closure.rivetScope, target);
    assert.deepEqual(closure.data, { promptId: prompt.promptId }, 'closure must not expose answers or callbacks');
    assert.deepEqual(calls, ['A', 'A:resume', 'A', 'A:resume', 'A', 'A:answer']);
    // Compaction must preserve channel and root provenance, not leak a large
    // terminal to the other channel or lose the next terminal in the stream.
    debuggers[0]!.debuggerServer.broadcast(processors[0]!, 'done', {
      execution: { projectId: 'same-project', rootRunId: 'A', graphRunId: 'A' },
      results: { padding: { type: 'string', value: 'x'.repeat(33 * 1024 * 1024) } },
    });
    debuggers[0]!.debuggerServer.broadcast(processors[0]!, 'latest-settled', {});
    await until(() => received[0]!.some((event) => event.message === 'latest-settled'));
    const terminal = received[0]!.find((event) => event.message === 'done')!;
    assert.deepEqual(terminal.rivetScope, target);
    assert.ok(Buffer.byteLength(JSON.stringify(terminal)) < 4096);
    const late = new WebSocket(`ws://127.0.0.1:${ports[1]}/ws/latest-debugger@A`);
    const replay: (typeof received)[number] = [];
    clients.push(late);
    late.on('message', (raw) => replay.push(JSON.parse(raw.toString())));
    await once(late, 'open');
    await until(() => replay.some((event) => event.message === 'latest-settled'));
    assert.deepEqual(replay.find((event) => event.message === 'done')!.rivetScope, target);
    assert.deepEqual(
      replay.find((event) => event.message === 'latest-prompt-closed'),
      closure,
    );
    assert.ok(replay.every((event) => !event.rivetScope || event.rivetScope.channel === 'A'));
    received.forEach((messages, i) =>
      assert.ok(messages.every((message) => !message.rivetScope || message.rivetScope.channel === ['A', 'B'][i])),
    );
    for (const processor of processors)
      debuggers[0]!.policy.forChannel(debuggers[0]!.debuggerServer, null).detach(processor);
  } finally {
    t.mock.timers.reset();
    clients.forEach((client) => client.terminate());
    relays.forEach((relay) => relay.dispose());
    for (const socket of sockets) {
      for (const client of socket.clients) client.terminate();
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
