import { getStudioMetrics } from './metrics.js';

/**
 * Per-process admission for public execution traffic.
 *
 * This intentionally has no waiting queue: keeping waiting graph requests in
 * every execution pod turns overload into unbounded latency and memory use.
 * Kubernetes scales pods; this gate keeps each pod within its configured
 * active-run envelope while that happens.
 */

export const PUBLISHED_EXECUTION_ADMISSION_MODE_ENV = 'RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE';
export const PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS_ENV = 'RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS';
export const PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS_ENV = 'RIVET_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS';

export type PublishedExecutionAdmissionMode = 'disabled' | 'observe' | 'enforce';
export type PublishedExecutionSurface = 'workflow-endpoint' | 'web-app-action';

export type PublishedExecutionAdmissionConfig = {
  maxActiveRuns: number;
  mode: PublishedExecutionAdmissionMode;
  retryAfterSeconds: number;
};

export type PublishedExecutionAdmissionSnapshot = PublishedExecutionAdmissionConfig & {
  activeRuns: number;
  activeRunsBySurface: Readonly<Record<PublishedExecutionSurface, number>>;
  draining: boolean;
};

export type PublishedExecutionAdmissionDecision = Readonly<{
  kind: 'accepted' | 'capacity-exceeded' | 'draining';
  surface: PublishedExecutionSurface;
}>;

export type PublishedExecutionPermit = {
  release(): void;
};

export type PublishedExecutionAdmissionResult =
  | {
      kind: 'accepted';
      permit: PublishedExecutionPermit;
    }
  | {
      activeRuns: number;
      kind: 'capacity-exceeded';
      maxActiveRuns: number;
      retryAfterSeconds: number;
    }
  | {
      activeRuns: number;
      kind: 'draining';
      maxActiveRuns: number;
      retryAfterSeconds: number;
    };

export type PublishedExecutionAdmissionEvent = {
  activeRuns: number;
  maxActiveRuns: number;
  mode: PublishedExecutionAdmissionMode;
  surface: PublishedExecutionSurface;
  type: 'capacity-exceeded' | 'observe-over-capacity' | 'draining';
};

export type PublishedExecutionAdmission = {
  acquire(surface: PublishedExecutionSurface): PublishedExecutionAdmissionResult;
  beginDrain(): void;
  getSnapshot(): PublishedExecutionAdmissionSnapshot;
};

export class PublishedExecutionAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly code: 'execution_capacity_exceeded' | 'execution_draining',
    readonly retryAfterSeconds: number,
  ) {
    super(
      code === 'execution_capacity_exceeded'
        ? 'Published execution capacity is temporarily full. Retry later.'
        : 'Published execution is draining. Retry later.',
    );
    this.name = 'PublishedExecutionAdmissionError';
  }
}

export function createPublishedExecutionAdmission(
  config: PublishedExecutionAdmissionConfig,
  options: {
    onDecision?: (decision: PublishedExecutionAdmissionDecision) => void;
    onEvent?: (event: PublishedExecutionAdmissionEvent) => void;
    onSnapshot?: (snapshot: PublishedExecutionAdmissionSnapshot) => void;
  } = {},
): PublishedExecutionAdmission {
  validateConfig(config);

  let activeRuns = 0;
  const activeRunsBySurface: Record<PublishedExecutionSurface, number> = {
    'web-app-action': 0,
    'workflow-endpoint': 0,
  };
  let capacityExceeded = false;
  let draining = false;
  let observeOverCapacity = false;
  let reportedDraining = false;

  const report = (event: PublishedExecutionAdmissionEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Reporting must never alter admission or permit cleanup.
    }
  };

  const snapshot = (): PublishedExecutionAdmissionSnapshot =>
    Object.freeze({
      ...config,
      activeRuns,
      activeRunsBySurface: Object.freeze({ ...activeRunsBySurface }),
      draining,
    });

  const reportDecision = (decision: PublishedExecutionAdmissionDecision): void => {
    try {
      options.onDecision?.(decision);
    } catch {
      // Reporting must never alter admission or permit cleanup.
    }
  };

  const reportSnapshot = (): void => {
    try {
      options.onSnapshot?.(snapshot());
    } catch {
      // Reporting must never alter admission or permit cleanup.
    }
  };

  reportSnapshot();

  return {
    acquire(surface) {
      if (draining) {
        if (!reportedDraining) {
          reportedDraining = true;
          report({
            activeRuns,
            maxActiveRuns: config.maxActiveRuns,
            mode: config.mode,
            surface,
            type: 'draining',
          });
        }
        reportDecision({ kind: 'draining', surface });
        reportSnapshot();
        return {
          activeRuns,
          kind: 'draining',
          maxActiveRuns: config.maxActiveRuns,
          retryAfterSeconds: config.retryAfterSeconds,
        };
      }

      if (config.mode === 'enforce' && activeRuns >= config.maxActiveRuns) {
        if (!capacityExceeded) {
          capacityExceeded = true;
          report({
            activeRuns,
            maxActiveRuns: config.maxActiveRuns,
            mode: config.mode,
            surface,
            type: 'capacity-exceeded',
          });
        }
        reportDecision({ kind: 'capacity-exceeded', surface });
        reportSnapshot();
        return {
          activeRuns,
          kind: 'capacity-exceeded',
          maxActiveRuns: config.maxActiveRuns,
          retryAfterSeconds: config.retryAfterSeconds,
        };
      }

      if (config.mode === 'disabled') {
        reportDecision({ kind: 'accepted', surface });
        reportSnapshot();
        return { kind: 'accepted', permit: { release() {} } };
      }

      activeRuns += 1;
      activeRunsBySurface[surface] += 1;
      reportDecision({ kind: 'accepted', surface });
      reportSnapshot();
      if (config.mode === 'observe' && activeRuns > config.maxActiveRuns && !observeOverCapacity) {
        observeOverCapacity = true;
        report({
          activeRuns,
          maxActiveRuns: config.maxActiveRuns,
          mode: config.mode,
          surface,
          type: 'observe-over-capacity',
        });
      }

      let released = false;
      return {
        kind: 'accepted',
        permit: {
          release() {
            if (released) return;
            released = true;
            activeRuns = Math.max(0, activeRuns - 1);
            activeRunsBySurface[surface] = Math.max(0, activeRunsBySurface[surface] - 1);
            if (activeRuns < config.maxActiveRuns) capacityExceeded = false;
            reportSnapshot();
            if (activeRuns <= config.maxActiveRuns) observeOverCapacity = false;
          },
        },
      };
    },
    beginDrain() {
      draining = true;
      reportSnapshot();
    },
    getSnapshot() {
      return snapshot();
    },
  };
}

