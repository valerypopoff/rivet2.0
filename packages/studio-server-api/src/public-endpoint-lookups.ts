import type { EventEmitter } from 'node:events';
import { getManagedPostgresPoolMax } from './managed-postgres-pool.js';
import { recordStudioMetrics } from './metrics.js';
import { PublishedExecutionAdmissionError } from './published-execution-admission.js';

type Client = EventEmitter & { readonly destroyed: boolean };
type WaitOutcome = 'dispatched' | 'expired' | 'disconnected' | 'draining';

function rejected(reason: 'full' | Exclude<WaitOutcome, 'dispatched'>) {
  recordStudioMetrics((metrics) => metrics.recordEndpointLookupRejection(reason));
  if (reason === 'disconnected') return new Error('Client disconnected before execution');
  return new PublishedExecutionAdmissionError(
    503,
    reason === 'draining' ? 'execution_draining' : 'endpoint_lookup_busy',
    1,
  );
}

export class PublicEndpointLookups {
  private active = 0;
  private draining = false;
  private readonly waiters = new Set<() => void>();
  private readonly width: number;

  constructor(
    poolSize: number,
    private readonly queueSize = 96,
    private readonly waitMs = 200,
    private readonly now = () => performance.now(),
  ) {
    this.width = Math.max(1, Math.floor(poolSize * 0.8));
  }

  get snapshot() {
    return { active: this.active, queued: this.waiters.size };
  }

  beginDrain(): void {
    this.draining = true;
    for (const dispatch of this.waiters) dispatch();
  }

  resolve<T>(client: Client, lookup: () => Promise<T>): Promise<T> {
    if (this.draining) return Promise.reject(rejected('draining'));
    if (client.destroyed) return Promise.reject(rejected('disconnected'));
    if (this.active < this.width) return this.start(client, lookup);
    if (this.waiters.size >= this.queueSize) return Promise.reject(rejected('full'));

    const queuedAt = this.now();
    return new Promise<T>((resolve, reject) => {
      const finish = (outcome: WaitOutcome) => {
        if (!this.waiters.delete(dispatch)) return;
        clearTimeout(timer);
        client.off('close', disconnect);
        recordStudioMetrics((metrics) => metrics.observeEndpointLookupWait(this.now() - queuedAt));
        if (outcome === 'dispatched') resolve(this.start(client, lookup));
        else reject(rejected(outcome));
      };
      const disconnect = () => finish('disconnected');
      const dispatch = () => {
        if (this.draining) finish('draining');
        else if (client.destroyed) disconnect();
        else if (this.now() - queuedAt >= this.waitMs) finish('expired');
        else finish('dispatched');
      };
      const timer = setTimeout(() => finish('expired'), this.waitMs);
      client.once('close', disconnect);
      this.waiters.add(dispatch);
    });
  }

  private async start<T>(client: Client, lookup: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      const target = await lookup();
      if (this.draining) throw rejected('draining');
      if (client.destroyed) throw rejected('disconnected');
      return target;
    } finally {
      this.active--;
      // Expired or disconnected waiters can leave the slot available to the next one.
      for (const dispatch of this.waiters) {
        dispatch();
        if (this.active >= this.width) break;
      }
    }
  }
}

let publicLookups: PublicEndpointLookups | undefined;
export function getPublicEndpointLookups(): PublicEndpointLookups {
  return (publicLookups ??= new PublicEndpointLookups(getManagedPostgresPoolMax()));
}
