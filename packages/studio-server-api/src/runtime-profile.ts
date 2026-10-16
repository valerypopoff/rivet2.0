import { badRequest } from './utils/httpError.js';

/**
 * Current hosted Evaluations share `control` with the editor. `evaluation`
 * remains an internal, route-free profile for predecessor compatibility only.
 */
export type ApiRuntimeProfile = 'combined' | 'control' | 'evaluation' | 'execution';

const API_RUNTIME_PROFILE_ENV_NAME = 'RIVET_API_PROFILE';

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getApiRuntimeProfile(): ApiRuntimeProfile {
  const rawValue = readEnv(API_RUNTIME_PROFILE_ENV_NAME)?.toLowerCase();
  if (!rawValue) {
    return 'combined';
  }

  if (rawValue === 'combined' || rawValue === 'control' || rawValue === 'execution' || rawValue === 'evaluation') {
    return rawValue;
  }

  throw badRequest(
    `Invalid configuration value "${rawValue}" for ${API_RUNTIME_PROFILE_ENV_NAME}. ` +
      'Expected "combined", "control", "execution", or "evaluation".',
  );
}

export function isExecutionOnlyApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'execution' || profile === 'evaluation';
}

export function isControlPlaneApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'control' || profile === 'combined';
}

/** The public execution profile is the capacity reserved for product traffic. */
export function isPublishedExecutionApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'combined' || profile === 'execution';
}

/**
 * Hosted trials share the control backend's CPU/memory with editor runs.
 * The legacy evaluation profile remains readable for predecessor compatibility;
 * published endpoint capacity must never claim evaluation jobs.
 */
export function isHostedEvaluationWorkerApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'control' || profile === 'combined' || profile === 'evaluation';
}
