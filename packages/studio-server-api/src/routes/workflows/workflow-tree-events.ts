import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

import {
  WORKFLOW_TREE_CLIENT_ID_HEADER,
  type WorkflowTreeChangeEvent,
  type WorkflowTreeSyncState,
} from '../../../../studio-server-shared/workflow-types.js';

const WORKFLOW_TREE_HEARTBEAT_INTERVAL_MS = 20_000;
const WORKFLOW_TREE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type WorkflowTreeChangeListener = (event: WorkflowTreeChangeEvent) => void;

class WorkflowTreeChangeNotifier {
  readonly #epoch = randomUUID();
  #revision = 0;
  readonly #listeners = new Set<WorkflowTreeChangeListener>();

  getState(): WorkflowTreeSyncState {
    return { epoch: this.#epoch, revision: this.#revision };
  }

  subscribe(listener: WorkflowTreeChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(sourceClientId: string | null): WorkflowTreeChangeEvent {
    const event: WorkflowTreeChangeEvent = {
      ...this.getState(),
      revision: ++this.#revision,
      sourceClientId,
    };

    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // A browser stream must never make an already completed mutation fail.
        console.warn('[workflow-tree-events] Failed to notify a dashboard client:', error);
      }
    }

    return event;
  }
}

const notifier = new WorkflowTreeChangeNotifier();

export function getWorkflowTreeSyncState(): WorkflowTreeSyncState {
  return notifier.getState();
}

export function getWorkflowTreeClientId(request: Request): string | null {
  const raw = request.get(WORKFLOW_TREE_CLIENT_ID_HEADER)?.trim() ?? '';
  return WORKFLOW_TREE_CLIENT_ID_PATTERN.test(raw) ? raw : null;
}

export function notifyWorkflowTreeChanged(request: Request): WorkflowTreeChangeEvent {
  return notifier.notify(getWorkflowTreeClientId(request));
}

function writeSseEvent(response: Response, event: string, payload: WorkflowTreeSyncState | WorkflowTreeChangeEvent): boolean {
  if (response.destroyed || response.writableEnded) {
    return false;
  }

  try {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold one authenticated dashboard connection open and notify it only that a
 * new tree snapshot is available. The tree itself remains an ordinary JSON
 * request so every client sees the same storage-backed representation.
 */
export function openWorkflowTreeEventStream(request: Request, response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    request.off('close', close);
    response.off('close', close);
  };

  unsubscribe = notifier.subscribe((event) => {
    if (!writeSseEvent(response, 'tree-changed', event)) {
      close();
    }
  });
  writeSseEvent(response, 'tree-state', notifier.getState());

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
  }, WORKFLOW_TREE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  request.once('close', close);
  response.once('close', close);
}