export function getPublishedExecutionAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublishedExecutionAdmissionConfig {
  const rawMode = env[PUBLISHED_EXECUTION_ADMISSION_MODE_ENV]?.trim().toLowerCase();
  const mode = rawMode || 'disabled';
  if (mode !== 'disabled' && mode !== 'observe' && mode !== 'enforce') {
    throw new Error(`${PUBLISHED_EXECUTION_ADMISSION_MODE_ENV} must be disabled, observe, or enforce when set.`);
  }

  const maxActiveRuns = parseIntegerEnv(
    env,
    PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS_ENV,
    mode === 'disabled' ? 1 : undefined,
    1,
    10_000,
  );
  const retryAfterSeconds = parseIntegerEnv(env, PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS_ENV, 1, 1, 3_600);

  return { maxActiveRuns, mode, retryAfterSeconds };
}

export function toPublishedExecutionAdmissionError(
  result: Exclude<PublishedExecutionAdmissionResult, { kind: 'accepted' }>,
): PublishedExecutionAdmissionError {
  return result.kind === 'capacity-exceeded'
    ? new PublishedExecutionAdmissionError(429, 'execution_capacity_exceeded', result.retryAfterSeconds)
    : new PublishedExecutionAdmissionError(503, 'execution_draining', result.retryAfterSeconds);
}

let defaultAdmission: PublishedExecutionAdmission | undefined;

export function getPublishedExecutionAdmission(): PublishedExecutionAdmission {
  defaultAdmission ??= createPublishedExecutionAdmission(getPublishedExecutionAdmissionConfig(), {
    onDecision(decision) {
      getStudioMetrics().recordPublishedExecutionAdmission(
        decision.kind === 'capacity-exceeded' ? 'capacity_exceeded' : decision.kind,
        decision.surface === 'workflow-endpoint' ? 'workflow_endpoint' : 'web_app_action',
      );
    },
    onEvent(event) {
      console.warn(
        `[published-execution-admission] ${event.type}: ${event.activeRuns} active ${event.surface} run(s); ` +
          `per-pod limit ${event.maxActiveRuns} (${event.mode}).`,
      );
    },
    onSnapshot(admissionSnapshot) {
      getStudioMetrics().setPublishedExecutionAdmission(admissionSnapshot);
    },
  });
  return defaultAdmission;
}

function parseIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number | undefined,
  minimum: number,
  maximum: number,
): number {
  const rawValue = env[name]?.trim();
  if (!rawValue) {
    if (defaultValue != null) return defaultValue;
    throw new Error(`${name} is required when ${PUBLISHED_EXECUTION_ADMISSION_MODE_ENV} is not disabled.`);
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateConfig(config: PublishedExecutionAdmissionConfig): void {
  if (config.mode !== 'disabled' && config.mode !== 'observe' && config.mode !== 'enforce') {
    throw new Error('Published execution admission mode must be disabled, observe, or enforce.');
  }
  for (const [name, value, minimum, maximum] of [
    ['maxActiveRuns', config.maxActiveRuns, 1, 10_000],
    ['retryAfterSeconds', config.retryAfterSeconds, 1, 3_600],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `Published execution admission ${name} must be an integer between ${minimum} and ${maximum}.`,
      );
    }
  }
}
