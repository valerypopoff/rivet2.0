import { parsePositiveInt } from './utils/env-parsing.js';
import { getApiRuntimeProfile, type ApiRuntimeProfile } from './runtime-profile.js';
import { isManagedWorkflowStorageEnabled } from './routes/workflows/storage-config.js';

export const HOSTED_EVALUATIONS_ENABLED_ENV = 'RIVET_HOSTED_EVALUATIONS_ENABLED';
export const HOSTED_EVALUATIONS_WORKER_CONCURRENCY_ENV = 'RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY';
export const HOSTED_EVALUATIONS_LEASE_MS_ENV = 'RIVET_HOSTED_EVALUATIONS_LEASE_MS';
export const HOSTED_EVALUATIONS_POLL_MS_ENV = 'RIVET_HOSTED_EVALUATIONS_POLL_MS';

export type HostedEvaluationsCoordinatorConfig = Readonly<{
  enabled: boolean;
  workerEnabled: boolean;
  workerConcurrency: number;
  leaseMs: number;
  pollMs: number;
}>;

function readBoolean(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false when set.`);
}

/**
 * The coordinator is deliberately opt-in. It requires managed storage for
 * durable claims and is never allowed to execute jobs on a control-plane pod.
 * A combined local-development process may run workers for parity.
 */
export function getHostedEvaluationsCoordinatorConfig(
  env: NodeJS.ProcessEnv = process.env,
  profile: ApiRuntimeProfile = getApiRuntimeProfile(),
  managedStorageEnabled = isManagedWorkflowStorageEnabled(),
): HostedEvaluationsCoordinatorConfig {
  const enabled = readBoolean(HOSTED_EVALUATIONS_ENABLED_ENV, env);
  if (!enabled) {
    return { enabled: false, workerEnabled: false, workerConcurrency: 0, leaseMs: 0, pollMs: 0 };
  }
  if (!managedStorageEnabled) {
    throw new Error(`${HOSTED_EVALUATIONS_ENABLED_ENV}=true requires managed workflow storage.`);
  }
  const workerConcurrency = Math.min(8, parsePositiveInt(env[HOSTED_EVALUATIONS_WORKER_CONCURRENCY_ENV], 1));
  const leaseMs = Math.max(15_000, Math.min(600_000, parsePositiveInt(env[HOSTED_EVALUATIONS_LEASE_MS_ENV], 60_000)));
  const pollMs = Math.max(250, Math.min(30_000, parsePositiveInt(env[HOSTED_EVALUATIONS_POLL_MS_ENV], 1_000)));
  return {
    enabled: true,
    workerEnabled: profile !== 'control',
    workerConcurrency,
    leaseMs,
    pollMs,
  };
}
