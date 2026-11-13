import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { DebuggerSessionDelivery } from './debuggerSessionDelivery.js';

type Session = {
  capability: string;
  logical: WebSocket;
  socket: WebSocket;
  sequence: number;
  events: { sequence: number; payload: string; bytes: number }[];
  bytes: number;
  retained: number;
  runs: Set<string>;
  protocol: 1 | 2;
  delivery?: DebuggerSessionDelivery;
  disconnectedAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

/** One process owns its sessions. Reconnection changes an observer, never an execution. */
export class DebuggerSessions {
  #sessions = new Map<string, Session>();
  #clients = new WeakMap<WebSocket, Session>();
  #bytes = 0;
  #retiring = false;
  #reliableBudget = { bytes: 0 };
  #lastRejectionLog = -Infinity;
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
    if (!protocols.includes('rivet-session-v1') && !protocols.includes('rivet-session-v2'))
      throw new Error('Debugger session protocol required');
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
        if (session.expiryTimer) clearTimeout(session.expiryTimer);
        session.delivery?.dispose();
        session.events = [];
        session.bytes = 0;
        session.runs.clear();
        this.#clients.delete(session.logical);
        this.#clients.delete(session.socket);
        this.#sessions.delete(capability);
      }
    }
  }

  #scheduleExpiry(session: Session) {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => this.#prune(), this.limits.idleMs);
    session.expiryTimer.unref?.();
  }

  canAccept(request: IncomingMessage, accepting: boolean): boolean {
    this.#prune();
    const reject = (reason: string) => {
      // Capabilities and request URLs are secret. Rate-limit diagnostics across failed handshakes.
      if (this.now() - this.#lastRejectionLog >= 5_000) {
        this.#lastRejectionLog = this.now();
        console.warn('[executor-session] Resume/admission rejected', { reason, sessions: this.#sessions.size });
      }
      return false;
    };
    try {
      const resume = this.#resume(request);
      if (!resume)
        return (
          (accepting && !this.#retiring && this.#sessions.size < this.limits.sessions) || reject('admission-closed')
        );
      const session = this.#sessions.get(resume.capability);
      if (!session) return reject('owner-unavailable');
      if (
        !String(request.headers['sec-websocket-protocol'])
          .split(',')
          .map((value) => value.trim())
          .includes(`rivet-session-v${session.protocol}`)
      )
        return reject('protocol-mismatch');
      if (resume.sequence > (session.delivery?.sequence ?? session.sequence)) return reject('invalid-cursor');
      if (!session.delivery && resume.sequence < (session.events[0]?.sequence ?? session.sequence + 1) - 1)
        return reject('diagnostic-history-expired');
      return true;
    } catch {
      return reject('invalid-resume');
    }
  }

  selectProtocol(request: IncomingMessage): string | false {
    try {
      const resume = this.#resume(request);
      const existing = resume && this.#sessions.get(resume.capability);
      if (existing) return `rivet-session-v${existing.protocol}`;
      return String(request.headers['sec-websocket-protocol'])
        .split(',')
        .map((v) => v.trim())
        .includes('rivet-session-v2')
        ? 'rivet-session-v2'
        : 'rivet-session-v1';
    } catch {
      return false;
    }
  }
  protocol(client: WebSocket): 1 | 2 {
    return this.#sessionFor(client)?.protocol ?? 1;
  }

  #sessionFor(client: WebSocket): Session | undefined {
    const session = this.#clients.get(client);
    return session && this.#sessions.get(session.capability) === session ? session : undefined;
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
        protocol: this.selectProtocol(request) === 'rivet-session-v2' ? 2 : 1,
      };
      if (session.protocol === 2) session.delivery = new DebuggerSessionDelivery(this.limits, this.#reliableBudget);
      this.#sessions.set(session.capability, session);
    } else if (session.socket !== socket && session.socket.readyState < 2) {
      session.socket.close(4409, 'Session resumed elsewhere');
    }
    session.socket = socket;
    session.disconnectedAt = undefined;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    this.#clients.set(socket, session);
    socket.once('close', () => {
      if (session!.socket === socket) {
        session!.disconnectedAt = this.now();
        this.#scheduleExpiry(session!);
      }
    });
    socket.send(
      JSON.stringify({
        message: 'executor-session',
        data: {
          protocol: session.protocol,
          capability: session.capability,
          resumed: !!resume,
          sequence: resume?.sequence ?? 0,
        },
      }),
    );
    if (session.delivery) session.delivery.bind(socket, resume?.sequence ?? 0);
    else {
      if (resume)
        for (const event of session.events) {
          if (event.sequence > resume.sequence) socket.send(event.payload);
        }
      socket.send(JSON.stringify({ message: 'executor-session-ready', data: { protocol: 1, resumed: !!resume } }));
    }
    this.#notifyIdleRetirement(session);
    return session.logical;
  }

  isCurrent(socket: WebSocket): boolean {
    return this.#sessionFor(socket)?.socket === socket;
  }

  acceptRun(client: WebSocket, requestId: string): boolean {
    const session = this.#sessionFor(client);
    if (!session || typeof requestId !== 'string' || !requestId || requestId.length > 200)
      throw new Error('A resumable run requires a bounded request identity');
    if (session.runs.has(requestId)) return false;
    if (session.delivery && !session.delivery.canAcceptRun())
      throw new Error('Executor reliable result capacity is busy.');
    if (session.runs.size >= 4096) throw new Error('Debugger session run limit reached; open a new session');
    session.runs.add(requestId);
    session.delivery?.phases.set(requestId, 'accepted');
    return true;
  }

  retain(client: WebSocket): () => void {
    const session = this.#sessionFor(client);
    if (!session) throw new Error('Debugger session was not admitted');
    session.retained++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        session.retained--;
        if (!session.retained && session.disconnectedAt != null) {
          session.disconnectedAt = this.now();
          this.#scheduleExpiry(session);
        }
        this.#notifyIdleRetirement(session);
      }
    };
  }

  #notifyIdleRetirement(session: Session): void {
    if (this.#retiring && !session.retained && session.socket.readyState === 1)
      this.send(
        session.logical,
        JSON.stringify({ message: 'executor-owner-retiring', data: { protocol: session.protocol } }),
      );
  }
  beginRetirement(): void {
    this.#retiring = true;
    for (const session of this.#sessions.values()) this.#notifyIdleRetirement(session);
  }

  send(client: WebSocket, payload: string): void {
    const session = this.#sessionFor(client);
    if (!session) throw new Error('Debugger session was not admitted');
    if (session.delivery) {
      this.sendMessage(client, JSON.parse(payload));
      return;
    }
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
    this.#trimHistory();
    if (session.socket.readyState === 1) {
      if (session.socket.bufferedAmount > this.limits.bytes) session.socket.terminate();
      else session.socket.send(sequenced);
    }
  }

  sendMessage(client: WebSocket, envelope: Record<string, any>): boolean {
    const session = this.#sessionFor(client);
    if (!session?.delivery) throw new Error('Versioned delivery requires executor protocol v2');
    try {
      session.delivery.send(envelope);
    } catch (error) {
      if (String(envelope.message).startsWith('datasets:')) throw error;
      // Preserve a small known delivery failure; never substitute truncated graph outputs.
      session.delivery.send(
        {
          message: 'error',
          requestId: envelope.requestId,
          data: {
            error: 'The executor result exceeds retained delivery capacity. It was not resubmitted.',
            code: 'executor-result-unavailable',
            executionStatus:
              envelope.message === 'done'
                ? 'completed'
                : envelope.message === 'graphOutputsReady'
                  ? 'outputs-ready'
                  : 'unknown',
          },
        },
        true,
      );
      this.#trimHistory();
      return false;
    }
    this.#trimHistory();
    return true;
  }
  #trimHistory() {
    let total = [...this.#sessions.values()].reduce((bytes, item) => bytes + (item.delivery?.bytes ?? 0), this.#bytes);
    for (const item of this.#sessions.values()) {
      if (total <= this.totalBytesLimit) break;
      if (item.delivery) {
        const before = item.delivery.bytes;
        item.delivery.trim(Math.max(0, before - (total - this.totalBytesLimit)));
        total -= before - item.delivery.bytes;
      } else
        while (total > this.totalBytesLimit && item.events.length) {
          const removed = item.events.shift()!.bytes;
          item.bytes -= removed;
          this.#bytes -= removed;
          total -= removed;
        }
    }
  }
  acknowledge(client: WebSocket, id: unknown) {
    this.#sessionFor(client)?.delivery?.acknowledge(id);
  }
  receive(client: WebSocket, value: unknown) {
    return this.#sessionFor(client)?.delivery?.receive(value);
  }
  receipt(client: WebSocket, id: number) {
    this.#sessionFor(client)?.delivery?.receipt(id);
  }
}
