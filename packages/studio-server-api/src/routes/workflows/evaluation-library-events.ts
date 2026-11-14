import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { watchOperatorStreamAuthorization } from '../../watch-authorization.js';
import { watchVmMigrationPassiveStream } from '../../vm-migration-maintenance.js';

export const EVALUATION_LIBRARY_CLIENT_ID_HEADER = 'x-rivet-evaluation-library-client-id';

export type EvaluationLibraryChangeEvent = {
  epoch: string;
  revision: number;
  sourceClientId: string | null;
};

type Listener = (event: EvaluationLibraryChangeEvent) => void;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEARTBEAT_MS = 20_000;

class EvaluationLibraryNotifier {
  #epoch = randomUUID();
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  state(revision: number): Omit<EvaluationLibraryChangeEvent, 'sourceClientId'> {
    return { epoch: this.#epoch, revision };
  }

  reset(): void {
    this.#epoch = randomUUID();
    this.notify(0, null);
  }

  notify(revision: number, sourceClientId: string | null): void {
    const event = { ...this.state(revision), sourceClientId };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[evaluation-library-events] Failed to notify a dashboard client:', error);
      }
    }
  }
}

const notifier = new EvaluationLibraryNotifier();

export function getEvaluationLibraryClientId(request: Request): string | null {
  const value = request.get(EVALUATION_LIBRARY_CLIENT_ID_HEADER)?.trim() ?? '';
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

export function notifyEvaluationLibraryChanged(request: Request, revision: number): void {
  notifier.notify(revision, getEvaluationLibraryClientId(request));
}

/** A gap changes epoch so clients refetch even if a missed revision is unknown. */
export function notifyExternalEvaluationLibraryChanged(revision: number | null): void {
  if (revision === null) notifier.reset();
  else notifier.notify(revision, null);
}

function writeEvent(response: Response, type: string, event: object): boolean {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Listen before loading the initial revision so an in-flight read cannot lose a change. */
export async function openEvaluationLibraryEventStream(
  request: Request,
  response: Response,
  readInitialRevision: () => Promise<number>,
): Promise<void> {
  const openingEpoch = notifier.state(0).epoch;
  let latest: EvaluationLibraryChangeEvent | undefined;
  const stopCollecting = notifier.subscribe((event) => {
    if (!latest || event.epoch !== latest.epoch || event.revision > latest.revision) latest = event;
  });
  response.once('close', stopCollecting);
  try {
    const initialRevision = await readInitialRevision();
    if (response.destroyed || response.writableEnded) return;
    openStream(request, response, { epoch: openingEpoch, revision: initialRevision }, latest);
  } finally {
    response.off('close', stopCollecting);
    stopCollecting();
  }
}

function openStream(
  request: Request,
  response: Response,
  initial: { epoch: string; revision: number },
  pending: EvaluationLibraryChangeEvent | undefined,
): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();
  if (!watchOperatorStreamAuthorization(request, response)) return;
  if (!watchVmMigrationPassiveStream(response)) return;

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    request.off('close', close);
    response.off('close', close);
  };

  unsubscribe = notifier.subscribe((event) => {
    if (!writeEvent(response, 'library-changed', event)) close();
  });
  writeEvent(response, 'library-state', initial);
  // A reset and its snapshot cannot be collapsed into one revision: the read
  // may belong to either epoch. Deliver the reset so clients refetch normally.
  if (pending && (pending.epoch !== initial.epoch || pending.revision > initial.revision)) {
    writeEvent(response, 'library-state', { epoch: pending.epoch, revision: pending.revision });
  }
  heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      close();
      return;
    }
    try {
      response.write(': keepalive\n\n');
    } catch {
      close();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  request.once('close', close);
  response.once('close', close);
}
