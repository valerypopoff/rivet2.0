import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { type WebSocketServer } from 'ws';
import type { OwnerRoutingConfig } from './ha-owner-routing.js';

/** Observers are relayed; processors, cancellation and persistence stay on their original owners. */
export class LatestDebuggerRelay {
  #inbound = new WeakSet<WebSocket>();
  #outbound = new Map<string, WebSocket>();
  #events: { origin: string; payload: string; bytes: number }[] = [];
  #seenPeers = new Set<string>();
  #peerCursors = new Map<string, { incarnation: string; sequence: number }>();
  #bytes = 0;
  #sequence = 0;
  #truncated = false;
  #closed = false;
  #timer: ReturnType<typeof setInterval>;
  readonly #origin: string;
  constructor(private readonly config: OwnerRoutingConfig, private readonly server: WebSocketServer, private readonly peerLimit: number,
    private readonly connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options)) {
    if (!Number.isInteger(peerLimit) || peerLimit < 2 || peerLimit > 33) throw new Error('Invalid HA peer bound');
    this.#origin = `${config.pod}:${config.incarnation}`;
    server.prependListener('connection', this.#connection);
    this.#timer = setInterval(() => this.#connect(), 1000);
    this.#timer.unref(); this.#connect();
  }
  #token(pod: string, incarnation: string): string {
    return createHmac('sha256', this.config.key).update(JSON.stringify(['rivet-latest-peer-v1', this.config.installation, pod, incarnation])).digest('hex');
  }
  authorize(request: IncomingMessage): boolean {
    if (request.headers.origin !== undefined) return false;
    const pod = request.headers['x-rivet-ha-pod'], incarnation = request.headers['x-rivet-ha-incarnation'], token = request.headers['x-rivet-ha-peer'];
    if (typeof pod !== 'string' || typeof incarnation !== 'string' || typeof token !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(incarnation) || !/^[a-f0-9]{64}$/.test(token) ||
        !Array.from({ length: this.peerLimit }, (_, i) => `${this.config.backendName}-${i}`).includes(pod) || pod === this.config.pod) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.#token(pod, incarnation)));
  }
  #remember(origin: string, payload: string): void {
    const bytes = Buffer.byteLength(payload);
    this.#events.push({ origin, payload, bytes }); this.#bytes += bytes;
    while (this.#bytes > 32 * 1024 * 1024 || this.#events.length > 8192) {
      const removed = this.#events.shift()!; this.#bytes -= removed.bytes;
      this.#truncated = true;
    }
  }
  #send(client: WebSocket, payload: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 8 * 1024 * 1024) client.terminate(); else client.send(payload);
  }
  #connection = (client: WebSocket, request: IncomingMessage) => {
    const peer = request.url === '/internal/ha/latest';
    if (peer) this.#inbound.add(client);
    else this.#send(client, JSON.stringify({ message: 'latest-session', data: { protocol: 1 } }));
    if (!peer && this.#truncated) this.#send(client, JSON.stringify({ message: 'error', data: { error: 'Latest debugger history was truncated by its replay limit. Earlier diagnostics may be unavailable; executions were not replayed.' } }));
    for (const event of this.#events) {
      if (!peer || event.origin === this.#origin) this.#send(client, event.payload);
    }
  };
  transformBroadcast = (payload: string): string => {
    const id = `${this.#origin}:${++this.#sequence}`;
    const encoded = `{"rivetEventId":${JSON.stringify(id)},${payload.slice(1)}`;
    this.#remember(this.#origin, encoded); return encoded;
  };
  onControl = (client: WebSocket, payload: string): void => {
    if (this.#inbound.has(client)) return; // A control traverses each owner at most once.
    const unavailable = [...this.#seenPeers].some((pod) => this.#outbound.get(pod)?.readyState !== WebSocket.OPEN);
    for (const [pod, peer] of this.#outbound) {
      if (peer.readyState === WebSocket.OPEN) this.#send(peer, payload);
    }
    if (unavailable) this.#send(client, JSON.stringify({ message: 'error', data: { error: 'A debugger owner is unavailable. The control was not retried.' } }));
  };
  #connect(): void {
    if (this.#closed) return;
    for (let index = 0; index < this.peerLimit; index++) {
      const pod = `${this.config.backendName}-${index}`;
      if (pod === this.config.pod || this.#outbound.has(pod)) continue;
      const socket = this.connect(`ws://${pod}.${this.config.headless}:${this.config.apiPort}/internal/ha/latest`, {
        handshakeTimeout: 3000, maxPayload: 32 * 1024 * 1024,
        headers: { 'x-rivet-ha-pod': this.config.pod, 'x-rivet-ha-incarnation': this.config.incarnation,
          'x-rivet-ha-peer': this.#token(this.config.pod, this.config.incarnation) },
      });
      this.#outbound.set(pod, socket);
      socket.once('open', () => this.#seenPeers.add(pod));
      socket.on('error', () => {});
      socket.once('close', () => { if (this.#outbound.get(pod) === socket) this.#outbound.delete(pod); });
      let streamIncarnation: string | undefined;
      socket.on('message', (data) => {
        if (this.#outbound.get(pod) !== socket) return;
        const payload = data.toString();
        const id = /^\{"rivetEventId":"([a-z0-9:-]{1,200})",/.exec(payload)?.[1];
        if (!id?.startsWith(`${pod}:`)) { socket.terminate(); return; }
        const [, incarnation, sequenceText] = id.split(':');
        const sequence = Number(sequenceText);
        if (!incarnation || !Number.isSafeInteger(sequence) || sequence < 1 || (streamIncarnation && streamIncarnation !== incarnation)) { socket.terminate(); return; }
        streamIncarnation = incarnation;
        const cursor = this.#peerCursors.get(pod);
        if (cursor?.incarnation === incarnation && sequence <= cursor.sequence) return;
        if (sequence !== (cursor?.incarnation === incarnation ? cursor.sequence + 1 : 1)) {
          this.#truncated = true;
          const warning = JSON.stringify({ message: 'error', data: { error: 'Latest debugger history has a gap. Earlier diagnostics may be unavailable; executions were not replayed.' } });
          for (const observer of this.server.clients) if (!this.#inbound.has(observer)) this.#send(observer, warning);
        }
        this.#peerCursors.set(pod, { incarnation, sequence });
        this.#remember(pod, payload);
        for (const observer of this.server.clients) if (!this.#inbound.has(observer)) this.#send(observer, payload);
      });
    }
  }
  get ready(): boolean { return [...this.#outbound.values()].some((socket) => socket.readyState === WebSocket.OPEN); }
  dispose(): void {
    this.#closed = true; clearInterval(this.#timer); this.server.off('connection', this.#connection);
    for (const socket of this.#outbound.values()) socket.terminate(); this.#outbound.clear(); this.#events = []; this.#peerCursors.clear(); this.#bytes = 0;
  }
}
