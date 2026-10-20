import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { type WebSocketServer } from 'ws';
import { WarningsPort } from '@valerypopoff/rivet2-core';
import type { OwnerRoutingConfig } from './ha-owner-routing.js';

const HISTORY_BYTES = 32 * 1024 * 1024;
const HISTORY_EVENTS = 8192;
const SEND_TIMEOUT_MS = 60_000;
const TERMINALS = new Set([
  'done',
  'error',
  'abort',
  'nodeFinish',
  'nodeError',
  'nodeExcluded',
  'graphFinish',
  'graphError',
  'graphAbort',
]);
type Diagnostic = 'history-truncated' | 'history-gap' | 'event-too-large' | 'owner-unavailable';
type RetainedEvent = { index: number; origin: string; sequence: number; payload: string; bytes: number };

/** Keep a terminal's identity/outcome when its values cannot fit the diagnostic
 * ring. Dropping it would strand a live run in the editor. Never invent results. */
function compactOversizedTerminal(payload: string, eventId: string): string | undefined {
  try {
    const envelope = JSON.parse(payload);
    if (!TERMINALS.has(envelope.message)) return undefined;
    const data = envelope.data ?? {};
    const warning = 'Remote Debugger omitted oversized diagnostic values. The workflow outcome is preserved.';
    const compact: Record<string, unknown> = {};
    const execution = data.execution;
    if (execution && typeof execution === 'object') {
      // Preserve complete normal provenance, including executor/evaluation
      // metadata; pathological metadata still cannot bypass the size bound.
      compact.execution =
        Buffer.byteLength(JSON.stringify(execution)) <= 16 * 1024
          ? execution
          : Object.fromEntries(
              ['rootRunId', 'graphRunId', 'graphId', 'projectId', 'projectScope', 'parentGraphRunId'].flatMap((key) =>
                typeof execution[key] === 'string' && execution[key].length <= 1024 ? [[key, execution[key]]] : [],
              ),
            );
    }
    const warningOutputs = { [WarningsPort]: { type: 'string[]', value: [warning] } };
    if (envelope.message.startsWith('node')) {
      const node = data.node;
      if (!node || typeof node.id !== 'string' || node.id.length > 1024) return undefined;
      compact.node =
        Buffer.byteLength(JSON.stringify(node)) <= 16 * 1024
          ? node
          : {
              id: node.id,
              type: typeof node.type === 'string' ? node.type.slice(0, 128) : '',
              data: {},
              visualData: { x: 0, y: 0 },
            };
      if (typeof data.processId === 'string' && data.processId.length <= 1024) compact.processId = data.processId;
      for (const key of ['durationMs', 'eventOccurredAt', 'replayRecordedAt'])
        if (typeof data[key] === 'number' && Number.isFinite(data[key])) compact[key] = data[key];
      if (data.streamingWatchTerminal === true) compact.streamingWatchTerminal = true;
      if (typeof data.resultOrigin === 'string' && data.resultOrigin.length <= 128)
        compact.resultOrigin = data.resultOrigin;
    }
    if (envelope.message.startsWith('graph')) {
      const graph = data.graph;
      if (!graph?.metadata || typeof graph.metadata.id !== 'string' || graph.metadata.id.length > 1024)
        return undefined;
      compact.graph =
        Buffer.byteLength(JSON.stringify(graph)) <= 16 * 1024
          ? graph
          : {
              metadata: { id: graph.metadata.id },
              nodes: [],
              connections: [],
            };
    }
    if (envelope.message === 'done') compact.results = warningOutputs;
    else if (envelope.message === 'nodeFinish' || envelope.message === 'graphFinish') compact.outputs = warningOutputs;
    else if (envelope.message === 'nodeExcluded') {
      compact.inputs = {};
      compact.outputs = warningOutputs;
      compact.reason = typeof data.reason === 'string' ? data.reason.slice(0, 4096) : warning;
    } else {
      if (envelope.message === 'abort' || envelope.message === 'graphAbort')
        compact.successful = data.successful === true;
      if (data.error != null || compact.successful !== true)
        compact.error = `${typeof data.error === 'string' ? data.error.slice(0, 4096) + '\n' : ''}${warning}`;
    }
    return JSON.stringify({
      rivetEventId: eventId,
      message: envelope.message,
      ...(typeof envelope.requestId === 'string' && envelope.requestId.length <= 1024
        ? { requestId: envelope.requestId }
        : {}),
      data: compact,
    });
  } catch {
    return undefined;
  }
}
type Writer = {
  cursor: number;
  history: boolean;
  peer: boolean;
  after: number;
  sending: boolean;
  prefix: string[];
  prefixBytes: number;
  diagnostics: Set<Diagnostic>;
  onWritten?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  wake?: ReturnType<typeof setImmediate>;
};

