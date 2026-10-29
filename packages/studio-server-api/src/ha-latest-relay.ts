import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { type WebSocketServer } from 'ws';
import type { OwnerRoutingConfig } from './ha-owner-routing.js';
import type { LatestControlResult } from './latest-debugger-policy.js';
import {
  WarningsPort,
  isLatestDebuggerScope,
  parseLatestDebuggerPath,
  type LatestDebuggerChannel,
  readLatestDebuggerControl,
  isLatestDebuggerControlResult,
  readLatestDebuggerEventId,
  encodeLatestDebuggerEnvelope,
  createLatestDebuggerSession,
  createLatestDebuggerDiagnostic,
  createLatestDebuggerControlResult,
  type LatestDebuggerDiagnosticCode,
} from '@valerypopoff/rivet2-core';

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
type Diagnostic = LatestDebuggerDiagnosticCode;
type RetainedEvent = {
  index: number;
  origin: string;
  sequence: number;
  payload: string;
  bytes: number;
  channel?: LatestDebuggerChannel;
};

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
      ...(isLatestDebuggerScope(envelope.rivetScope) ? { rivetScope: envelope.rivetScope } : {}),
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
  channel?: LatestDebuggerChannel;
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
  #protocolPeers = new Set<string>();
  #pendingControls = new Map<
    string,
    { client: WebSocket; commandId: string; timer: ReturnType<typeof setTimeout>; peer: WebSocket }
  >();
  #timer: ReturnType<typeof setInterval>;
  readonly #origin: string;
  constructor(
    private readonly config: OwnerRoutingConfig,
    private readonly server: WebSocketServer,
    private readonly peerLimit: number,
    private readonly connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (url, options) =>
      new WebSocket(url, options),
    private readonly managedControl?: (input: unknown, channel: LatestDebuggerChannel) => LatestControlResult,
    private readonly report: (reason: 'ownership' | 'history' | 'unavailable') => void = () => {},
  ) {
    if (!Number.isInteger(peerLimit) || (peerLimit !== 0 && peerLimit < 2) || peerLimit > 33)
      throw new Error('Invalid HA peer bound');
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
    // An old peer would forward all channels to its unfiltered browsers.
    // Do not send managed history to a peer without explicit v2 support.
    if (this.managedControl && request.headers['x-rivet-latest-protocol'] !== '2') return false;
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
  #remember(origin: string, sequence: number, payload: string, decoded?: { rivetScope?: unknown }): string | undefined {
    let bytes = Buffer.byteLength(payload);
    if (bytes > HISTORY_BYTES) {
      this.#truncated = true;
      this.#notify('event-too-large');
      const terminal = compactOversizedTerminal(payload, `${origin}:${sequence}`);
      if (!terminal) return undefined;
      payload = terminal;
      bytes = Buffer.byteLength(payload);
    }
    let channel: LatestDebuggerChannel | undefined;
    if (this.managedControl) {
      try {
        const scope = decoded ? decoded.rivetScope : JSON.parse(payload).rivetScope;
        if (isLatestDebuggerScope(scope) && `${scope.owner}:${scope.incarnation}` === origin) channel = scope.channel;
        else return undefined;
      } catch {
        return undefined;
      }
    }
    this.#events.push({ index: ++this.#index, origin, sequence, payload, bytes, channel });
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
  #report(reason: 'ownership' | 'history' | 'unavailable'): void {
    try {
      this.report(reason);
    } catch {
      /* observational */
    }
  }
  #diagnostic(client: WebSocket, code: Diagnostic): void {
    const writer = this.#writers.get(client);
    if (!writer || writer.peer) return;
    this.#report(code === 'owner-unavailable' ? 'unavailable' : 'history');
    // Availability warnings may be deduplicated, but each new loss must
    // invalidate fresh prompt proof established since the previous loss.
    if (code === 'owner-unavailable') {
      if (writer.diagnostics.has(code)) return;
      writer.diagnostics.add(code);
    }
    this.#send(client, JSON.stringify(createLatestDebuggerDiagnostic(code)));
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
        if (!writer.peer && this.managedControl) {
          if (event.channel === undefined || event.channel !== writer.channel) {
            writer.cursor = event.index;
            continue;
          }
        }
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
      if (this.managedControl)
        writer.channel = parseLatestDebuggerPath(new URL(request.url ?? '/', 'http://localhost').pathname);
      this.#send(
        client,
        JSON.stringify(
          this.managedControl
            ? createLatestDebuggerSession(writer.channel!)
            : { message: 'latest-session', data: { protocol: 1 } },
        ),
      );
      if (this.#truncated) this.#diagnostic(client, 'history-truncated');
    }
    if (peer && this.managedControl)
      this.#send(
        client,
        JSON.stringify({
          message: 'latest-peer',
          data: { protocol: 2, owner: this.config.pod, incarnation: this.config.incarnation },
        }),
      );
    this.#pump(client, writer);
  };
  transformBroadcast = (payload: string): string => {
    if (this.#closed) return '';
    const sequence = ++this.#sequence;
    const id = `${this.#origin}:${sequence}`;
    const encoded = encodeLatestDebuggerEnvelope(payload, undefined, id);
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
  /** Consumes every browser frame in managed mode; no legacy fan-out is reachable. */
  interceptMessage = (client: WebSocket, payload: string): boolean => {
    if (!this.managedControl) return false;
    let frame: { type?: string; data?: Record<string, unknown> };
    try {
      frame = JSON.parse(payload);
    } catch {
      this.#report('ownership');
      return true;
    }
    const data = frame?.data;
    const commandId = typeof data?.commandId === 'string' && data.commandId.length <= 200 ? data.commandId : '';
    const reply = (result: LatestControlResult, failure?: 'ownership' | 'unavailable') => {
      if (result.status !== 'accepted')
        this.#report(failure ?? (result.status === 'outcome-unknown' ? 'unavailable' : 'ownership'));
      const response = createLatestDebuggerControlResult(commandId, result);
      this.#send(
        client,
        JSON.stringify({
          ...response,
          data: { ...response.data, ...(this.#inbound.has(client) ? { forwardId: data?.forwardId } : {}) },
        }),
      );
    };
    if (!readLatestDebuggerControl(frame) || !commandId || !isLatestDebuggerScope(data?.target)) {
      reply({ status: 'rejected', reason: 'Upgrade required: an exact latest execution target is mandatory' });
      return true;
    }
    const channel = this.#inbound.has(client) ? data.target.channel : this.#writers.get(client)?.channel;
    if (channel === undefined || channel !== data.target.channel) {
      reply({ status: 'rejected', reason: 'Execution channel does not match connection' });
      return true;
    }
    if (data.target.owner === this.config.pod) {
      try {
        reply(this.managedControl(data, channel));
      } catch {
        reply({ status: 'outcome-unknown', reason: 'Control failed; inspect runtime state before acting again' });
      }
      return true;
    }
    const peer = this.#outbound.get(data.target.owner);
    if (
      this.#inbound.has(client) ||
      !this.#protocolPeers.has(data.target.owner) ||
      peer?.readyState !== WebSocket.OPEN ||
      this.#pendingControls.size >= 256
    ) {
      reply(
        { status: 'rejected', reason: 'Execution owner is unavailable or does not support scoped controls' },
        'unavailable',
      );
      return true;
    }
    const forwardId = randomUUID();
    const timer = setTimeout(() => {
      this.#pendingControls.delete(forwardId);
      reply({ status: 'outcome-unknown', reason: 'Owner acknowledgement lost; command was not retried' });
    }, 10_000);
    timer.unref();
    this.#pendingControls.set(forwardId, { client, commandId, timer, peer });
    this.#send(peer, JSON.stringify({ type: 'latest-control', data: { ...data, forwardId } }));
    return true;
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
          ...(this.managedControl ? { 'x-rivet-latest-protocol': '2' } : {}),
          ...(cursor ? { 'x-rivet-ha-after': `${cursor.incarnation}:${cursor.sequence}` } : {}),
        },
      });
      this.#outbound.set(pod, socket);
      socket.once('open', () => this.#seenPeers.add(pod));
      socket.on('error', () => {});
      socket.once('close', () => {
        this.#protocolPeers.delete(pod);
        if (this.#outbound.get(pod) === socket) this.#outbound.delete(pod);
      });
      let streamIncarnation: string | undefined;
      let peerIncarnation: string | undefined;
      socket.on('message', (data) => {
        if (this.#closed || this.#outbound.get(pod) !== socket) return;
        const payload = data.toString();
        let decoded: { rivetEventId?: unknown; rivetScope?: unknown; message?: string; data?: Record<string, unknown> };
        try {
          decoded = JSON.parse(payload);
          if (!decoded || typeof decoded !== 'object') throw new Error('Invalid peer envelope');
        } catch {
          socket.terminate();
          return;
        }
        if (this.managedControl) {
          const control = decoded;
          if (control.message === 'latest-peer' && control.data?.protocol === 2) {
            if (
              control.data.owner !== pod ||
              typeof control.data.incarnation !== 'string' ||
              !/^[a-f0-9-]{36}$/.test(control.data.incarnation) ||
              (peerIncarnation && peerIncarnation !== control.data.incarnation)
            ) {
              socket.terminate();
              return;
            }
            peerIncarnation = control.data.incarnation;
            this.#protocolPeers.add(pod);
            return;
          }
          if (control.message === 'latest-control-result') {
            const id = control.data?.forwardId;
            const pending = typeof id === 'string' ? this.#pendingControls.get(id) : undefined;
            // An authentic peer/forwarding ID is not enough: malformed or
            // contradictory replies must leave the command's outcome unknown.
            if (
              pending?.peer === socket &&
              isLatestDebuggerControlResult(control) &&
              control.data.commandId === pending.commandId
            ) {
              clearTimeout(pending.timer);
              this.#pendingControls.delete(id as string);
              this.#send(
                pending.client,
                JSON.stringify(createLatestDebuggerControlResult(pending.commandId, control.data)),
              );
            } else if (pending?.peer === socket) this.#report('ownership');
            return;
          }
        }
        const id = readLatestDebuggerEventId(decoded);
        if (!id?.startsWith(`${pod}:`)) {
          socket.terminate();
          return;
        }
        const [, incarnation, sequenceText] = id.split(':');
        const sequence = Number(sequenceText);
        if (
          !incarnation ||
          (this.managedControl && incarnation !== peerIncarnation) ||
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
        this.#remember(`${pod}:${incarnation}`, sequence, payload, decoded);
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
      (this.peerLimit === 0 ||
        ['singleton', 'singleton-overlap'].includes(process.env.RIVET_HA_CONTROL_PLANE_MODE ?? '') ||
        [...this.#outbound.values()].some((socket) => socket.readyState === WebSocket.OPEN))
    );
  }
  dispose(): void {
    this.#closed = true;
    for (const pending of this.#pendingControls.values()) clearTimeout(pending.timer);
    this.#pendingControls.clear();
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
