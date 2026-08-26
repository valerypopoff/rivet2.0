import { performance } from 'node:perf_hooks';

import type { ApiRuntimeProfile } from './runtime-profile.js';

export type RuntimeHealthState = 'starting' | 'ready' | 'draining' | 'stopped';

export type RuntimeHealthCheckContext = Readonly<{
  signal: AbortSignal;
  timeoutMs: number;
}>;

export type RuntimeHealthCheck = {
  name: string;
  failureCode: string;
  check(context: RuntimeHealthCheckContext): Promise<void>;
};

type PendingRuntimeHealthCheck = Readonly<{
  controller: AbortController;
  promise: Promise<void>;
}>;

type RuntimeHealthCheckResult = Readonly<{
  name: string;
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  code?: string;
}>;

export type RuntimeHealthSnapshot = {
  ok: boolean;
  profile: ApiRuntimeProfile;
  state: RuntimeHealthState;
  checkedAt: string | null;
  checks: readonly RuntimeHealthCheckResult[];
  code?: 'starting' | 'draining' | 'stopped' | 'health_check_stale' | 'dependency_unavailable';
};

export type RuntimeHealthReader = {
  getLiveness(): RuntimeHealthSnapshot;
  getReadiness(): RuntimeHealthSnapshot;
};

type RuntimeHealthControllerOptions = {
  refreshIntervalMs?: number;
  checkTimeoutMs?: number;
  staleAfterMs?: number;
  logger?: Pick<Console, 'error' | 'log'>;
};

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_STALE_AFTER_MS = 20_000;