/** Observers are relayed; processors, cancellation and persistence stay on their original owners. */
export class LatestDebuggerRelay {
  #inbound = new WeakSet<WebSocket>();
  #outbound = new Map<string, WebSocket>();
  #writers = new Map<WebSocket, Writer>();
  #events: RetainedEvent[] = [];
  #seenPeers = new Set<string>();
  #peerCursors = new Map<string, { incarnation: string; sequence: number }>();
  #bytes = 0;
  #index = 0;
  #sequence = 0;
  #truncated = false;
  #closed = false;
  #timer: ReturnType<typeof setInterval>;
  readonly #origin: string;
  constructor(
    private readonly config: OwnerRoutingConfig,
    private readonly server: WebSocketServer,
    private readonly peerLimit: number,
    private readonly connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (url, options) =>
      new WebSocket(url, options),
  ) {
    if (!Number.isInteger(peerLimit) || peerLimit < 2 || peerLimit > 33) throw new Error('Invalid HA peer bound');
    this.#origin = `${config.pod}:${config.incarnation}`;
    server.prependListener('connection', this.#connection);
    this.#timer = setInterval(() => this.#connect(), 1000);
    this.#timer.unref();
    this.#connect();
  }
  #token(pod: string, incarnation: string): string {
    return createHmac('sha256', this.config.key)
      .update(JSON.stringify(['rivet-latest-peer-v1', this.config.installation, pod, incarnation]))
      .digest('hex');
  }
  authorize(request: IncomingMessage): boolean {
    if (request.headers.origin !== undefined) return false;
    const pod = request.headers['x-rivet-ha-pod'],
      incarnation = request.headers['x-rivet-ha-incarnation'],
      token = request.headers['x-rivet-ha-peer'];
    if (
      typeof pod !== 'string' ||
      typeof incarnation !== 'string' ||
      typeof token !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(incarnation) ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !Array.from({ length: this.peerLimit }, (_, i) => `${this.config.backendName}-${i}`).includes(pod) ||
      pod === this.config.pod
    )
      return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.#token(pod, incarnation)));
  }
  #remember(origin: string, sequence: number, payload: string): string | undefined {
    let bytes = Buffer.byteLength(payload);
    if (bytes > HISTORY_BYTES) {
      this.#truncated = true;
      this.#notify('event-too-large');
      const terminal = compactOversizedTerminal(payload, `${origin}:${sequence}`);
      if (!terminal) return undefined;
      payload = terminal;
      bytes = Buffer.byteLength(payload);
    }
    this.#events.push({ index: ++this.#index, origin, sequence, payload, bytes });
    this.#bytes += bytes;
    while (this.#bytes > HISTORY_BYTES || this.#events.length > HISTORY_EVENTS) {
      const removed = this.#events.shift()!;
      this.#bytes -= removed.bytes;
      this.#truncated = true;
    }
    return payload;
  }
  #writer(client: WebSocket, history = false, peer = false, after = 0): Writer {
    const existing = this.#writers.get(client);
    if (existing) return existing;
    const writer: Writer = {
      cursor: (this.#events[0]?.index ?? this.#index + 1) - 1,
      history,
      peer,
      after,
      sending: false,
      prefix: [],
      prefixBytes: 0,
      diagnostics: new Set(),
    };
    this.#writers.set(client, writer);
    const onError = () => {
      this.#forget(client, writer);
      client.terminate();
    };
    client.on('error', onError);
    client.once('close', () => {
      this.#forget(client, writer);
      client.off('error', onError);
    });
    return writer;
  }
  #forget(client: WebSocket, writer: Writer): void {
    if (this.#writers.get(client) !== writer) return;
    this.#writers.delete(client);
    clearTimeout(writer.timeout);
    clearImmediate(writer.wake);
    writer.prefix = [];
    writer.prefixBytes = 0;
    writer.onWritten = undefined;
  }
  #send(client: WebSocket, payload: string): void {
    if (this.#closed || client.readyState !== WebSocket.OPEN) return;
    const writer = this.#writer(client),
      bytes = Buffer.byteLength(payload);
    if (writer.prefixBytes + bytes > HISTORY_BYTES || writer.prefix.length >= HISTORY_EVENTS) {
      this.#forget(client, writer);
      client.terminate();
      return;
    }
    writer.prefix.push(payload);
    writer.prefixBytes += bytes;
    this.#pump(client, writer);
  }
  #diagnostic(client: WebSocket, code: Diagnostic): void {
    const writer = this.#writers.get(client);
    if (!writer || writer.peer || writer.diagnostics.has(code)) return;
    writer.diagnostics.add(code);
    this.#send(client, JSON.stringify({ message: 'latest-diagnostic', data: { protocol: 1, code } }));
  }
  #notify(code: Diagnostic): void {
    for (const client of this.server.clients) if (!this.#inbound.has(client)) this.#diagnostic(client, code);
  }
  #pump(client: WebSocket, writer: Writer): void {
    if (this.#closed || this.#writers.get(client) !== writer || writer.sending || client.readyState !== WebSocket.OPEN)
      return;
    const first = this.#events[0];
    if (writer.history && first && writer.cursor < first.index - 1) {
      writer.cursor = first.index - 1;
      // Slow observers catch up to the ring, without unbounded private queues.
      this.#diagnostic(client, 'history-gap');
      if (writer.sending) return;
    }
    let payload = writer.prefix.shift();
    if (payload !== undefined) writer.prefixBytes -= Buffer.byteLength(payload);
    let nextIndex: number | undefined;
    if (payload === undefined && writer.history && first) {
      const offset = Math.max(0, writer.cursor - first.index + 1);
      for (let i = offset; i < this.#events.length; i++) {
        const event = this.#events[i]!;
        if (writer.peer && (event.origin !== this.#origin || event.sequence <= writer.after)) {
          writer.cursor = event.index;
          continue;
        }
        payload = event.payload;
        nextIndex = event.index;
        break;
      }
    }
    if (payload === undefined) return;
    writer.sending = true;
    writer.timeout = setTimeout(() => {
      this.#forget(client, writer);
      client.terminate();
    }, SEND_TIMEOUT_MS);
    writer.timeout.unref();
    try {
      // One write in flight: retained history cannot overflow its own socket queue.
      client.send(payload, (error) => {
        clearTimeout(writer.timeout);
        if (this.#writers.get(client) !== writer) return;
        writer.sending = false;
        if (error) {
          this.#forget(client, writer);
          client.terminate();
          return;
        }
        if (nextIndex !== undefined) writer.cursor = nextIndex;
        writer.onWritten?.();
        writer.wake = setImmediate(() => {
          writer.wake = undefined;
          this.#pump(client, writer);
        });
        writer.wake.unref();
      });
    } catch {
      this.#forget(client, writer);
      client.terminate();
    }
  }
  #connection = (client: WebSocket, request: IncomingMessage) => {
    if (this.#closed) {
      client.terminate();
      return;
    }
    const peer = new URL(request.url ?? '/', 'http://localhost').pathname === '/internal/ha/latest';
    if (peer) this.#inbound.add(client);
    // Optional hint: old peers ignore it. Never trust a different incarnation.
    const after = request.headers['x-rivet-ha-after'];
    const match = typeof after === 'string' && /^([a-f0-9-]{36}):(\d{1,16})$/.exec(after);
    const sequence = match && match[1] === this.config.incarnation ? Number(match[2]) : 0;
    const writer = this.#writer(
      client,
      true,
      peer,
      peer && Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= this.#sequence ? sequence : 0,
    );
    if (!peer) {
      this.#send(client, JSON.stringify({ message: 'latest-session', data: { protocol: 1 } }));
      if (this.#truncated) this.#diagnostic(client, 'history-truncated');
    }
    this.#pump(client, writer);
  };
  transformBroadcast = (payload: string): string => {
    if (this.#closed) return '';
    const sequence = ++this.#sequence;
    const id = `${this.#origin}:${sequence}`;
    const encoded = `{"rivetEventId":${JSON.stringify(id)},${payload.slice(1)}`;
    return this.#remember(this.#origin, sequence, encoded) ?? '';
  };
  /** The live path must share the replay cursor, never overtake retained history. */
  sendBroadcast = (client: WebSocket, _payload: string, onWritten?: () => void): void => {
    const writer = this.#writers.get(client);
    if (writer) {
      if (onWritten) writer.onWritten = onWritten;
      this.#pump(client, writer);
    }
  };
  onControl = (client: WebSocket, payload: string): void => {
    if (this.#inbound.has(client)) return; // A control traverses each owner at most once.
    const unavailable = [...this.#seenPeers].some((pod) => this.#outbound.get(pod)?.readyState !== WebSocket.OPEN);
    for (const [pod, peer] of this.#outbound) {
      if (peer.readyState === WebSocket.OPEN) this.#send(peer, payload);
    }
    if (unavailable) this.#diagnostic(client, 'owner-unavailable');
  };
  #connect(): void {
    if (this.#closed) return;
    for (let index = 0; index < this.peerLimit; index++) {
      const pod = `${this.config.backendName}-${index}`;
      if (pod === this.config.pod || this.#outbound.has(pod)) continue;
      const cursor = this.#peerCursors.get(pod);
      const socket = this.connect(`ws://${pod}.${this.config.headless}:${this.config.apiPort}/internal/ha/latest`, {
        handshakeTimeout: 3000,
        maxPayload: HISTORY_BYTES,
        headers: {
          'x-rivet-ha-pod': this.config.pod,
          'x-rivet-ha-incarnation': this.config.incarnation,
          'x-rivet-ha-peer': this.#token(this.config.pod, this.config.incarnation),
          ...(cursor ? { 'x-rivet-ha-after': `${cursor.incarnation}:${cursor.sequence}` } : {}),
        },
      });
      this.#outbound.set(pod, socket);
      socket.once('open', () => this.#seenPeers.add(pod));
      socket.on('error', () => {});
      socket.once('close', () => {
        if (this.#outbound.get(pod) === socket) this.#outbound.delete(pod);
      });
      let streamIncarnation: string | undefined;
      socket.on('message', (data) => {
        if (this.#closed || this.#outbound.get(pod) !== socket) return;
        const payload = data.toString();
        const id = /^\{"rivetEventId":"([a-z0-9:-]{1,200})",/.exec(payload)?.[1];
        if (!id?.startsWith(`${pod}:`)) {
          socket.terminate();
          return;
        }
        const [, incarnation, sequenceText] = id.split(':');
        const sequence = Number(sequenceText);
        if (
          !incarnation ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          (streamIncarnation && streamIncarnation !== incarnation)
        ) {
          socket.terminate();
          return;
        }
        streamIncarnation = incarnation;
        const cursor = this.#peerCursors.get(pod);
        if (cursor?.incarnation === incarnation && sequence <= cursor.sequence) return;
        if (sequence !== (cursor?.incarnation === incarnation ? cursor.sequence + 1 : 1)) {
          this.#truncated = true;
          this.#notify('history-gap');
        }
        this.#peerCursors.set(pod, { incarnation, sequence });
        this.#remember(`${pod}:${incarnation}`, sequence, payload);
        for (const observer of this.server.clients)
          if (!this.#inbound.has(observer)) this.sendBroadcast(observer, payload);
      });
    }
  }
  get ready(): boolean {
    // The deliberate singleton has no ordinary neighbour. Its local debugger
    // still records/replays normally; missing potential surge ordinals are not
    // required dependencies. Replicated control keeps its peer-ready gate.
    return (
      !this.#closed &&
      (process.env.RIVET_HA_CONTROL_PLANE_MODE === 'singleton' ||
        [...this.#outbound.values()].some((socket) => socket.readyState === WebSocket.OPEN))
    );
  }
  dispose(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.server.off('connection', this.#connection);
    for (const [client, writer] of this.#writers) this.#forget(client, writer);
    for (const socket of this.#outbound.values()) socket.terminate();
    this.#outbound.clear();
    this.#events = [];
    this.#peerCursors.clear();
    this.#bytes = 0;
  }
}
