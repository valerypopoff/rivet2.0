import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

type Session = {
  capability: string;
  logical: WebSocket;
  socket: WebSocket;
  sequence: number;
  events: { sequence: number; payload: string; bytes: number }[];
  bytes: number;
  retained: number;
  runs: Set<string>;
  disconnectedAt?: number;
};

/** One process owns its sessions. Reconnection changes an observer, never an execution. */
export class DebuggerSessions {
  #sessions = new Map<string, Session>();
  #clients = new WeakMap<WebSocket, Session>();
  #bytes = 0;
  #retiring = false;
  constructor(
    private readonly limits = { sessions: 64, bytes: 8 * 1024 * 1024, events: 8192, idleMs: 30 * 60_000 },
    private readonly now = Date.now,
    private readonly totalBytesLimit = 32 * 1024 * 1024,
  ) {
    if (![...Object.values(limits), totalBytesLimit].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error('Debugger session limits must be positive finite integers');
    this.limits = Object.freeze({ ...limits });
  }

  #resume(request: IncomingMessage): { capability: string; sequence: number } | undefined {
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((part) => part.trim());
    if (!protocols.includes('rivet-session-v1')) throw new Error('Debugger session protocol required');
    const capability = protocols.find((part) => part.startsWith('rivet-cap.'))?.slice(10);
    const sequenceText = protocols.find((part) => part.startsWith('rivet-seq.'))?.slice(10);
    if (!capability && !sequenceText) return undefined;
    if (!capability || !/^[A-Za-z0-9_-]{43}$/.test(capability) || !sequenceText || !/^\d{1,16}$/.test(sequenceText))
      throw new Error('Invalid debugger session resume');
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(sequence)) throw new Error('Invalid debugger session cursor');
    return { capability, sequence };
  }

  #prune(): void {
    for (const [capability, session] of this.#sessions) {
      if (
        !session.retained &&
        session.disconnectedAt != null &&
        this.now() - session.disconnectedAt >= this.limits.idleMs
      ) {
        this.#bytes -= session.bytes;
        this.#sessions.delete(capability);
      }
    }
  }

  canAccept(request: IncomingMessage, accepting: boolean): boolean {
    this.#prune();
    try {
      const resume = this.#resume(request);
      if (!resume) return accepting && !this.#retiring && this.#sessions.size < this.limits.sessions;
      const session = this.#sessions.get(resume.capability);
      return (
        !!session &&
        resume.sequence <= session.sequence &&
        resume.sequence >= (session.events[0]?.sequence ?? session.sequence + 1) - 1
      );
    } catch {
      return false;
    }
  }

  bind(socket: WebSocket, request: IncomingMessage): WebSocket {
    const resume = this.#resume(request);
    if (!this.canAccept(request, true)) throw new Error('Debugger session unavailable');
    let session = resume ? this.#sessions.get(resume.capability) : undefined;
    if (resume && !session) throw new Error('Debugger session owner lost');
    if (!session) {
      session = {
        capability: randomBytes(32).toString('base64url'),
        logical: socket,
        socket,
        sequence: 0,
        events: [],
        bytes: 0,
        retained: 0,
        runs: new Set(),
      };
      this.#sessions.set(session.capability, session);
    } else if (session.socket !== socket && session.socket.readyState < 2) {
      session.socket.close(4409, 'Session resumed elsewhere');
    }
    session.socket = socket;
    session.disconnectedAt = undefined;
    this.#clients.set(socket, session);
    socket.once('close', () => {
      if (session!.socket === socket) session!.disconnectedAt = this.now();
    });
    socket.send(
      JSON.stringify({
        message: 'executor-session',
        data: { protocol: 1, capability: session.capability, resumed: !!resume, sequence: resume?.sequence ?? 0 },
      }),
    );
    if (resume)
      for (const event of session.events) {
        if (event.sequence > resume.sequence) socket.send(event.payload);
      }
    socket.send(JSON.stringify({ message: 'executor-session-ready', data: { protocol: 1, resumed: !!resume } }));
    this.#notifyIdleRetirement(session);
    return session.logical;
  }

  isCurrent(socket: WebSocket): boolean {
    return this.#clients.get(socket)?.socket === socket;
  }

  acceptRun(client: WebSocket, requestId: string): boolean {
    const session = this.#clients.get(client);
    if (!session || typeof requestId !== 'string' || !requestId || requestId.length > 200)
      throw new Error('A resumable run requires a bounded request identity');
    if (session.runs.has(requestId)) return false;
    if (session.runs.size >= 4096) throw new Error('Debugger session run limit reached; open a new session');
    session.runs.add(requestId);
    return true;
  }

  retain(client: WebSocket): () => void {
    const session = this.#clients.get(client);
    if (!session) throw new Error('Debugger session was not admitted');
    session.retained++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        session.retained--;
        if (!session.retained && session.disconnectedAt != null) session.disconnectedAt = this.now();
        this.#notifyIdleRetirement(session);
      }
    };
  }

  #notifyIdleRetirement(session: Session): void {
    if (this.#retiring && !session.retained && session.socket.readyState === 1)
      this.send(session.logical, JSON.stringify({ message: 'executor-owner-retiring', data: { protocol: 1 } }));
  }
  beginRetirement(): void {
    this.#retiring = true;
    for (const session of this.#sessions.values()) this.#notifyIdleRetirement(session);
  }

  send(client: WebSocket, payload: string): void {
    const session = this.#clients.get(client);
    if (!session) throw new Error('Debugger session was not admitted');
    const sequence = ++session.sequence;
    if (!payload.startsWith('{')) throw new Error('Debugger session requires an object envelope');
    // Preserve already-sanitized transport bytes without parsing/copying large node outputs.
    const sequenced = `{"rivetSequence":${sequence},${payload.slice(1)}`;
    const bytes = Buffer.byteLength(sequenced);
    session.events.push({ sequence, payload: sequenced, bytes });
    session.bytes += bytes;
    this.#bytes += bytes;
    while (session.bytes > this.limits.bytes || session.events.length > this.limits.events) {
      const removed = session.events.shift()!.bytes;
      session.bytes -= removed;
      this.#bytes -= removed;
    }
    for (const candidate of this.#sessions.values()) {
      while (this.#bytes > this.totalBytesLimit && candidate.events.length) {
        const removed = candidate.events.shift()!.bytes;
        candidate.bytes -= removed;
        this.#bytes -= removed;
      }
      if (this.#bytes <= this.totalBytesLimit) break;
    }
    if (session.socket.readyState === 1) {
      if (session.socket.bufferedAmount > this.limits.bytes) session.socket.terminate();
      else session.socket.send(sequenced);
    }
  }
}