function normalizeDuration(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value) && (value ?? 0) >= minimum ? Math.floor(value as number) : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RuntimeHealthController implements RuntimeHealthReader {
  readonly #profile: ApiRuntimeProfile;
  readonly #checks: readonly RuntimeHealthCheck[];
  readonly #refreshIntervalMs: number;
  readonly #checkTimeoutMs: number;
  readonly #staleAfterMs: number;
  readonly #logger: Pick<Console, 'error' | 'log'>;
  #state: RuntimeHealthState = 'starting';
  #results: readonly RuntimeHealthCheckResult[] = [];
  #lastRefreshAt = 0;
  #timer: NodeJS.Timeout | undefined;
  #startPromise: Promise<void> | null = null;
  #refreshPromise: Promise<void> | null = null;
  readonly #checkPromises = new Map<RuntimeHealthCheck, PendingRuntimeHealthCheck>();
  #lastReady: boolean | null = null;
  readonly #failedChecks = new Set<string>();

  constructor(
    profile: ApiRuntimeProfile,
    checks: readonly RuntimeHealthCheck[],
    options: RuntimeHealthControllerOptions = {},
  ) {
    this.#profile = profile;
    this.#checks = checks;
    this.#refreshIntervalMs = normalizeDuration(
      options.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
      1_000,
    );
    this.#checkTimeoutMs = normalizeDuration(options.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 100);
    this.#staleAfterMs = Math.max(
      normalizeDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, 1_000),
      this.#refreshIntervalMs + this.#checkTimeoutMs,
    );
    this.#logger = options.logger ?? console;
  }

  start(): Promise<void> {
    if (this.#state !== 'starting') return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = (async () => {
      await this.refresh();
      if (this.#state !== 'starting') return;
      this.#state = 'ready';
      this.#reportReadinessTransition();
      this.#timer = setInterval(() => {
        void this.refresh().catch((error) => {
          this.#logger.error('[rivet-api] Runtime health refresh failed:', error);
        });
      }, this.#refreshIntervalMs);
      this.#timer.unref?.();
    })().finally(() => {
      this.#startPromise = null;
    });

    return this.#startPromise;
  }

  beginDrain(): void {
    if (this.#state === 'draining' || this.#state === 'stopped') return;
    this.#state = 'draining';
    this.#stopTimer();
    this.#abortPendingChecks('Runtime health checks cancelled while draining.');
    this.#reportReadinessTransition();
  }

  stop(): void {
    this.#state = 'stopped';
    this.#stopTimer();
    this.#abortPendingChecks('Runtime health checks cancelled while stopping.');
    this.#reportReadinessTransition();
  }

  async refresh(): Promise<void> {
    if (this.#refreshPromise) return this.#refreshPromise;
    if (this.#state === 'draining' || this.#state === 'stopped') return;

    this.#refreshPromise = (async () => {
      const results = await Promise.all(this.#checks.map((check) => this.#runCheck(check)));
      this.#results = Object.freeze(results.map((result) => Object.freeze(result)));
      this.#lastRefreshAt = Date.now();
      this.#reportReadinessTransition();
    })().finally(() => {
      this.#refreshPromise = null;
    });

    return this.#refreshPromise;
  }

  getLiveness(): RuntimeHealthSnapshot {
    return {
      ok: this.#state !== 'stopped',
      profile: this.#profile,
      state: this.#state,
      checkedAt: this.#lastRefreshAt > 0 ? new Date(this.#lastRefreshAt).toISOString() : null,
      checks: [],
      ...(this.#state === 'stopped' ? { code: 'stopped' as const } : {}),
    };
  }

  getReadiness(): RuntimeHealthSnapshot {
    const checkedAt = this.#lastRefreshAt > 0 ? new Date(this.#lastRefreshAt).toISOString() : null;
    if (this.#state !== 'ready') {
      const code = this.#state === 'starting'
        ? 'starting'
        : this.#state === 'draining'
          ? 'draining'
          : 'stopped';
      return {
        ok: false,
        profile: this.#profile,
        state: this.#state,
        checkedAt,
        checks: this.#results,
        code,
      };
    }

    if (this.#lastRefreshAt === 0 || Date.now() - this.#lastRefreshAt > this.#staleAfterMs) {
      return {
        ok: false,
        profile: this.#profile,
        state: this.#state,
        checkedAt,
        checks: this.#results,
        code: 'health_check_stale',
      };
    }

    const ok = this.#results.every((result) => result.ok);
    return {
      ok,
      profile: this.#profile,
      state: this.#state,
      checkedAt,
      checks: this.#results,
      ...(!ok ? { code: 'dependency_unavailable' as const } : {}),
    };
  }

  async #runCheck(check: RuntimeHealthCheck): Promise<RuntimeHealthCheckResult> {
    const startedAt = performance.now();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const pending = this.#getCheckPromise(check);
      await Promise.race([
        pending.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Health check timed out.');
            pending.controller.abort(error);
            reject(error);
          }, this.#checkTimeoutMs);
        }),
      ]);
      if (this.#failedChecks.delete(check.name)) {
        this.#logger.log(`[rivet-api] Runtime health check "${check.name}" recovered.`);
      }
      return {
        name: check.name,
        ok: true,
        checkedAt: nowIso(),
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (
        this.#state !== 'draining' &&
        this.#state !== 'stopped' &&
        !this.#failedChecks.has(check.name)
      ) {
        this.#failedChecks.add(check.name);
        this.#logger.error(`[rivet-api] Runtime health check "${check.name}" failed:`, error);
      }
      return {
        name: check.name,
        ok: false,
        checkedAt: nowIso(),
        durationMs: Math.round(performance.now() - startedAt),
        code: check.failureCode,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #getCheckPromise(check: RuntimeHealthCheck): PendingRuntimeHealthCheck {
    const existing = this.#checkPromises.get(check);
    if (existing) return existing;

    const controller = new AbortController();
    let pending!: PendingRuntimeHealthCheck;
    const promise = Promise.resolve()
      .then(() => check.check({
        signal: controller.signal,
        timeoutMs: this.#checkTimeoutMs,
      }))
      .finally(() => {
        if (this.#checkPromises.get(check) === pending) {
          this.#checkPromises.delete(check);
        }
      });
    pending = Object.freeze({ controller, promise });
    this.#checkPromises.set(check, pending);
    return pending;
  }

  #abortPendingChecks(reason: string): void {
    for (const pending of this.#checkPromises.values()) {
      pending.controller.abort(new Error(reason));
    }
  }

  #stopTimer(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #reportReadinessTransition(): void {
    const ready = this.getReadiness().ok;
    if (ready === this.#lastReady) return;
    this.#lastReady = ready;
    this.#logger.log(`[rivet-api] Readiness changed: ${ready ? 'ready' : 'not ready'} (${this.#state}).`);
  }
}

export function getRuntimeHealthOptionsFromEnv(): RuntimeHealthControllerOptions {
  const seconds = (name: string): number | undefined => {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000 : undefined;
  };

  return {
    refreshIntervalMs: seconds('RIVET_HEALTH_REFRESH_SECONDS'),
    checkTimeoutMs: seconds('RIVET_HEALTH_CHECK_TIMEOUT_SECONDS'),
    staleAfterMs: seconds('RIVET_HEALTH_STALE_AFTER_SECONDS'),
  };
}
