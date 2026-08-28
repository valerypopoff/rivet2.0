import { Client, type ClientConfig, type Pool } from 'pg';
import type {
  RivetWebAppCoordinatedRun,
  RivetWebAppRunCoordinator,
  RivetWebAppRunCoordinatorSubscription,
  RivetWebAppRunEvent,
} from '@valerypopoff/rivet2-node';

import { readStoredWebAppActionEvent } from './web-app-action-run-store.js';

const EVENT_CHANNEL = 'rivet_web_app_action_event';
const CANCEL_CHANNEL = 'rivet_web_app_action_cancel';
const POLL_INTERVAL_MS = 2_000;

type HostHandler = {
  cancelRun(run: Omit<RivetWebAppCoordinatedRun, 'hostId'>): Promise<boolean>;
};

type Subscription = {
  onEvent(event: RivetWebAppRunEvent): void;
};

type StoredEventRow = {
  event: RivetWebAppRunEvent | string;
  run_id: string;
  sequence: number;
};

type CoordinatorNotification = {
  kind: 'event' | 'cancel';
  runId: string;
  sequence?: number;
  hostId?: string;
};

function parseNotification(value: string): CoordinatorNotification | null {
  try {
    const parsed = JSON.parse(value) as CoordinatorNotification;
    return parsed && typeof parsed.runId === 'string' && (parsed.kind === 'event' || parsed.kind === 'cancel')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export class PostgresRivetWebAppRunCoordinator implements RivetWebAppRunCoordinator {
  readonly #hosts = new Map<string, HostHandler>();
  readonly #subscriptions = new Map<string, Set<Subscription>>();
  readonly #pool: Pool;
  readonly #listenerConfig: ClientConfig;
  readonly #onError: (error: unknown) => void;
  readonly #lastDeliveredSequences = new Map<string, number>();
  #listener: Client | null = null;
  #disposed = false;
  #pollTimer: NodeJS.Timeout;
  #listenerReconnectTimer: NodeJS.Timeout | null = null;
  #processingCancels = false;

  constructor(
    pool: Pool,
    listenerConfig: ClientConfig,
    onError: (error: unknown) => void = (error) => console.error('[web-app-actions] coordinator error:', error),
    pollIntervalMs = POLL_INTERVAL_MS,
  ) {
    this.#pool = pool;
    this.#listenerConfig = listenerConfig;
    this.#onError = onError;
    this.#pollTimer = setInterval(() => {
      void this.#poll();
    }, pollIntervalMs);
    this.#pollTimer.unref?.();
  }

  async initialize(): Promise<void> {
    await this.#connectListener();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#pollTimer);
    if (this.#listenerReconnectTimer) clearTimeout(this.#listenerReconnectTimer);
    this.#subscriptions.clear();
    this.#lastDeliveredSequences.clear();
    this.#hosts.clear();
    await this.#listener?.end().catch(() => undefined);
    this.#listener = null;
  }

  async cancelRun(run: RivetWebAppCoordinatedRun): Promise<boolean> {
    const { rows } = await this.#pool.query<{ run_id: string }>(`
      INSERT INTO web_app_action_cancel_commands (run_id, host_id, owner_scope)
      SELECT run_id, host_id, owner_scope
      FROM web_app_action_runs
      WHERE run_id = $1
        AND host_id = $2
        AND owner_scope = $3
        AND status = 'running'
        AND lease_expires_at > NOW()
      ON CONFLICT (run_id) DO UPDATE
      SET requested_at = web_app_action_cancel_commands.requested_at
      WHERE web_app_action_cancel_commands.acknowledged_at IS NULL
      RETURNING run_id
    `, [run.runId, run.hostId, run.ownerScope]);
    if (!rows[0]) return false;

    try {
      await this.#notify(CANCEL_CHANNEL, { kind: 'cancel', runId: run.runId, hostId: run.hostId });
    } catch (error) {
      // The durable command is already committed. Polling will deliver it if
      // PostgreSQL notifications are briefly unavailable.
      this.#onError(error);
    }
    if (this.#hosts.has(run.hostId)) {
      void this.#processPendingCancels();
    }
    return true;
  }

  async publishEvent(run: RivetWebAppCoordinatedRun & { event: RivetWebAppRunEvent }): Promise<void> {
    await this.#notify(EVENT_CHANNEL, {
      kind: 'event',
      runId: run.runId,
      sequence: run.event.sequence,
    });
  }

  registerHost(hostId: string, handlers: HostHandler): () => void {
    if (this.#hosts.has(hostId)) {
      throw new Error(`Web app action coordinator host "${hostId}" is already registered.`);
    }
    this.#hosts.set(hostId, handlers);
    void this.#processPendingCancels();
    return () => {
      if (this.#hosts.get(hostId) === handlers) this.#hosts.delete(hostId);
    };
  }

  async subscribe(run: Parameters<RivetWebAppRunCoordinator['subscribe']>[0]): Promise<RivetWebAppRunCoordinatorSubscription> {
    const subscription: Subscription = {
      onEvent: run.onEvent,
    };
    const entries = this.#subscriptions.get(run.runId) ?? new Set<Subscription>();
    entries.add(subscription);
    this.#subscriptions.set(run.runId, entries);
    return {
      dispose: () => {
        entries.delete(subscription);
        if (entries.size === 0) {
          this.#subscriptions.delete(run.runId);
          this.#lastDeliveredSequences.delete(run.runId);
        }
      },
    };
  }

  async #notify(channel: string, message: CoordinatorNotification): Promise<void> {
    await this.#pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(message)]);
  }

  async #connectListener(): Promise<void> {
    if (this.#disposed || this.#listener) return;
    const listener = new Client(this.#listenerConfig);
    listener.on('notification', (notification) => {
      const message = parseNotification(notification.payload ?? '');
      if (!message) return;
      if (message.kind === 'event' && notification.channel === EVENT_CHANNEL && message.sequence != null) {
        void this.#deliverEvent(message.runId, message.sequence).catch(this.#onError);
      }
      if (message.kind === 'cancel' && notification.channel === CANCEL_CHANNEL) {
        void this.#processPendingCancels();
      }
    });
    listener.on('error', (error) => {
      this.#onError(error);
      void this.#resetListener(listener);
    });
    listener.on('end', () => {
      void this.#resetListener(listener);
    });

    try {
      await listener.connect();
      await listener.query(`LISTEN ${EVENT_CHANNEL}`);
      await listener.query(`LISTEN ${CANCEL_CHANNEL}`);
      if (this.#disposed) {
        await listener.end();
        return;
      }
      this.#listener = listener;
    } catch (error) {
      await listener.end().catch(() => undefined);
      this.#onError(error);
      this.#scheduleListenerReconnect();
    }
  }

  async #resetListener(listener: Client): Promise<void> {
    if (this.#listener !== listener) return;
    this.#listener = null;
    await listener.end().catch(() => undefined);
    this.#scheduleListenerReconnect();
  }

  #scheduleListenerReconnect(): void {
    if (this.#disposed || this.#listenerReconnectTimer) return;
    this.#listenerReconnectTimer = setTimeout(() => {
      this.#listenerReconnectTimer = null;
      void this.#connectListener();
    }, POLL_INTERVAL_MS);
    this.#listenerReconnectTimer.unref?.();
  }

  async #deliverEvent(runId: string, sequence: number): Promise<void> {
    const event = await readStoredWebAppActionEvent(this.#pool, runId, sequence);
    if (!event) return;
    this.#broadcastEvent(runId, event);
  }

  #broadcastEvent(runId: string, event: RivetWebAppRunEvent): void {
    const lastSequence = this.#lastDeliveredSequences.get(runId) ?? 0;
    if (event.sequence <= lastSequence) return;
    this.#lastDeliveredSequences.set(runId, event.sequence);
    for (const subscription of this.#subscriptions.get(runId) ?? []) {
      try {
        subscription.onEvent(event);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  async #poll(): Promise<void> {
    try {
      await this.#processPendingCancels();
      const runIds = [...this.#subscriptions.keys()];
      if (runIds.length === 0) return;
      const { rows } = await this.#pool.query<StoredEventRow>(`
        SELECT DISTINCT ON (run_id) run_id, sequence, event
        FROM web_app_action_run_events
        WHERE run_id = ANY($1::text[])
        ORDER BY run_id, sequence DESC
      `, [runIds]);
      for (const row of rows) {
        const event = typeof row.event === 'string'
          ? JSON.parse(row.event) as RivetWebAppRunEvent
          : row.event;
        this.#broadcastEvent(row.run_id, event);
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  async #processPendingCancels(): Promise<void> {
    if (this.#processingCancels || this.#disposed || this.#hosts.size === 0) return;
    this.#processingCancels = true;
    try {
      for (const [hostId, handler] of this.#hosts) {
        const { rows } = await this.#pool.query<{ run_id: string; owner_scope: string }>(`
          SELECT run_id, owner_scope
          FROM web_app_action_cancel_commands
          WHERE host_id = $1 AND acknowledged_at IS NULL
          ORDER BY requested_at ASC
          LIMIT 32
        `, [hostId]);
        for (const row of rows) {
          const cancelled = await handler.cancelRun({ ownerScope: row.owner_scope, runId: row.run_id });
          if (cancelled) {
            await this.#pool.query(`
              UPDATE web_app_action_cancel_commands
              SET acknowledged_at = NOW()
              WHERE run_id = $1 AND acknowledged_at IS NULL
            `, [row.run_id]);
          }
        }
      }
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#processingCancels = false;
    }
  }
}
